import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ConnectionConfig } from "./types.js";

/**
 * Saved connection profiles live on the service, not in a browser, so the console and any API
 * caller share the same set.
 *
 * Secrets are the one thing the rest of the service never persists (credentials are held in memory
 * per session). A profile may opt in to keeping them, and only when DATA_AGENT_PROFILE_SECRET_KEY
 * is set: they are then encrypted with AES-256-GCM under a key derived from that value. Without the
 * key the store refuses the write instead of silently dropping the secret.
 */
export const PROFILE_NAME = /^[A-Za-z0-9._:-]{1,60}$/;

export const SaveProfileRequest = z.object({
  connection: ConnectionConfig,
  /** Keep password / SSH credentials with the profile. Requires DATA_AGENT_PROFILE_SECRET_KEY. */
  rememberSecret: z.boolean().optional().default(false),
});
export type SaveProfileRequest = z.infer<typeof SaveProfileRequest>;

/** What the API returns: never includes secrets, only whether some are stored. */
export interface ProfileView {
  name: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  updatedAt: string;
}

interface Secrets {
  password?: string;
  ssh?: Array<{ password?: string; privateKey?: string; passphrase?: string }>;
}

interface StoredProfile {
  name: string;
  owner: string;
  config: Record<string, unknown>;
  /** `v1:<iv>:<tag>:<ciphertext>`, base64 segments. */
  secret?: string;
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  profiles: StoredProfile[];
}

/** Connection fields that are credentials; everything else is safe to keep in clear text. */
function splitSecrets(connection: ConnectionConfig): { config: Record<string, unknown>; secrets: Secrets } {
  const config: Record<string, unknown> = structuredClone(connection);
  const secrets: Secrets = {};
  if (config.password) secrets.password = String(config.password);
  delete config.password;

  if (connection.ssh) {
    const hops = connection.ssh.hops.map((hop, index) => {
      const copy = { ...hop, auth: { ...hop.auth } as Record<string, unknown> };
      const stored: NonNullable<Secrets["ssh"]>[number] = {};
      if ("password" in hop.auth && hop.auth.password) stored.password = hop.auth.password;
      if ("privateKey" in hop.auth && hop.auth.privateKey) stored.privateKey = hop.auth.privateKey;
      if ("passphrase" in hop.auth && hop.auth.passphrase) stored.passphrase = hop.auth.passphrase;
      delete copy.auth.password;
      delete copy.auth.privateKey;
      delete copy.auth.passphrase;
      if (Object.keys(stored).length > 0) {
        secrets.ssh = secrets.ssh ?? [];
        secrets.ssh[index] = stored;
      }
      return copy;
    });
    config.ssh = { hops };
  }
  return { config, secrets };
}

function mergeSecrets(config: Record<string, unknown>, secrets: Secrets | undefined): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...structuredClone(config), password: secrets?.password ?? "" };
  const ssh = merged.ssh as { hops?: Array<Record<string, unknown>> } | undefined;
  if (ssh?.hops && secrets?.ssh) {
    merged.ssh = {
      hops: ssh.hops.map((hop, index) => {
        const stored = secrets.ssh?.[index];
        if (!stored) return hop;
        const auth = { ...(hop.auth as Record<string, unknown>) };
        if (stored.password) auth.password = stored.password;
        if (stored.privateKey) auth.privateKey = stored.privateKey;
        if (stored.passphrase) auth.passphrase = stored.passphrase;
        return { ...hop, auth };
      }),
    };
  }
  return merged;
}

function hasSecrets(secrets: Secrets | undefined): boolean {
  if (!secrets) return false;
  if (secrets.password) return true;
  return (secrets.ssh ?? []).some((entry) => entry && (entry.password || entry.privateKey || entry.passphrase));
}

export class ProfileStore {
  private readonly key?: Buffer;
  private profiles: StoredProfile[] = [];

  constructor(
    private readonly file: string,
    secretKey?: string,
    private readonly max = 50,
  ) {
    if (secretKey) this.key = scryptSync(secretKey, "data-agent-connections-v1", 32);
    this.load();
  }

  /** Whether this deployment can keep profile secrets at all. */
  get secretStorageEnabled(): boolean {
    return this.key !== undefined;
  }

