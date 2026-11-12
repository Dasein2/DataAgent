import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "../../errors.js";
import type { ConnectionConfig } from "../types.js";
import type { Engine } from "./base.js";
import { DorisEngine, MysqlEngine, StarrocksEngine } from "./mysql.js";
import { PostgresEngine } from "./postgres.js";
import { getProfile } from "./profiles.js";

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr(address: string, base: string, bits: number): boolean {
  if (isIP(address) !== 4) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return (
      inCidr(address, "10.0.0.0", 8) ||
      inCidr(address, "172.16.0.0", 12) ||
      inCidr(address, "192.168.0.0", 16) ||
      inCidr(address, "127.0.0.0", 8) ||
      inCidr(address, "169.254.0.0", 16) ||
      inCidr(address, "0.0.0.0", 8) ||
      inCidr(address, "100.64.0.0", 10)
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

const METADATA_ADDRESSES = new Set(["169.254.169.254", "fd00:ec2::254", "100.100.100.200"]);

async function resolveAll(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

/**
 * Blocks cloud metadata endpoints always, and private ranges unless explicitly allowed.
 * The resolved address is what matters, so DNS names are checked after resolution.
 */
export async function assertTargetAllowed(host: string, allowPrivateNetwork: boolean): Promise<void> {
  const addresses = await resolveAll(host);
  if (addresses.length === 0) {
    throw new AppError("CONNECTION_FAILED", `Cannot resolve host "${host}"`);
  }
  for (const address of addresses) {
    if (METADATA_ADDRESSES.has(address)) {
      throw new AppError("CONNECTION_TARGET_BLOCKED", `Connecting to metadata address ${address} is blocked`);
    }
    if (!allowPrivateNetwork && isPrivateAddress(address)) {
      throw new AppError(
        "CONNECTION_TARGET_BLOCKED",
        `Connecting to private address ${address} is blocked; set DATA_AGENT_ALLOW_PRIVATE_NETWORK=true for self-hosted databases`,
      );
    }
  }
}

export function createEngine(
  config: ConnectionConfig,
  options: { allowPrivateNetwork: boolean; applicationName: string },
): Engine {
  // The implementation follows the declared protocol; engine-specific behaviour (read-only proof,
  // explain, indexes, cancellation, workspace mode) comes from the profile, not from this branch.
  const profile = getProfile(config.engine);
  let engine: Engine;
  if (profile.protocol === "pg") {
    engine = new PostgresEngine(config, options);
  } else if (config.engine === "doris") {
    engine = new DorisEngine(config);
  } else if (config.engine === "starrocks") {
    engine = new StarrocksEngine(config);
  } else {
    engine = new MysqlEngine(config);
  }
  const connect = engine.connect.bind(engine);
  engine.connect = async () => {
    await assertTargetAllowed(config.host, options.allowPrivateNetwork);
    for (const hop of config.ssh?.hops ?? []) {
      await assertTargetAllowed(hop.host, options.allowPrivateNetwork);
    }
    await connect();
  };
  return engine;
}

export { PostgresEngine, MysqlEngine, DorisEngine, StarrocksEngine };
export type { Engine };
