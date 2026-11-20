import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../errors.js";

export const AccountName = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/);
const Password = z.string().min(1).max(256);
export const LoginRequest = z.object({ username: AccountName, password: Password });
export const MIN_PASSWORD_LENGTH = 8;
export const NewPassword = Password.min(MIN_PASSWORD_LENGTH);
export const LOGIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LIMIT_WINDOW_MS = 60_000;

export interface AccountIdentity {
  username: string;
  role: "admin" | "user";
  ownerKey: string;
}

interface AccountRow { id: string; username: string; role: AccountIdentity["role"]; salt: string; hash: string }
const identity = (row: Pick<AccountRow, "id" | "username" | "role">): AccountIdentity => ({
  username: row.username, role: row.role,
  // This namespace cannot be constructed by legacy callerKey(), even with a custom caller header.
  ownerKey: `account/${row.id}`,
});
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const passwordHash = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (err, key) =>
    err ? reject(err) : resolve(key));
});

export class AccountStore {
  private readonly db: DatabaseSync;
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private closed = false;
  private inFlight = 0;
  private cleanupAt = 0;
  private readonly dummySalt = randomBytes(16).toString("hex");
  private readonly dummyHash = randomBytes(32);

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    closeSync(openSync(file, "a", 0o600));
    this.db = new DatabaseSync(file, { timeout: 5000 });
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
          salt TEXT NOT NULL, hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.closed = true; this.db.close(); }

  hasAdmin(): boolean { return Boolean(this.db.prepare("SELECT 1 FROM accounts WHERE role = 'admin' LIMIT 1").get()); }

  /** Local operator only. An explicit reset preserves the account ID and revokes all logins. */
  async setPassword(rawName: string, rawPassword: string, mode: "bootstrap" | "add" | "reset", role: "admin" | "user" = "user"): Promise<void> {
    const username = AccountName.parse(rawName);
    const password = NewPassword.parse(rawPassword);
    const salt = randomBytes(16).toString("hex");
    const hash = (await passwordHash(password, salt)).toString("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT id FROM accounts WHERE username = ?").get(username) as { id: string } | undefined;
      if (mode === "reset") {
        if (!current) throw new Error("Account not found; use add to create it");
        this.db.prepare("UPDATE accounts SET salt = ?, hash = ? WHERE id = ?").run(salt, hash, current.id);
        this.db.prepare("DELETE FROM sessions WHERE account_id = ?").run(current.id);
      } else if (mode === "add" || !this.hasAdmin()) {
        if (current) throw new Error("Account already exists; use reset to change its password");
        const accountRole = mode === "bootstrap" ? "admin" : role;
        this.db.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?)").run(randomUUID(), username, accountRole, salt, hash);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async login(username: string, password: string, peer: string): Promise<{ account: AccountIdentity; token: string }> {
    const now = Date.now();
    if (now >= this.cleanupAt) {
      for (const [key, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(key);
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
      this.cleanupAt = now + LIMIT_WINDOW_MS;
    }
    const attempt = this.attempts.get(peer);
    if (this.inFlight >= 4 || (!attempt && this.attempts.size >= 10_000) ||
      (attempt && attempt.until > now && attempt.count >= 10)) {
      throw new AppError("LOGIN_RATE_LIMITED", "Too many login attempts; try again in a minute");
    }
    this.attempts.set(peer, attempt && attempt.until > now ? { ...attempt, count: attempt.count + 1 } : { count: 1, until: now + LIMIT_WINDOW_MS });
    this.inFlight++;
    try {
      const lookup = this.db.prepare("SELECT * FROM accounts WHERE username = ?");
      const row = lookup.get(username) as unknown as AccountRow | undefined;
      const actual = await passwordHash(password, row?.salt ?? this.dummySalt);
      const matches = timingSafeEqual(actual, row ? Buffer.from(row.hash, "hex") : this.dummyHash);
      const token = randomBytes(32).toString("base64url");
      // Match the verified hash atomically so a concurrent password reset cannot issue a stale login.
      if (!matches || !row || !this.db.prepare(`
        INSERT INTO sessions SELECT ?, id, ? FROM accounts WHERE id = ? AND hash = ?
      `).run(tokenHash(token), Date.now() + LOGIN_TTL_MS, row.id, row.hash).changes) {
        throw new AppError("UNAUTHORIZED", "Invalid username or password");
      }
      return { account: identity(row), token };
    } finally { this.inFlight--; }
  }

  authenticate(token: string): AccountIdentity | undefined {
    if (this.closed || !COOKIE_TOKEN.test(token)) return undefined;
    const row = this.db.prepare(`
      SELECT accounts.id, username, role FROM sessions JOIN accounts ON accounts.id = account_id
      WHERE token_hash = ? AND expires_at > ?
    `).get(tokenHash(token), Date.now()) as Pick<AccountRow, "id" | "username" | "role"> | undefined;
    return row && identity(row);
  }

  logout(token: string): void {
    if (COOKIE_TOKEN.test(token)) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  /** List all accounts (admin only). Never returns password hashes. */
  listAccounts(): Array<{ id: string; username: string; role: AccountIdentity["role"]; createdSessions: number }> {
    const accounts = this.db.prepare("SELECT id, username, role FROM accounts ORDER BY role, username").all() as unknown as AccountRow[];
    return accounts.map(account => {
      const sessions = this.db.prepare("SELECT COUNT(*) as count FROM sessions WHERE account_id = ? AND expires_at > ?").get(account.id, Date.now()) as { count: number };
      return { id: account.id, username: account.username, role: account.role, createdSessions: sessions.count };
    });
  }

  /** Delete an account and all its sessions (admin only). */
  deleteAccount(username: string): void {
    const account = this.db.prepare("SELECT id, role FROM accounts WHERE username = ?").get(username.toLowerCase()) as Pick<AccountRow, "id" | "role"> | undefined;
    if (!account) throw new AppError("NOT_FOUND", `Account "${username}" not found`);
    
    // Prevent deleting the last admin
    if (account.role === "admin") {
      const adminCount = (this.db.prepare("SELECT COUNT(*) as count FROM accounts WHERE role = 'admin'").get() as { count: number }).count;
      if (adminCount <= 1) {
        throw new AppError("FORBIDDEN", "Cannot delete the last administrator account");
      }
    }
    
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM sessions WHERE account_id = ?").run(account.id);
      this.db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
