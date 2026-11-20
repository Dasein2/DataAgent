import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ConnectionConfig } from "./types.js";

/**
 * Saved connection profiles live on the service, not in a browser, so the console and any API
 * caller share the same set.
 *
 * Account profiles encrypt the entire connection using a per-owner key derived from
 * DATA_AGENT_PROFILE_SECRET_KEY. Legacy profiles keep public fields and opt in to encrypting
 * just the credentials. Writes requiring encryption fail if the key is missing.
 */
export const PROFILE_NAME = /^[A-Za-z0-9._:-]{1,60}$/;

export const SaveProfileRequest = z.object({
  connection: ConnectionConfig,
  group: z.string().trim().max(60).optional(),
  /** Keep password / SSH credentials with the profile. Requires DATA_AGENT_PROFILE_SECRET_KEY. */
  rememberSecret: z.boolean().optional().default(false),
});
export type SaveProfileRequest = z.infer<typeof SaveProfileRequest>;

/** What the API returns: never includes secrets, only whether some are stored. */
export interface ProfileView {
  id: string;
  name: string;
  group?: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  updatedAt: string;
}

interface Secrets {
  password?: string;
  ssh?: Array<{ password?: string; privateKey?: string; passphrase?: string }>;
}

interface StoredProfile {
  id: string;
  name: string;
  owner: string;
  group?: string;
  config?: Record<string, unknown>;
  /** `v1:<iv>:<tag>:<ciphertext>` for legacy secrets; v2 for the entire account connection. */
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

  connectionById(owner: string, id: string): ConnectionConfig | undefined {
    const record = this.profiles.find((profile) => profile.owner === owner && profile.id === id);
    return record && (this.isAccount(record) || record.secret
      ? ConnectionConfig.parse(this.readConnection(record)) : undefined);
  }

  /**
   * Stores a confirmed host key without touching the rest of the profile. Pinning is a separate
   * action from saving: it must not rewrite the connection or drop the encrypted credentials that
   * were saved earlier.
   */
  pinHostKey(owner: string, name: string, hopIndex: number, fingerprint: string): ProfileView {
    const existing = this.find(owner, name);
    if (!existing) throw new AppError("NOT_FOUND", `Connection profile "${name}" not found`);
    const config = this.isAccount(existing) ? this.readConnection(existing) : structuredClone(existing.config!);
    const ssh = config.ssh as { hops: Array<{ hostFingerprint?: string; host: string }> } | undefined;
    const hop = ssh?.hops[hopIndex];
    if (!hop) {
      throw new AppError("INVALID_INPUT", `Connection profile "${name}" has no SSH hop ${hopIndex + 1}`);
    }
    hop.hostFingerprint = fingerprint;
    const next = { ...existing, updatedAt: new Date().toISOString() };
    if (this.isAccount(next)) next.secret = this.encrypt(JSON.stringify(config), next);
    else next.config = config;
    this.replace(existing, next);
    return this.view(next);
  }

  /** Saves or replaces a profile. `rememberSecret` controls legacy profiles only. */
  save(owner: string, name: string, connection: ConnectionConfig, rememberSecret: boolean, group?: string): ProfileView {
    if (!PROFILE_NAME.test(name)) {
      throw new AppError("PROFILE_NAME_INVALID", 'Profile name must match [A-Za-z0-9._:-]{1,60}');
    }
    const account = owner.startsWith("account/");
    const { config, secrets } = splitSecrets(connection);
    const keepSecret = rememberSecret && hasSecrets(secrets);
    if ((account || keepSecret) && !this.key) {
      throw new AppError(
        "PROFILE_SECRET_STORAGE_DISABLED",
        "This deployment cannot store profile secrets: set DATA_AGENT_PROFILE_SECRET_KEY and restart, " +
          (account ? "then try again." : "or save the profile without the password."),
      );
    }

    const existing = this.find(owner, name);
    if (!existing && this.profiles.filter((profile) => profile.owner === owner).length >= this.max) {
      throw new AppError(
        "PROFILE_LIMIT_REACHED",
        `This caller already holds ${this.max} saved connection profiles; delete one first`,
      );
    }

    const record: StoredProfile = { id: existing?.id ?? randomUUID(), name, owner, updatedAt: new Date().toISOString() };
    const nextGroup = group === undefined ? existing?.group : group;
    if (nextGroup) record.group = nextGroup;
    if (account) record.secret = this.encrypt(JSON.stringify(connection), record);
    else {
      record.config = config;
      if (keepSecret) record.secret = this.encrypt(JSON.stringify(secrets));
    }
    this.replace(existing, record);
    return this.view(record);
  }

