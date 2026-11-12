import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { Client, type ConnectConfig } from "ssh2";
import type { SshHopConfig } from "./types.js";

export interface Tunnel {
  /** Duplex stream connected to the database listener, or undefined for a direct connection. */
  close(): Promise<void>;
}

function normalizeFingerprint(value: string): string {
  return value.trim().replace(/^SHA256:/i, "").replace(/=+$/, "");
}

function verifyHostKey(hash: string, key: Buffer): boolean {
  const actual = createHash("sha256").update(key).digest("base64");
  return normalizeFingerprint(actual) === normalizeFingerprint(hash);
}

function connectHop(hop: SshHopConfig, sock?: Duplex, signal?: AbortSignal): Promise<Client> {
  const config: ConnectConfig = {
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
    hostVerifier:
      hop.hostFingerprint !== undefined
        ? (key: Buffer) => verifyHostKey(hop.hostFingerprint!, key)
        : () => false,
  };

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

function forward(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

/**
 * Builds the SSH chain: hop1 -> hop2 -> ... -> database. Every hop must have a pinned
 * host fingerprint; unpinned hops are rejected instead of silently trusting the key.
 */
export class SshTunnel implements Tunnel {
  private readonly clients: Client[] = [];
  private stream?: Duplex;

  constructor(private readonly hops: SshHopConfig[]) {
    for (const [index, hop] of hops.entries()) {
      if (!hop.hostFingerprint) {
        throw new Error(`SSH hop ${index + 1} (${hop.host}) requires hostFingerprint; refusing to trust an unpinned host key`);
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
    await Promise.all(
      clients.map(
        (client) =>
          new Promise<void>((resolve) => {
            client.once("close", () => resolve());
            client.end();
            setTimeout(resolve, 2_000).unref();
          }),
      ),
    );
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
