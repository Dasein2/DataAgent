import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { Client, type ConnectConfig } from "ssh2";
import { AppError } from "../errors.js";
import type { SshHopConfig } from "./types.js";

export interface Tunnel {
  /** Duplex stream connected to the database listener, or undefined for a direct connection. */
  close(): Promise<void>;
}

/**
 * A host key the server presented, described the way `ssh-keygen -l` prints it. Returned by
 * `probeHostKeys()` so a console can show it and the operator can pin it deliberately.
 */
export interface HostKeyObservation {
  /** Position in the configured chain, 0-based. */
  index: number;
  host: string;
  port: number;
  /** Key type as it appears on the wire, e.g. `ssh-ed25519`. */
  algorithm: string;
  /** OpenSSH spelling, e.g. `SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU`. */
  fingerprint: string;
}

function base64Sha256(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64");
}

/** Accepts `SHA256:…` with or without the prefix and trailing `=` padding. */
export function normalizeHostKeyFingerprint(value: string): string {
  return value.trim().replace(/^SHA256:/i, "").replace(/=+$/, "");
}

function normalizeFingerprint(value: string): string {
  return normalizeHostKeyFingerprint(value);
}

/** OpenSSH's `SHA256:…` spelling of a raw host key blob (base64 without the `=` padding). */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${base64Sha256(key).replace(/=+$/, "")}`;
}

/** The blob opens with an SSH string holding the key type name. */
export function hostKeyAlgorithm(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  if (length === 0 || length > 64 || length + 4 > key.length) return "unknown";
  return key.subarray(4, 4 + length).toString("latin1");
}

function matchesFingerprint(expected: string, key: Buffer): boolean {
  return normalizeFingerprint(expected) === normalizeFingerprint(base64Sha256(key));
}

function hopConfig(
  hop: SshHopConfig,
  sock: Duplex | undefined,
  hostVerifier: NonNullable<ConnectConfig["hostVerifier"]>,
): ConnectConfig {
  return {
    host: hop.host,
    port: hop.port,
    username: hop.username,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    ...(sock ? { sock: sock as never } : {}),
    ...(hop.auth.method === "password"
      ? { password: hop.auth.password }
      : { privateKey: hop.auth.privateKey, passphrase: hop.auth.passphrase }),
    hostVerifier,
  };
}

function connectHop(hop: SshHopConfig, sock?: Duplex, signal?: AbortSignal): Promise<Client> {
  // Kept so a refused key can be reported with both fingerprints instead of "denied".
  let presented: Buffer | undefined;
  const config = hopConfig(hop, sock, (key: Buffer) => {
    presented = key;
    return hop.hostFingerprint !== undefined && matchesFingerprint(hop.hostFingerprint, key);
  });

  return new Promise((resolve, reject) => {
    const client = new Client();
    const onAbort = () => {
      client.end();
      reject(new Error("SSH connection aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    client.once("ready", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(client);
    });
    client.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      if (presented && hop.hostFingerprint && !matchesFingerprint(hop.hostFingerprint, presented)) {
        // The one case that must never be reduced to a retry: the host key changed under us.
        reject(
          new AppError(
            "SSH_HOST_KEY_MISMATCH",
            `Host key of SSH hop ${hop.host} changed: this connection expects ${hop.hostFingerprint}, ` +
              `the server presented ${hostKeyFingerprint(presented)}. Verify the server before repinning.`,
            { host: hop.host, port: hop.port, expected: hop.hostFingerprint, actual: hostKeyFingerprint(presented) },
          ),
        );
        return;
      }
      reject(error);
    });
    try {
      client.connect(config);
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

/**
 * Reads a hop's host key without logging in: the handshake presents the key before authentication,
 * so the verifier records it and then refuses, which ends the connection before any credential is
 * offered.
 */
function observeHostKey(hop: SshHopConfig, sock?: Duplex, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let presented: Buffer | undefined;
    const config = hopConfig(hop, sock, (key: Buffer) => {
      presented = key;
      return false;
    });
    const onAbort = () => {
      client.end();
      reject(new AppError("CONNECTION_FAILED", "SSH connection aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    client.once("ready", () => {
      // Unreachable: the verifier above refuses every key.
      signal?.removeEventListener("abort", onAbort);
      client.end();
      reject(new AppError("CONNECTION_FAILED", `SSH hop ${hop.host} did not present a host key`));
    });
    client.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      client.end();
      if (presented) resolve(presented);
      else reject(error);
    });
    try {
      client.connect(config);
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

function forward(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function closeClient(client: Client): Promise<void> {
  return new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    client.end();
    setTimeout(resolve, 2_000).unref();
  });
}

/**
 * Finds the first hop whose key is not pinned yet and reports what the server presents, so a
 * console can show it, ask the operator, and only then pin it. Hops that are already pinned are
 * still verified — a changed key surfaces here, before any query runs.
 *
 * `observe` reads the *first* hop as it presents itself and ignores its pin, which is the only way
 * to re-pin after a deliberate rebuild: connections stay strict, this read is explicit.
 *
 * Returns null when every hop is pinned and verified (or when there is no SSH chain).
 */
export async function probeHostKeys(
  hops: SshHopConfig[],
  signal?: AbortSignal,
  options: { observe?: boolean } = {},
): Promise<HostKeyObservation | null> {
  if (options.observe && hops[0]) {
    const first = hops[0];
    const key = await observeHostKey(first, undefined, signal);
    return {
      index: 0,
      host: first.host,
      port: first.port,
      algorithm: hostKeyAlgorithm(key),
      fingerprint: hostKeyFingerprint(key),
    };
  }
  const clients: Client[] = [];
  let sock: Duplex | undefined;
  try {
    for (const [index, hop] of hops.entries()) {
      if (!hop.hostFingerprint) {
        const key = await observeHostKey(hop, sock, signal);
        return { index, host: hop.host, port: hop.port, algorithm: hostKeyAlgorithm(key), fingerprint: hostKeyFingerprint(key) };
      }
      const client = await connectHop(hop, sock, signal);
      clients.push(client);
      client.on("error", () => {
        /* reported by the next step that needs this hop */
      });
      const next = hops[index + 1];
      if (next) sock = await forward(client, next.host, next.port);
    }
    return null;
  } finally {
    sock?.destroy();
    await Promise.all(clients.map(closeClient)).catch(() => undefined);
  }
}

/**
 * Builds the SSH chain: hop1 -> hop2 -> ... -> database. Every hop must have a pinned host
 * fingerprint; a hop without one is refused here so the caller has to probe and confirm it first,
 * exactly like the first `yes` OpenSSH asks for.
 */
export class SshTunnel implements Tunnel {
  private readonly clients: Client[] = [];
  private stream?: Duplex;

  constructor(private readonly hops: SshHopConfig[]) {
    for (const [index, hop] of hops.entries()) {
      if (!hop.hostFingerprint) {
        throw new AppError(
          "SSH_HOST_KEY_UNPINNED",
          `SSH hop ${index + 1} (${hop.host}) has no confirmed host key. ` +
            "Read the fingerprint with POST /v1/connections/host-key and pin it after checking it.",
          { host: hop.host, port: hop.port, index },
        );
      }
    }
  }

  async open(target: { host: string; port: number }, signal?: AbortSignal): Promise<Duplex> {
    let sock: Duplex | undefined;
    for (const [index, hop] of this.hops.entries()) {
      const client = await connectHop(hop, sock, signal);
      this.clients.push(client);
      client.on("error", () => {
        /* handled by health checks and query errors */
      });
      const next = this.hops[index + 1];
      if (next) {
        // The next hop is reached through the current one.
        sock = await forward(client, next.host, next.port);
      }
    }
    const last = this.clients[this.clients.length - 1];
    if (!last) throw new Error("no SSH hops configured");
    this.stream = await forward(last, target.host, target.port);
    return this.stream;
  }

  /** Opens an additional forwarded stream over the existing SSH chain (used for cancellation). */
  async dial(target: { host: string; port: number }): Promise<Duplex> {
    const last = this.clients[this.clients.length - 1];
    if (!last) throw new Error("SSH tunnel is not open");
    return forward(last, target.host, target.port);
  }

  async close(): Promise<void> {
    this.stream?.destroy();
    this.stream = undefined;
    const clients = this.clients.splice(0);
    await Promise.all(clients.map(closeClient));
  }
}

export async function openTunnel(
  hops: SshHopConfig[],
  target: { host: string; port: number },
  signal?: AbortSignal,
): Promise<Tunnel> {
  const tunnel = new SshTunnel(hops);
  await tunnel.open(target, signal);
  return tunnel;
}
