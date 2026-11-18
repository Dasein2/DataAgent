#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const server = spawn(process.execPath, ["scripts/pglite-server.mjs", String(port)], {
  cwd, stdio: ["ignore", "pipe", "inherit"],
});
let tests;
const stop = () => { tests?.kill("SIGKILL"); server.kill("SIGKILL"); };
process.once("SIGINT", () => { stop(); process.exitCode = 130; });
process.once("SIGTERM", () => { stop(); process.exitCode = 143; });
try {
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("PGlite startup exceeded 30 seconds")), 30_000);
    const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    server.once("error", done);
    server.once("exit", (code) => done(new Error(`PGlite exited: ${code}`)));
    server.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("pglite-server listening")) done();
    });
  });
  tests = spawn(process.execPath, ["--import", "tsx", "--test", "--test-timeout=45000", "tests/integration/*.test.ts"], {
    cwd, stdio: "inherit",
    env: { ...process.env, DATA_AGENT_TEST_MYSQL: process.argv.includes("--all") ? (process.env.DATA_AGENT_TEST_MYSQL ?? "") : "", DATA_AGENT_TEST_PG: `postgres://postgres:postgres@127.0.0.1:${port}/postgres?workspace=analysis_ws`, DATA_AGENT_TEST_PGLITE: "1" },
  });
  const deadline = setTimeout(() => tests.kill("SIGKILL"), 55_000);
  try {
    const [code] = await once(tests, "exit");
    process.exitCode = code ?? 1;
  } finally { clearTimeout(deadline); }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { stop(); }
