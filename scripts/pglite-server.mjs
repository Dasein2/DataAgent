#!/usr/bin/env node
/**
 * Local PostgreSQL conformance server without Docker.
 *
 * PGlite is real PostgreSQL compiled to WASM, exposed over the PostgreSQL wire protocol, so the
 * service talks to it exactly like a remote database. Only used by `npm run test:integration:local`
 * and manual exploration; it is not a production dependency.
 *
 *   node scripts/pglite-server.mjs [port]
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 55432);
const db = await PGlite.create();
await db.waitReady;

const seed = await readFile(join(here, "seed", "postgres-pglite.sql"), "utf8");
await db.exec(seed);
console.log("seeded pglite fixture");

const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port, maxConnections: 8 });
await server.start();
console.log(`pglite-server listening on postgres://postgres:postgres@127.0.0.1:${port}/postgres`);

const stop = async () => {
  await server.stop().catch(() => undefined);
  await db.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
