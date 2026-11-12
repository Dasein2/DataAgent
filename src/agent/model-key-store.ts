import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * API keys typed in the console.
 *
 * `.env` stays the floor for the model configuration, but an operator who switches gateways from the
 * console would otherwise have to retype a key after every restart. This store keeps the last key per
 * provider next to the other service data, so a restart is not a reconfiguration.
 *
 * A key is scoped to the provider it was typed for: switching channels must never forward one
 * gateway's credential to another endpoint. Keys are encrypted with AES-256-GCM under the same
 * `DATA_AGENT_PROFILE_SECRET_KEY` that protects saved connection passwords; without that variable
 * they are kept as plain text in a 0600 file — the same exposure as `.env`, so `state().protection`
 * reports which of the two is in effect instead of pretending the key is protected.
 */
const SALT = "data-agent-model-key-v1";

export type KeyProtection = "aes-256-gcm" | "file-mode-0600" | "none";

const StoredKey = z.object({
  provider: z.string().min(1),
  /** Ciphertext when `protection` is `aes-256-gcm`; the key itself otherwise. */
  value: z.string().min(1),
  protection: z.enum(["aes-256-gcm", "file-mode-0600"]),
  updated_at: z.string(),
});
type StoredKey = z.infer<typeof StoredKey>;

const StoreFile = z.object({ version: z.literal(1), keys: z.array(StoredKey) });

export interface KeyStoreState {
  path: string;
  /** `missing` until a key is saved; `invalid` when the file (or a ciphertext) cannot be trusted. */
  status: "missing" | "ok" | "invalid";
  protection: KeyProtection;
  /** Providers that currently have a usable key. Provider names are not secrets. */
  providers: string[];
}

export class ModelKeyStore {
  private readonly entries = new Map<string, StoredKey>();
  private readonly key?: Buffer;
  private status: "missing" | "ok" | "invalid" = "missing";

  constructor(
    readonly path: string,
    secretKey?: string,
  ) {
    if (secretKey) this.key = scryptSync(secretKey, SALT, 32);
    this.load();
  }

  /** What an operator would get if they read the file: reported, never assumed. */
  get protection(): KeyProtection {
    if (this.key) return "aes-256-gcm";
    return this.entries.size > 0 ? "file-mode-0600" : "none";
  }

  get(provider: string): string | undefined {
    return this.reveal(this.entries.get(provider));
  }

  has(provider: string): boolean {
    return this.get(provider) !== undefined;
  }

  /** Stores the key for one provider. Returns the protection that was actually applied. */
  save(provider: string, apiKey: string): KeyProtection {
    const protection: KeyProtection = this.key ? "aes-256-gcm" : "file-mode-0600";
    this.entries.set(provider, {
      provider,
      value: this.key ? this.encrypt(apiKey) : apiKey,
      protection: protection as StoredKey["protection"],
      updated_at: new Date().toISOString(),
    });
    this.persist();
    return protection;
  }

  /** Drops one provider's key, or every key when no provider is given. */
  clear(provider?: string): void {
    if (provider === undefined) this.entries.clear();
    else this.entries.delete(provider);
    if (this.entries.size === 0) {
      if (existsSync(this.path)) rmSync(this.path, { force: true });
      this.status = "missing";
      return;
    }
    this.persist();
  }

  state(): KeyStoreState {
    const providers = [...this.entries.keys()]
      .filter((provider) => this.reveal(this.entries.get(provider)) !== undefined)
      .sort();
    // A stored entry that cannot be opened is reported, not hidden: the operator has to know a key
    // they saved is now unusable (usually a changed DATA_AGENT_PROFILE_SECRET_KEY).
    if (providers.length !== this.entries.size) this.status = "invalid";
    return { path: this.path, status: this.status, protection: this.protection, providers };
  }

  /**
   * A ciphertext that cannot be opened usually means `DATA_AGENT_PROFILE_SECRET_KEY` changed. Report
   * it through `state()` and treat the key as absent rather than failing the whole service.
   */
  private reveal(entry: StoredKey | undefined): string | undefined {
    if (!entry) return undefined;
    if (entry.protection === "file-mode-0600") return entry.value;
    try {
      return this.decrypt(entry.value);
    } catch {
      this.status = "invalid";
      return undefined;
    }
  }

  private encrypt(plain: string): string {
    const key = this.key;
    if (!key) throw new Error("no secret key configured");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
  }

  private decrypt(encoded: string): string {
    const key = this.key;
    if (!key) throw new Error("no secret key configured");
    const [version, iv, tag, ciphertext] = encoded.split(":");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("unsupported key format");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = StoreFile.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed.success) {
        this.status = "invalid";
        return;
      }
      for (const entry of parsed.data.keys) this.entries.set(entry.provider, entry);
      this.status = "ok";
    } catch {
      this.status = "invalid";
    }
  }

  private persist(): void {
    const body = JSON.stringify({ version: 1, keys: [...this.entries.values()] }, null, 2);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${body}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    this.status = "ok";
  }
}