  remove(owner: string, name: string): void {
    const profile = this.find(owner, name);
    if (!profile) throw new AppError("NOT_FOUND", `Connection profile "${name}" not found`);
    this.commit(this.profiles.filter((entry) => entry !== profile));
  }

  /** Rename the caller's group without touching profile IDs or encrypted credentials. */
  renameGroup(owner: string, from: string, to: string): number {
    const members = this.profiles.filter((entry) => entry.owner === owner && (entry.group ?? "") === from);
    if (!members.length) throw new AppError("NOT_FOUND", "找不到该连接分组");
    if (from === to) return members.length;
    if (this.profiles.some((entry) => entry.owner === owner && entry.group === to)) {
      throw new AppError("INVALID_INPUT", "已存在同名分组");
    }
    const updatedAt = new Date().toISOString();
    this.commit(this.profiles.map((entry) => members.includes(entry) ? { ...entry, group: to, updatedAt } : entry));
    return members.length;
  }

  /** Full connection for a session/test call, with stored secrets merged back in. */
  reveal(owner: string, name: string): Record<string, unknown> {
    const profile = this.find(owner, name);
    if (!profile) throw new AppError("NOT_FOUND", `Connection profile "${name}" not found`);
    return this.readConnection(profile);
  }

  private isAccount(profile: StoredProfile): boolean {
    return profile.owner.startsWith("account/");
  }

  private readConnection(profile: StoredProfile): Record<string, unknown> {
    try {
      if (this.isAccount(profile)) return JSON.parse(this.decrypt(profile.secret!, profile));
      const secrets = profile.secret ? JSON.parse(this.decrypt(profile.secret)) as Secrets : undefined;
      return mergeSecrets(profile.config!, secrets);
    } catch {
      throw new AppError("PROFILE_SECRET_STORAGE_DISABLED",
        `Stored secret for profile "${profile.name}" cannot be decrypted. Restore DATA_AGENT_PROFILE_SECRET_KEY or re-save the profile.`);
    }
  }

  private replace(existing: StoredProfile | undefined, next: StoredProfile): void {
    this.commit(existing ? this.profiles.map((entry) => entry === existing ? next : entry) : [...this.profiles, next]);
  }

  private find(owner: string, name: string): StoredProfile | undefined {
    return this.profiles.find((profile) => profile.owner === owner && profile.name === name);
  }

  private view(profile: StoredProfile): ProfileView {
    return {
      id: profile.id,
      name: profile.name,
      group: profile.group,
      config: this.isAccount(profile) ? splitSecrets(ConnectionConfig.parse(this.readConnection(profile))).config : structuredClone(profile.config!),
      hasSecret: Boolean(profile.secret),
      updatedAt: profile.updatedAt,
    };
  }

  private aad(profile: StoredProfile): Buffer {
    return Buffer.from(JSON.stringify([profile.owner, profile.id, profile.name]));
  }

  private keyFor(profile?: StoredProfile): Buffer {
    if (!this.key) throw new AppError("PROFILE_SECRET_STORAGE_DISABLED", "No profile secret key configured");
    return profile ? createHmac("sha256", this.key).update("data-agent-profile-v2:").update(profile.owner).digest() : this.key;
  }

  private encrypt(plain: string, profile?: StoredProfile): string {
    const key = this.keyFor(profile);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    if (profile) cipher.setAAD(this.aad(profile));
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [profile ? "v2" : "v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
  }

  private decrypt(encoded: string, profile?: StoredProfile): string {
    const key = this.keyFor(profile);
    const [version, iv, tag, ciphertext] = encoded.split(":");
    if (version !== (profile ? "v2" : "v1") || !iv || !tag || !ciphertext) throw new Error("unsupported secret format");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    if (profile) decipher.setAAD(this.aad(profile));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.profiles) || parsed.profiles.some(
      (profile) => !profile || typeof profile.name !== "string" || typeof profile.owner !== "string" ||
        (this.isAccount(profile) ? typeof profile.id !== "string" || typeof profile.secret !== "string" : !profile.config),
    )) {
      throw new Error("Invalid connection profile store; restore or repair connections.json before starting the service");
    }
    // Legacy profiles had no ID. Keep a deterministic ID until the next normal store write.
    this.profiles = parsed.profiles.map((p) => ({ ...p, id: p.id ?? createHash("sha256").update(JSON.stringify([p.owner, p.name])).digest("hex") }));
  }

  private commit(profiles: StoredProfile[]): void {
    const payload: StoreFile = { version: 1, profiles };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
    this.profiles = profiles;
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
  }
}
