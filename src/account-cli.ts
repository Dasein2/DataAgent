import { join } from "node:path";
import { AccountStore } from "./auth/accounts.js";
import { loadConfig } from "./config.js";

async function main() {
  const [action, username] = process.argv.slice(2);
  if ((action !== "add" && action !== "reset") || !username || process.stdin.isTTY) {
    throw new Error("Usage: pipe the new password via stdin to npm run account -- add|reset USER [--env-file FILE]");
  }
  process.stdin.setEncoding("utf8");
  let password = "";
  for await (const chunk of process.stdin) {
    password += chunk;
    if (password.length > 258) throw new Error("Password too long");
  }
  const config = loadConfig();
  const accounts = new AccountStore(join(config.dataDir, "accounts.db"));
  try {
    if (!accounts.hasAdmin()) throw new Error("Start account mode once to initialize the admin account first");
    await accounts.setPassword(username, password.replace(/\r?\n$/, ""), action);
    console.log(action === "add" ? "Account created" : "Password changed; existing logins revoked");
  } finally { accounts.close(); }
}

main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
