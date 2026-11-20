#!/usr/bin/env node
/**
 * 账户管理工具
 * 
 * 使用方法：
 *   npm run accounts list                    # 列出所有账户
 *   npm run accounts add <username>          # 添加普通用户
 *   npm run accounts add-admin <username>    # 添加管理员
 *   npm run accounts reset <username>        # 重置密码
 *   npm run accounts delete <username>       # 删除账户（谨慎）
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as readline from "node:readline";

const DATA_DIR = process.env.DATA_AGENT_DATA_DIR || join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "accounts.db");

interface Account {
  id: string;
  username: string;
  role: "admin" | "user";
  salt: string;
  hash: string;
}

function openDatabase(): DatabaseSync {
  if (!existsSync(DB_PATH)) {
    console.error("❌ 账户数据库不存在。请先启动应用以初始化数据库。");
    process.exit(1);
  }
  return new DatabaseSync(DB_PATH, { timeout: 5000 });
}

async function passwordHash(password: string, salt: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (hidden) {
      const stdin = process.stdin as any;
      stdin.setRawMode?.(true);
      process.stdout.write(question);
      
      let password = "";
      stdin.on("data", (char: Buffer) => {
        const key = char.toString();
        if (key === "\n" || key === "\r" || key === "\u0004") {
          stdin.setRawMode?.(false);
          process.stdout.write("\n");
          rl.close();
          resolve(password);
        } else if (key === "\u0003") {
          process.exit(0);
        } else if (key === "\u007f" || key === "\b") {
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          password += key;
          process.stdout.write("*");
        }
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function readPassword(): Promise<string> {
  while (true) {
    const password = await prompt("输入密码（至少8个字符）: ", true);
    if (password.length < 8) {
      console.error("❌ 密码太短，至少需要8个字符");
      continue;
    }
    const confirm = await prompt("确认密码: ", true);
    if (password !== confirm) {
      console.error("❌ 两次输入的密码不一致");
      continue;
    }
    return password;
  }
}

function listAccounts() {
  const db = openDatabase();
  try {
    const accounts = db.prepare("SELECT id, username, role FROM accounts ORDER BY role, username").all() as Account[];
    
    if (accounts.length === 0) {
      console.log("📋 没有找到任何账户");
      return;
    }

    console.log("\n📋 账户列表:\n");
    console.log("用户名".padEnd(20) + "角色".padEnd(10) + "用户ID");
    console.log("─".repeat(60));
    
    for (const account of accounts) {
      const roleIcon = account.role === "admin" ? "👑" : "👤";
      const roleText = account.role === "admin" ? "管理员" : "普通用户";
      console.log(
        `${roleIcon} ${account.username.padEnd(18)}` +
        `${roleText.padEnd(10)}` +
        `${account.id.slice(0, 8)}...`
      );
    }
    console.log();
    
    const stats = {
      total: accounts.length,
      admins: accounts.filter(a => a.role === "admin").length,
      users: accounts.filter(a => a.role === "user").length,
    };
    console.log(`总计: ${stats.total} 个账户 (${stats.admins} 个管理员, ${stats.users} 个普通用户)`);
  } finally {
    db.close();
  }
}

async function addAccount(username: string, role: "admin" | "user") {
  // 验证用户名
  if (!/^[a-z0-9][a-z0-9._-]{0,59}$/i.test(username)) {
    console.error("❌ 用户名无效。必须以字母或数字开头，只能包含字母、数字、点、下划线和连字符，最长60个字符。");
    process.exit(1);
  }

  const db = openDatabase();
  try {
    // 检查用户名是否已存在
    const existing = db.prepare("SELECT username FROM accounts WHERE username = ?").get(username.toLowerCase());
    if (existing) {
      console.error(`❌ 用户名 "${username}" 已存在`);
      process.exit(1);
    }

    // 读取密码
    console.log(`\n创建${role === "admin" ? "管理员" : "普通用户"}账户: ${username}`);
    const password = await readPassword();

    // 生成密码哈希
    const salt = randomBytes(16).toString("hex");
    const hash = (await passwordHash(password, salt)).toString("hex");
    const id = randomBytes(16).toString("hex");

    // 插入数据库
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO accounts (id, username, role, salt, hash) VALUES (?, ?, ?, ?, ?)")
        .run(id, username.toLowerCase(), role, salt, hash);
      db.exec("COMMIT");
      
      const roleText = role === "admin" ? "管理员" : "普通用户";
      console.log(`\n✅ ${roleText}账户创建成功！`);
      console.log(`   用户名: ${username}`);
      console.log(`   角色: ${roleText}`);
      console.log(`   用户ID: ${id}`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

async function resetPassword(username: string) {
  const db = openDatabase();
  try {
    // 查找账户
    const account = db.prepare("SELECT id, username, role FROM accounts WHERE username = ?")
      .get(username.toLowerCase()) as Account | undefined;
    
    if (!account) {
      console.error(`❌ 用户 "${username}" 不存在`);
      process.exit(1);
    }

    console.log(`\n重置账户密码: ${account.username} (${account.role === "admin" ? "管理员" : "普通用户"})`);
    const password = await readPassword();

    // 生成新的密码哈希
    const salt = randomBytes(16).toString("hex");
    const hash = (await passwordHash(password, salt)).toString("hex");

    // 更新密码并删除所有会话
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE accounts SET salt = ?, hash = ? WHERE id = ?").run(salt, hash, account.id);
      const deleted = db.prepare("DELETE FROM sessions WHERE account_id = ?").run(account.id);
      db.exec("COMMIT");
      
      console.log(`\n✅ 密码重置成功！`);
      console.log(`   已删除 ${deleted.changes} 个活跃会话，用户需要重新登录。`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

async function deleteAccount(username: string) {
  const db = openDatabase();
  try {
    // 查找账户
    const account = db.prepare("SELECT id, username, role FROM accounts WHERE username = ?")
      .get(username.toLowerCase()) as Account | undefined;
    
    if (!account) {
      console.error(`❌ 用户 "${username}" 不存在`);
      process.exit(1);
    }

    // 检查是否是最后一个管理员
    const adminCount = (db.prepare("SELECT COUNT(*) as count FROM accounts WHERE role = 'admin'")
      .get() as { count: number }).count;
    
    if (account.role === "admin" && adminCount <= 1) {
      console.error("❌ 无法删除最后一个管理员账户");
      process.exit(1);
    }

    // 确认删除
    console.log(`\n⚠️  警告: 即将删除账户 "${account.username}" (${account.role === "admin" ? "管理员" : "普通用户"})`);
    console.log("   这将删除:");
    console.log("   - 账户本身");
    console.log("   - 所有活跃会话");
    console.log("   - 该用户的所有会话历史、查询结果等数据仍会保留");
    console.log();
    
    const confirm = await prompt(`输入用户名 "${account.username}" 确认删除: `);
    if (confirm !== account.username) {
      console.log("❌ 用户名不匹配，取消删除");
      process.exit(1);
    }

    // 删除账户
    db.exec("BEGIN IMMEDIATE");
    try {
      const sessionDeleted = db.prepare("DELETE FROM sessions WHERE account_id = ?").run(account.id);
      db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
      db.exec("COMMIT");
      
      console.log(`\n✅ 账户已删除`);
      console.log(`   已删除 ${sessionDeleted.changes} 个活跃会话`);
      console.log(`\n💡 注意: 该用户的历史数据（会话、查询结果等）仍保留在 data/history/ 中`);
      console.log(`   如需完全清理，请手动删除 ownerKey 为 "account/${account.id}" 的文件`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function showHelp() {
  console.log(`
📚 Data Agent 账户管理工具

用法:
  npm run accounts <command> [options]

命令:
  list                      列出所有账户
  add <username>            添加普通用户账户
  add-admin <username>      添加管理员账户
  reset <username>          重置账户密码
  delete <username>         删除账户（谨慎使用）
  help                      显示此帮助信息

示例:
  npm run accounts list
  npm run accounts add alice
  npm run accounts add-admin bob
  npm run accounts reset alice
  npm run accounts delete bob

注意事项:
  • 用户名只能包含字母、数字、点、下划线和连字符
  • 用户名不区分大小写
  • 密码至少需要8个字符
  • 无法删除最后一个管理员账户
  • 重置密码会使该用户的所有会话失效
`);
}

async function main() {
  const [,, command, ...args] = process.argv;

  if (!command || command === "help" || command === "-h" || command === "--help") {
    showHelp();
    return;
  }

  try {
    switch (command) {
      case "list":
        listAccounts();
        break;
      
      case "add":
        if (args.length === 0) {
          console.error("❌ 请指定用户名");
          console.error("用法: npm run accounts add <username>");
          process.exit(1);
        }
        await addAccount(args[0]!, "user");
        break;
      
      case "add-admin":
        if (args.length === 0) {
          console.error("❌ 请指定用户名");
          console.error("用法: npm run accounts add-admin <username>");
          process.exit(1);
        }
        await addAccount(args[0]!, "admin");
        break;
      
      case "reset":
        if (args.length === 0) {
          console.error("❌ 请指定用户名");
          console.error("用法: npm run accounts reset <username>");
          process.exit(1);
        }
        await resetPassword(args[0]!);
        break;
      
      case "delete":
        if (args.length === 0) {
          console.error("❌ 请指定用户名");
          console.error("用法: npm run accounts delete <username>");
          process.exit(1);
        }
        await deleteAccount(args[0]!);
        break;
      
      default:
        console.error(`❌ 未知命令: ${command}`);
        console.error("运行 'npm run accounts help' 查看帮助");
        process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ 错误:", (error as Error).message);
    process.exit(1);
  }
}

main();