  list(owner: string): ProfileView[] {
    return this.profiles
      .filter((profile) => profile.owner === owner)
      .map((profile) => this.view(profile))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(owner: string, name: string): ProfileView | undefined {
    const profile = this.find(owner, name);
    return profile ? this.view(profile) : undefined;
  }

  /**
   * Creates or replaces a profile. Passing `rememberSecret` without a configured key is refused:
   * silently discarding the secret would leave a profile that looks complete but cannot connect.
   */
  save(owner: string, name: string, connection: ConnectionConfig, rememberSecret: boolean): ProfileView {
    if (!PROFILE_NAME.test(name)) {
      throw new AppError("PROFILE_NAME_INVALID", 'Profile name must match [A-Za-z0-9._:-]{1,60}');
    }
    const { config, secrets } = splitSecrets(connection);
    const keepSecret = rememberSecret && hasSecrets(secrets);
    if (keepSecret && !this.key) {
      throw new AppError(
        "PROFILE_SECRET_STORAGE_DISABLED",
        "This deployment cannot store profile secrets: set DATA_AGENT_PROFILE_SECRET_KEY and restart, " +
          "or save the profile without the password.",
      );
    }

    const existing = this.find(owner, name);
    if (!existing && this.profiles.filter((profile) => profile.owner === owner).length >= this.max) {
      throw new AppError(
        "PROFILE_LIMIT_REACHED",
        `This caller already holds ${this.max} saved connection profiles; delete one first`,
      );
    }

    const record: StoredProfile = {
      name,
      owner,
      config,
      updatedAt: new Date().toISOString(),
    };
    const secret = keepSecret ? this.encrypt(JSON.stringify(secrets)) : undefined;
    if (secret) record.secret = secret;

    if (existing) this.profiles[this.profiles.indexOf(existing)] = record;
    else this.profiles.push(record);
    this.persist();
    return this.view(record);
  }

  remove(owner: string, name: string): void {
    const profile = this.find(owner, name);
    if (!profile) throw new AppError("NOT_FOUND", `Connection profile "${name}" not found`);
    this.profiles.splice(this.profiles.indexOf(profile), 1);
    this.persist();
  }

  /** Full connection for a session/test call, with stored secrets merged back in. */
  reveal(owner: string, name: string): Record<string, unknown> {
    const profile = this.find(owner, name);
    if (!profile) throw new AppError("NOT_FOUND", `Connection profile "${name}" not found`);
    let secrets: Secrets | undefined;
    if (profile.secret) {
      try {
        secrets = JSON.parse(this.decrypt(profile.secret)) as Secrets;
      } catch (error) {
        throw new AppError(
          "PROFILE_SECRET_STORAGE_DISABLED",
          `Stored secret for profile "${name}" cannot be decrypted: ${(error as Error).message}. ` +
            "DATA_AGENT_PROFILE_SECRET_KEY probably changed; re-save the profile.",
        );
      }
    }
    return mergeSecrets(profile.config, secrets);
  }

  private find(owner: string, name: string): StoredProfile | undefined {
    return this.profiles.find((profile) => profile.owner === owner && profile.name === name);
  }

  private view(profile: StoredProfile): ProfileView {
    return {
      name: profile.name,
      config: structuredClone(profile.config),
      hasSecret: Boolean(profile.secret),
      updatedAt: profile.updatedAt,
    };
  }

  private encrypt(plain: string): string {
    const key = this.key;
    if (!key) throw new AppError("PROFILE_SECRET_STORAGE_DISABLED", "No profile secret key configured");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
  }

  private decrypt(encoded: string): string {
    const key = this.key;
    if (!key) throw new Error("no profile secret key configured");
    const [version, iv, tag, ciphertext] = encoded.split(":");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("unsupported secret format");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.profiles) || parsed.profiles.some(
      (profile) => !profile || typeof profile.name !== "string" || typeof profile.owner !== "string" || !profile.config,
    )) {
      throw new Error("Invalid connection profile store; restore or repair connections.json before starting the service");
    }
    this.profiles = parsed.profiles;
  }

  private persist(): void {
    const payload: StoreFile = { version: 1, profiles: this.profiles };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
  }
}
