import type { Request, Response } from "express";
import express from "express";
import { LOGIN_TTL_MS, LoginRequest, AccountName, NewPassword, type AccountStore } from "../auth/accounts.js";
import { AppError } from "../errors.js";
import { z } from "zod";

export function accountAuth(accounts: AccountStore | undefined, secure: boolean) {
  const router = express.Router();
  const cookie = secure ? "__Host-data_agent_login" : "data_agent_login";
  const cookieOptions = { httpOnly: true, sameSite: "strict", path: "/", secure } as const;
  const cookiePattern = new RegExp(`(?:^|;\\s*)${cookie}=([A-Za-z0-9_-]{43})(?:;|$)`);
  const loginCookie = (req: Request) => req.header("cookie")?.match(cookiePattern)?.[1] ?? "";
  const account = (req: Request) => accounts?.authenticate(loginCookie(req));
  const status = (req: Request) => {
    const user = account(req);
    return { required: Boolean(accounts), account: user ? { username: user.username, role: user.role } : null };
  };
  function assertSameOrigin(req: Request): void {
    const site = req.header("sec-fetch-site");
    const origin = req.header("origin");
    const host = req.header("host");
    if ((site && site !== "same-origin" && site !== "none") ||
      (origin !== undefined && (!host || (origin !== `https://${host}` && (secure || origin !== `http://${host}`))))) {
      throw new AppError("FORBIDDEN", "Cross-origin account requests are not allowed");
    }
  }
  function store(): AccountStore {
    if (!accounts) throw new AppError("NOT_FOUND", "Account login is not enabled");
    return accounts;
  }
  router.get("/status", (req, res) => res.json(status(req)));
  router.post("/login", async (req, res) => {
    const accounts = store();
    assertSameOrigin(req);
    if (!req.is("application/json")) throw new AppError("INVALID_INPUT", "Expected application/json");
    const { username, password } = LoginRequest.parse(req.body);
    // `req.ip` honours the configured trust proxy (unset = the socket peer). Using the raw socket
    // address here would key every attempt to the proxy and lock out all users at once.
    const result = await accounts.login(username, password, req.ip || req.socket.remoteAddress || "unknown");
    accounts.logout(loginCookie(req));
    res.cookie(cookie, result.token, { ...cookieOptions, maxAge: LOGIN_TTL_MS });
    res.json({ required: true, account: { username: result.account.username, role: result.account.role } });
  });
  router.post("/logout", (req: Request, res: Response) => {
    const accounts = store();
    assertSameOrigin(req);
    const expected = req.header("x-data-agent-account");
    const current = account(req);
    if (!expected || !current || expected === current.username) accounts.logout(loginCookie(req));
    else throw new AppError("UNAUTHORIZED", "Account has changed; reload the console");
    res.clearCookie(cookie, cookieOptions).status(204).end();
  });

  // Account management endpoints (admin only)
  const requireAdmin = (req: Request) => {
    const user = account(req);
    if (!user || user.role !== "admin") {
      throw new AppError("FORBIDDEN", "Administrator access required");
    }
    return user;
  };

  router.get("/accounts", (req, res) => {
    requireAdmin(req);
    const accounts = store();
    res.json({ accounts: accounts.listAccounts() });
  });

  router.post("/accounts", async (req, res) => {
    requireAdmin(req);
    assertSameOrigin(req);
    const accounts = store();
    const { username, password, role } = z.object({
      username: AccountName,
      password: NewPassword,
      role: z.enum(["admin", "user"]).default("user"),
    }).parse(req.body);
    await accounts.setPassword(username, password, "add", role);
    res.status(201).json({ success: true, username, role });
  });

  router.post("/accounts/:username/reset-password", async (req, res) => {
    requireAdmin(req);
    assertSameOrigin(req);
    const accounts = store();
    const username = AccountName.parse(req.params.username);
    const { password } = z.object({ password: NewPassword }).parse(req.body);
    await accounts.setPassword(username, password, "reset");
    res.json({ success: true });
  });

  router.delete("/accounts/:username", (req, res) => {
    requireAdmin(req);
    assertSameOrigin(req);
    const accounts = store();
    const username = AccountName.parse(req.params.username);
    accounts.deleteAccount(username);
    res.status(204).end();
  });

  return { router, account, assertSameOrigin };
}
