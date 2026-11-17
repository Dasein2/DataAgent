import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);

function between(start: string, end: string) {
  const begin = script!.indexOf(start);
  const finish = script!.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin);
  return script!.slice(begin, finish);
}

function harness() {
  const elements: Record<string, any> = {};
  const $ = (id: string) => elements[id] ??= {
    value: "", textContent: "", dataset: {}, disabled: false, open: false, style: {},
    handlers: {} as Record<string, Function>,
    addEventListener(event: string, handler: Function) { this.handlers[event] = handler; },
    click() { this.clicked = true; },
  };
  const state = { selectedProfile: "saved" };
  const context = createContext({
    $, state, Number, defaultPort: () => 5432, syncWeakReadOnly() {},
    // Lives in the host-key block, which this harness deliberately does not evaluate.
    setSshFingerprintStatus() {},
  });
  runInContext(between("// Private-key file import", '$("sslMode").addEventListener'), context);
  return { elements, $, state, context };
}

// Deliberately not a usable credential: validation here only checks the file envelope.
const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS10ZXN0LWtleQ==\n-----END OPENSSH PRIVATE KEY-----\n";
const file = (name = "id_ed25519", text = key) => ({ name, size: text.length, text: async () => text });

async function importFile(context: ReturnType<typeof createContext>, value: unknown) {
  context.file = value;
  await runInContext("importSshKeyFile(file)", context);
}

test("private key file picker supports extensionless keys and keeps paste/passphrase controls", () => {
  assert.match(html, /<input id="sshKeyFile" type="file" hidden/);
  assert.match(html, /id="btnSshKeyFile"/);
  assert.match(html, /id="sshKeyPaste"/);
  assert.match(html, /id="sshPassphrase" type="password"/);
  const { $, context } = harness();
  $("btnSshKeyFile").onclick();
  assert.equal($("sshKeyFile").clicked, true);
  assert.doesNotMatch(between("// Private-key file import", '$("sslMode").addEventListener'), /\bfetch\(|\bapi\(|localStorage|sessionStorage/);
});

test("imports OpenSSH and encrypted PEM keys locally and never shows the key in status text", async () => {
  const { $, state, context } = harness();
  await importFile(context, file());
  assert.equal($("sshKey").value, key);
  assert.equal($("sshKeyFileStatus").textContent, "已载入：id_ed25519");
  assert.equal($("sshKeyFileStatus").dataset.state, "ready");
  assert.equal($("sshKeyPaste").open, false);
  assert.equal($("btnSshKeyClear").disabled, false);
  assert.equal(state.selectedProfile, "saved", "a key is an override, not a profile configuration change");
  assert.equal($("sshKeyFile").value, "", "same file can be selected again");

  const pem = "\uFEFF-----BEGIN ENCRYPTED PRIVATE KEY-----\r\nZW5jcnlwdGVk\r\n-----END ENCRYPTED PRIVATE KEY-----\r\n";
  await importFile(context, file("encrypted.pem", pem));
  assert.equal($("sshKey").value, pem.replace(/^\uFEFF/, "").trim() + "\n");
  assert.equal($("sshKeyFileStatus").textContent, "已载入：encrypted.pem");
});

test("rejects public, PuTTY, empty, oversized and unreadable files without replacing a working key", async () => {
  const { $, context } = harness();
  await importFile(context, file());
  const invalid = [
    { value: file("id_ed25519.pub", "ssh-ed25519 AAAATEST user@host"), message: /不是 .pub 公钥/ },
    { value: file("key.ppk", "PuTTY-User-Key-File-3: ssh-ed25519"), message: /PuTTYgen/ },
    { value: file("empty", ""), message: /文件为空/ },
    { value: { ...file(), size: 65537 }, message: /64 KB/ },
    { value: { ...file(), text: async () => { throw new Error("sensitive I/O details"); } }, message: /无法读取/ },
    { value: file("mismatch", key.replace("END OPENSSH", "END RSA")), message: /请选择 OpenSSH/ },
  ];
  for (const { value, message } of invalid) {
    await importFile(context, value);
    assert.equal($("sshKey").value, key);
    assert.equal($("sshKeyFileStatus").dataset.state, "error");
    assert.match($("sshKeyFileStatus").textContent, message);
    assert.match($("sshKeyFileStatus").textContent, /仍保留原私钥/);
    assert.doesNotMatch($("sshKeyFileStatus").textContent, /ZmFrZS|sensitive I\/O/);
  }
  const status = $("sshKeyFileStatus").textContent;
  await importFile(context, undefined);
  assert.equal($("sshKeyFileStatus").textContent, status, "cancel keeps the current selection");
});

test("clear, manual edits, profile switches and newer imports invalidate pending reads", async () => {
  const { $, context } = harness();
  let resolve!: (text: string) => void;
  const pendingFile = { ...file(), text: () => new Promise<string>((r) => { resolve = r; }) };
  context.file = pendingFile;
  const pending = runInContext("importSshKeyFile(file)", context);
  assert.equal($("btnSshKeyClear").disabled, false, "clear can cancel an in-flight read");
  $("sshPassphrase").value = "secret";
  $("btnSshKeyClear").onclick();
  resolve(key);
  await pending;
  assert.equal($("sshKey").value, "");
  assert.equal($("sshPassphrase").value, "");
  assert.equal($("btnSshKeyClear").disabled, true);

  context.file = pendingFile;
  const stale = runInContext("importSshKeyFile(file)", context);
  await importFile(context, file("new.pem", key.replaceAll("OPENSSH ", "RSA ")));
  resolve(key);
  await stale;
  assert.match($("sshKey").value, /BEGIN RSA/);
  assert.equal($("sshKeyFileStatus").textContent, "已载入：new.pem");

  $("sshKey").value = "pasted key";
  $("sshKey").handlers.input();
  assert.equal($("sshKeyFileStatus").textContent, "已填写私钥内容");
  assert.equal($("btnSshKeyClear").disabled, false);

  $("engine").options = [{ value: "postgres" }];
  $("weakReadOnlyWrap").style.display = "none";
  runInContext(between("function applyProfile(", "function missingSecrets("), context);
  context.profile = { name: "other", engine: "postgres", ssh: { hops: [{ auth: { method: "privateKey" } }] }, hasSecret: true };
  runInContext("applyProfile(profile)", context);
  assert.equal($("sshKey").value, "");
  assert.equal($("btnSshKeyClear").disabled, true);
  assert.match($("sshKeyFileStatus").textContent, /服务端已保存/);
});

test("file contents enter the existing connection credentials path, and loading blocks premature submission", async () => {
  const { $, context } = harness();
  runInContext(between("function connectionPayload(", "function saveToken("), context);
  $("engine").value = "postgres";
  $("sslMode").value = "";
  $("sshHost").value = "bastion.test";
  $("sshAuth").value = "privateKey";
  $("sshPassphrase").value = "passphrase";
  await importFile(context, file());
  const payload = runInContext("connectionPayload()", context);
  assert.equal(payload.ssh.hops[0].auth.privateKey, key);
  assert.equal(payload.ssh.hops[0].auth.passphrase, "passphrase");
  assert.equal(payload.ssh.hops[0].auth.method, "privateKey");
  runInContext("sshKeyFileReading = true", context);
  assert.throws(() => runInContext("connectionPayload()", context), /正在读取/);
});
