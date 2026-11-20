import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { createContext, runInContext } from "node:vm";
import { readFile } from "node:fs/promises";
import ssh2 from "ssh2";
import { AnalysisService } from "../src/agent/service.js";
import { createHttpApp } from "../src/api/http.js";
import { AppError } from "../src/errors.js";
import { ConnectionConfig } from "../src/db/types.js";
import { SshTunnel, hostKeyAlgorithm, hostKeyFingerprint, probeHostKeys } from "../src/db/ssh-tunnel.js";
import { cleanup, testConfig } from "./support.js";

const { Server: SshServer, utils } = ssh2;

/**
 * A throwaway bastion on 127.0.0.1. It accepts one password so a probe can complete the handshake
 * and log in, which is what "the key is already pinned" looks like from the client side.
 */
async function startBastion(password = "jump-secret") {
  let hostKey = utils.generateKeyPairSync("ed25519").private;
  // ssh2 occasionally generates OpenSSH keys its own parser rejects (observed on Node 24).
  for (let retry = 0; retry < 4 && utils.parseKey(hostKey) instanceof Error; retry++) {
    hostKey = utils.generateKeyPairSync("ed25519").private;
  }
  const live = new Set<any>();
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    live.add(client);
    client.on("close", () => live.delete(client));
    client.on("error", () => undefined);
    client.on("authentication", (context: any) => {
      if (context.method === "password" && context.password === password) context.accept();
      else context.reject();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: async () => {
      for (const client of live) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const hopAt = (port: number, extra: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port,
  username: "jump",
  auth: { method: "password" as const, password: "jump-secret" },
  ...extra,
});

test("an unpinned hop is read without any credential and described like ssh-keygen", async () => {
  const bastion = await startBastion();
  try {
    const observation = await probeHostKeys([hopAt(bastion.port)]);
    assert.ok(observation, "the unpinned hop must be reported");
    assert.equal(observation.index, 0);
    assert.equal(observation.host, "127.0.0.1");
    assert.equal(observation.port, bastion.port);
    assert.equal(observation.algorithm, "ssh-ed25519");
    // OpenSSH prints base64 without padding: SHA256: + 43 characters.
    assert.match(observation.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);

    // A wrong password must not matter: the key is presented before authentication.
    const refused = await probeHostKeys([hopAt(bastion.port, { auth: { method: "password", password: "wrong" } })]);
    assert.equal(refused?.fingerprint, observation.fingerprint);
  } finally {
    await bastion.close();
  }
});

test("a pinned hop is verified instead of probed, and a changed key is refused", async () => {
  const bastion = await startBastion();
  try {
    const pinned = await probeHostKeys([hopAt(bastion.port)]);
    assert.ok(pinned);
    // Nothing left to confirm: the hop is pinned and the handshake still matches.
    assert.equal(await probeHostKeys([hopAt(bastion.port, { hostFingerprint: pinned.fingerprint })]), null);

    const changed = pinned.fingerprint.slice(0, -1) + (pinned.fingerprint.endsWith("A") ? "B" : "A");
    const error = await probeHostKeys([hopAt(bastion.port, { hostFingerprint: changed })]).then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "SSH_HOST_KEY_MISMATCH");
    assert.equal(error.status, 409);
    assert.equal(error.details?.actual, pinned.fingerprint);
    assert.equal(error.details?.expected, changed);
    assert.match(error.message, /changed/);
  } finally {
    await bastion.close();
  }
});

test("a tunnel refuses an unpinned hop instead of trusting it silently", async () => {
  assert.throws(
    () => new SshTunnel([hopAt(22)] as never),
    (error: unknown) => error instanceof AppError && error.code === "SSH_HOST_KEY_UNPINNED" && error.status === 400,
  );
});

test("host key helpers accept padded and prefixed fingerprints", () => {
  const key = Buffer.from("fixture-key");
  const fingerprint = hostKeyFingerprint(key);
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(hostKeyAlgorithm(Buffer.from([0, 0, 0, 3, 0x61, 0x62, 0x63])), "abc");
  assert.equal(hostKeyAlgorithm(Buffer.alloc(2)), "unknown");
  assert.equal(hostKeyAlgorithm(Buffer.from([0, 0, 0, 9, 1, 2])), "unknown");
});

test("the API reads a jump host key, pins it only after confirmation and keeps saved secrets", async () => {
  const config = await testConfig();
  config.profileSecretKey = "fixture-profile-key";
  const bastion = await startBastion();
  let service: AnalysisService | undefined;
  let http: Server | undefined;
  try {
    service = await AnalysisService.create(config);
    const web = await createHttpApp(service);
    http = createServer(web);
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(origin + path, {
        method,
        headers: { "content-type": "application/json", authorization: "Bearer test-token", "x-caller-id": "alice" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    };

    const connection = {
      engine: "postgres",
      host: "db.internal",
      port: 5432,
      database: "analytics",
      user: "analyst",
      password: "db-secret",
      environment: "non_production",
      ssh: { hops: [{ host: "127.0.0.1", port: bastion.port, username: "jump", auth: { method: "password", password: "jump-secret" } }] },
    };
    // Persisted inside the profile, so pinning must never drop it.
    const saved = await call("/v1/connections/profiles/bastioned", "PUT", {
      connection, rememberSecret: true,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.profile.hasSecret, true);

    const bare = await call("/v1/connections/host-key", "POST", {
      connection: { ...connection, ssh: undefined },
    });
    assert.deepEqual(bare.body, { status: "direct" });

    const probe = await call("/v1/connections/host-key", "POST", { profile: "bastioned", credentials: {} });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.status, "unverified");
    const fingerprint: string = probe.body.hop.fingerprint;
    assert.equal(probe.body.hop.algorithm, "ssh-ed25519");

    // Confirming with a fingerprint the server does not present pins nothing.
    const stale = await call("/v1/connections/host-key", "POST", {
      profile: "bastioned", credentials: {}, pin: "SHA256:" + "A".repeat(43),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "SSH_HOST_KEY_MISMATCH");
    assert.equal(JSON.stringify(service.profiles.reveal("alice", "bastioned")).includes("hostFingerprint"), false);

    const pinned = await call("/v1/connections/host-key", "POST", {
      profile: "bastioned", credentials: {}, pin: fingerprint,
    });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.body.status, "pinned");
    const stored = service.profiles.reveal("alice", "bastioned") as any;
    assert.equal(stored.ssh.hops[0].hostFingerprint, fingerprint);
    assert.equal(stored.ssh.hops[0].auth.password, "jump-secret", "pinning must not disturb saved secrets");
    assert.equal(stored.password, "db-secret");

    const again = await call("/v1/connections/host-key", "POST", { profile: "bastioned", credentials: {} });
    assert.deepEqual([again.status, again.body.status], [200, "verified"]);

    // An explicit re-read reports the live key even though it is already pinned.
    const reread = await call("/v1/connections/host-key", "POST", { profile: "bastioned", credentials: {}, observe: true });
    assert.deepEqual([reread.status, reread.body.status, reread.body.changed], [200, "unverified", false]);
    assert.equal(reread.body.hop.fingerprint, fingerprint);

    // The stored profile is what a session would use, so the pinned key is now in force.
    assert.equal(
      ConnectionConfig.parse(service.profiles.reveal("alice", "bastioned")).ssh?.hops[0]?.hostFingerprint,
      fingerprint,
    );

    // A rebuilt jump host: same profile, a different server key on the new port.
    const rebuilt = await startBastion();
    try {
      const moved = await call("/v1/connections/profiles/bastioned", "PUT", {
        connection: {
          ...connection,
          ssh: { hops: [{ ...connection.ssh.hops[0], port: rebuilt.port, hostFingerprint: fingerprint }] },
        },
        rememberSecret: true,
      });
      assert.equal(moved.status, 200);

      // A normal read refuses the changed key instead of quietly adopting it.
      const refused = await call("/v1/connections/host-key", "POST", { profile: "bastioned", credentials: {} });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "SSH_HOST_KEY_MISMATCH");

      const changed = await call("/v1/connections/host-key", "POST", { profile: "bastioned", credentials: {}, observe: true });
      assert.deepEqual([changed.status, changed.body.changed], [200, true]);
      assert.equal(changed.body.previous, fingerprint);
      const replacement: string = changed.body.hop.fingerprint;
      assert.notEqual(replacement, fingerprint);

      // Confirming the new key replaces the old one; this is the only path that can do that.
      const repinned = await call("/v1/connections/host-key", "POST", {
        profile: "bastioned", credentials: {}, pin: replacement,
      });
      assert.equal(repinned.status, 200);
      assert.equal((service.profiles.reveal("alice", "bastioned") as any).ssh.hops[0].hostFingerprint, replacement);
      const verified = await call("/v1/connections/host-key", "POST", { profile: "bastioned", credentials: {} });
      assert.equal(verified.body.status, "verified");
    } finally {
      await rebuilt.close();
    }
  } finally {
    http?.closeAllConnections();
    if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
    await service?.shutdown();
    await bastion.close();
    await cleanup(config);
  }
});

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);

function between(start: string, end: string) {
  const begin = script!.indexOf(start);
  const finish = script!.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, `missing marker ${start}`);
  return script!.slice(begin, finish);
}

function harness() {
  const elements: Record<string, any> = {};
  const $ = (id: string) => (elements[id] ??= {
    value: "", textContent: "", dataset: {}, hidden: false, disabled: false, open: false, style: {},
    handlers: {} as Record<string, Function>,
    addEventListener(event: string, handler: Function) { this.handlers[event] = handler; },
    focus() { this.focused = true; },
  });
  const requests: any[] = [];
  const state = { selectedProfile: null as string | null };
  const context = createContext({
    $, state, Number,
    api: async (path: string, options: any) => { requests.push({ path, body: options.body }); return state.reply; },
    connectionRequest: () => ({ connection: { host: "db.internal" } }),
    readProfiles: () => [],
    saveToken() {},
  });
  (state as any).reply = null;
  runInContext(between("// ── host key confirmation", '$("sshAuth").addEventListener'), context);
  return { elements, $, state, context, requests };
}

test("the console asks for the fingerprint before it connects and never pins on its own", async () => {
  assert.match(html, /id="btnSshFingerprint"/);
  assert.match(html, /id="sshTrust" hidden/);
  assert.match(html, /id="sshTrustFingerprint"/);
  // The old wording implied the value had to be known in advance.
  assert.equal(/主机密钥指纹（SHA256，生产必填）/.test(html), false);
  assert.match(script!, /if \(!\(await ensureHostFingerprint\(\)\)\) throw new Error/);

  const { $, state, context } = harness();
  ($("sshHost") as any).value = "127.0.0.1";
  (state as any).reply = {
    status: "unverified",
    hop: { host: "127.0.0.1", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" },
  };

  // Declining the dialog must leave the form unpinned and stop the caller.
  const declined = runInContext("ensureHostFingerprint()", context) as Promise<boolean>;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal($("sshTrust").hidden, false);
  assert.equal($("sshTrustFingerprint").textContent, "SHA256:fixture");
  runInContext("closeSshTrust(false)", context);
  assert.equal(await declined, false);
  assert.equal($("sshFingerprint").value, "");
  assert.equal($("sshTrust").hidden, true);

  // Accepting the dialog pins through the API and fills the field with the confirmed value.
  ($("sshFingerprint") as any).value = "";
  (state as any).reply = { status: "unverified", hop: { host: "127.0.0.1", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" } };
  const accepted = runInContext("ensureHostFingerprint()", context) as Promise<boolean>;
  await new Promise((resolve) => setImmediate(resolve));
  (state as any).reply = { status: "pinned", hop: { host: "127.0.0.1", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" } };
  runInContext("closeSshTrust(true)", context);
  assert.equal(await accepted, true);
  assert.equal($("sshFingerprint").value, "SHA256:fixture");
  assert.equal($("sshFingerprintStatus").dataset.state, "ready");
});

test("an already pinned profile is connected without asking again", async () => {
  const { $, state, context, requests } = harness();
  (state as any).reply = { status: "unverified", hop: { host: "127.0.0.1", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" } };
  assert.equal(await runInContext("ensureHostFingerprint()", context), true);
  assert.equal(requests.length, 0, "no hop configured in the form and no profile means nothing to confirm");

  ($("sshHost") as any).value = "127.0.0.1";
  ($("sshFingerprint") as any).value = "SHA256:already";
  assert.equal(await runInContext("ensureHostFingerprint()", context), true);
  assert.equal(requests.length, 0, "a pinned fingerprint is never re-read");
});

test("获取指纹 re-reads a pinned host and warns before replacing its key", async () => {
  const { $, state, context, requests } = harness();
  ($("sshHost") as any).value = "127.0.0.1";
  ($("sshFingerprint") as any).value = "SHA256:old";

  // Unchanged key: re-reading confirms it without asking again.
  (state as any).reply = {
    status: "unverified", changed: false, previous: "SHA256:old",
    hop: { host: "127.0.0.1", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:old" },
  };
  assert.equal(await runInContext("ensureHostFingerprint({ recheck: true })", context), true);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), {
    path: "/v1/connections/host-key",
    body: { connection: { host: "db.internal" }, observe: true },
  });
  assert.equal(requests.length, 1, "an unchanged key is not pinned a second time");
  assert.equal($("sshFingerprintStatus").dataset.state, "ready");
  assert.match($("sshFingerprintStatus").textContent, /指纹未变/);

  (state as any).reply = {
    status: "unverified", changed: true, previous: "SHA256:old",
    hop: { host: "127.0.0.1", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:new" },
  };

  const pending = runInContext("ensureHostFingerprint({ recheck: true })", context) as Promise<boolean>;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal($("sshTrustWarning").hidden, false);
  assert.equal($("sshTrustStored").textContent, "SHA256:old");
  assert.equal($("sshTrustFingerprint").textContent, "SHA256:new");
  assert.equal($("sshFingerprintStatus").dataset.state, "error");

  // Declining keeps the old pin and says so.
  runInContext("closeSshTrust(false)", context);
  assert.equal(await pending, false);
  assert.equal($("sshFingerprint").value, "SHA256:old");
  assert.match($("sshFingerprintStatus").textContent, /仍使用原指纹/);

  // Confirming replaces it.
  const retry = runInContext("ensureHostFingerprint({ recheck: true })", context) as Promise<boolean>;
  await new Promise((resolve) => setImmediate(resolve));
  (state as any).reply = { status: "pinned", hop: { host: "127.0.0.1", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:new" } };
  runInContext("closeSshTrust(true)", context);
  assert.equal(await retry, true);
  assert.equal($("sshFingerprint").value, "SHA256:new");
  assert.equal($("sshTrustWarning").hidden, true);
});
