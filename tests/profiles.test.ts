import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeGrants, summarizeWrites } from "../src/db/grants.js";
import {
  ENGINE_IDS,
  ENGINE_PROFILES,
  PROFILE_FIELDS,
  describeEngine,
  detectEnginesFromVersion,
  getProfile,
  isEngineId,
  versionMismatchNote,
} from "../src/db/engines/profiles.js";

describe("engine profiles", () => {
  it("declares every engine exactly once and refuses unknown ids", () => {
    assert.deepEqual(ENGINE_IDS, ["postgres", "mysql", "doris", "starrocks"]);
    for (const id of ENGINE_IDS) {
      assert.equal(ENGINE_PROFILES[id].id, id, `${id} profile must carry its own id`);
      assert.equal(isEngineId(id), true);
    }
    assert.equal(isEngineId("oracle"), false);
    assert.equal(isEngineId(undefined), false);
    assert.throws(() => getProfile("oracle" as never), /Unknown database engine/);
  });

  it("describeEngine exposes exactly PROFILE_FIELDS", () => {
    // Drift guard: a new capability field must be added to PROFILE_FIELDS (and therefore to the
    // descriptor, session capabilities and /v1/engines) or this test fails.
    for (const id of ENGINE_IDS) {
      const descriptor = describeEngine(getProfile(id));
      assert.deepEqual(Object.keys(descriptor).sort(), [...PROFILE_FIELDS].sort(), `${id} descriptor drifted`);
    }
  });

  it("keeps the protocol/dialect split that the guard and tools depend on", () => {
    assert.equal(getProfile("postgres").protocol, "pg");
    assert.equal(getProfile("postgres").dialect, "Postgresql");
    assert.equal(getProfile("postgres").quote, '"');
    assert.equal(getProfile("postgres").workspaceMode, "schema");
    for (const id of ["mysql", "doris", "starrocks"] as const) {
      const profile = getProfile(id);
      assert.equal(profile.protocol, "mysql", id);
      assert.equal(profile.dialect, "MySQL", id);
      assert.equal(profile.quote, "`", id);
      assert.equal(profile.workspaceMode, "database", id);
    }
  });

  it("declares a read-only proof per engine", () => {
    assert.equal(getProfile("postgres").readOnlyProof, "transaction");
    assert.equal(getProfile("mysql").readOnlyProof, "transaction");
    assert.equal(getProfile("doris").readOnlyProof, "grants");
    assert.equal(getProfile("starrocks").readOnlyProof, "grants");
  });

  it("declares explain and row-estimate capabilities without emulation", () => {
    assert.equal(getProfile("postgres").explain, "json");
    assert.equal(getProfile("mysql").explain, "json");
    assert.equal(getProfile("doris").explain, "text");
    // dbx declares no SQL explain for StarRocks; Doris and StarRocks must not be merged.
    assert.equal(getProfile("starrocks").explain, "none");
    assert.notEqual(getProfile("doris").explain, getProfile("starrocks").explain);

    assert.equal(getProfile("postgres").explainAnalyze, true);
    assert.equal(getProfile("mysql").explainAnalyze, false);
    assert.equal(getProfile("doris").explainAnalyze, false);
    assert.equal(getProfile("starrocks").explainAnalyze, false);

    assert.equal(getProfile("postgres").rowEstimate, "table_rows");
    assert.equal(getProfile("mysql").rowEstimate, "table_rows");
    assert.equal(getProfile("doris").rowEstimate, "none");
    assert.equal(getProfile("starrocks").rowEstimate, "none");
  });

  it("declares indexes, foreign keys and transactional DDL per engine", () => {
    assert.deepEqual(
      [getProfile("postgres").secondaryIndexes, getProfile("postgres").foreignKeys],
      [true, true],
    );
    assert.deepEqual([getProfile("mysql").secondaryIndexes, getProfile("mysql").foreignKeys], [true, true]);
    for (const id of ["doris", "starrocks"] as const) {
      assert.equal(getProfile(id).secondaryIndexes, false, `${id} secondary indexes`);
      assert.equal(getProfile(id).foreignKeys, false, `${id} foreign keys`);
    }

    assert.equal(getProfile("postgres").transactionalDdl, true);
    assert.equal(getProfile("mysql").transactionalDdl, false);
    assert.equal(getProfile("doris").transactionalDdl, false);
    assert.equal(getProfile("starrocks").transactionalDdl, false);
  });

  it("declares cancellation and the default port per engine", () => {
    assert.equal(getProfile("postgres").cancel, "backend-pid");
    assert.equal(getProfile("mysql").cancel, "query-id");
    assert.equal(getProfile("doris").cancel, "connection-id");
    assert.equal(getProfile("starrocks").cancel, "connection-id");

    assert.equal(getProfile("postgres").defaultPort, 5432);
    assert.equal(getProfile("mysql").defaultPort, 3306);
    assert.equal(getProfile("doris").defaultPort, 9030);
    assert.equal(getProfile("starrocks").defaultPort, 9030);
  });

  it("fingerprints server versions and warns when the declaration looks wrong", () => {
    assert.deepEqual(detectEnginesFromVersion("PostgreSQL 16.14 (Debian 16.14-1)"), ["postgres"]);
    assert.deepEqual(detectEnginesFromVersion("8.4.6"), ["mysql"]);
    assert.ok(detectEnginesFromVersion("5.7.99").includes("doris"));
    assert.ok(detectEnginesFromVersion("5.7.99").includes("starrocks"));
    assert.deepEqual(detectEnginesFromVersion(""), []);

    assert.equal(versionMismatchNote("mysql", "8.0.36"), undefined);
    assert.match(versionMismatchNote("mysql", "PostgreSQL 16.4") ?? "", /looks like postgres/i);
  });
});

describe("grant analysis (read-only proof for Doris/StarRocks)", () => {
  it("accepts a MySQL-style SELECT-only grant", () => {
    const analysis = analyzeGrants([
      "GRANT SELECT, SHOW VIEW ON `analytics`.* TO `ro_analyst`@`%`",
      "GRANT USAGE ON *.* TO `ro_analyst`@`%`",
    ]);
    assert.deepEqual(analysis.writes, []);
    assert.deepEqual(analysis.reads, ["SELECT", "SHOW VIEW", "USAGE"]);
    assert.equal(analysis.parsed, 2);
  });

  it("accepts a Doris-style privilege grant", () => {
    const analysis = analyzeGrants(["GRANT SELECT_PRIV ON analytics.* TO 'ro'@'%'"]);
    assert.deepEqual(analysis.writes, []);
    assert.deepEqual(analysis.reads, ["SELECT_PRIV"]);
  });

  it("flags ALL PRIVILEGES as a write", () => {
    const analysis = analyzeGrants(["GRANT ALL PRIVILEGES ON *.* TO 'admin'@'%'"]);
    assert.equal(analysis.writes.length, 1);
    assert.equal(analysis.writes[0]?.privilege, "ALL PRIVILEGES");
    assert.equal(analysis.writes[0]?.scope, "*.*");
  });

  it("treats an unknown privilege as a write (fail closed)", () => {
    const analysis = analyzeGrants(["GRANT SELECT, LOAD_PRIV ON analytics.* TO 'ro'@'%'"]);
    assert.deepEqual(analysis.reads, ["SELECT"]);
    assert.deepEqual(analysis.writes.map((write) => write.privilege), ["LOAD_PRIV"]);
  });

  it("ignores non-GRANT lines but still parses the GRANT line", () => {
    const analysis = analyzeGrants(["REVOKE ALL ON *.* FROM x", "", "GRANT USAGE ON *.* TO 'ro'@'%'"]);
    assert.equal(analysis.parsed, 1);
    assert.deepEqual(analysis.unparsed, []);
    assert.deepEqual(analysis.writes, []);
  });

  it("splits multi-privilege grants into individual privileges", () => {
    const analysis = analyzeGrants(["GRANT SELECT, INSERT, UPDATE ON app.* TO 'u'@'%'"]);
    assert.deepEqual(analysis.reads, ["SELECT"]);
    assert.deepEqual(analysis.writes.map((write) => write.privilege), ["INSERT", "UPDATE"]);
    assert.match(summarizeWrites(analysis), /INSERT on app\.\*/);
  });

  it("counts an unparseable GRANT line as a write", () => {
    const analysis = analyzeGrants(["GRANT something unparseable"]);
    assert.equal(analysis.parsed, 0);
    assert.equal(analysis.unparsed.length, 1);
    assert.deepEqual(analysis.writes.map((write) => write.privilege), ["UNPARSED"]);
  });

  it("reports zero parsed grants for an unrecognised SHOW GRANTS format", () => {
    // Doris 2.x can return a columnar SHOW GRANTS row. It is not proof of anything, and the
    // engine treats parsed === 0 as unverified rather than read-only.
    const analysis = analyzeGrants(["'root'@'%' No Auth \"\" Admin_priv"]);
    assert.equal(analysis.parsed, 0);
    assert.deepEqual(analysis.writes, []);
  });
});

describe("engine selection", () => {
  it("picks the implementation from the declared protocol/profile", async () => {
    const { createEngine, DorisEngine, MysqlEngine, StarrocksEngine, PostgresEngine } = await import(
      "../src/db/engines/index.js"
    );
    const { ConnectionConfig } = await import("../src/db/types.js");
    const base = {
      host: "db.internal",
      database: "analytics",
      user: "ro_analyst",
      password: "ro",
    };
    const make = (engine: string, port: number) =>
      createEngine(ConnectionConfig.parse({ ...base, engine, port }), {
        allowPrivateNetwork: false,
        applicationName: "profiles-test",
      });

    const postgres = make("postgres", 5432);
    assert.ok(postgres instanceof PostgresEngine);
    assert.equal(postgres.kind, "postgres");

    const mysql = make("mysql", 3306);
    assert.ok(mysql instanceof MysqlEngine);
    assert.equal(mysql.kind, "mysql");

    const doris = make("doris", 9030);
    assert.ok(doris instanceof DorisEngine && doris instanceof MysqlEngine);
    assert.equal(doris.kind, "doris");
    assert.equal(doris.profile.readOnlyProof, "grants");

    const starrocks = make("starrocks", 9030);
    assert.ok(starrocks instanceof StarrocksEngine);
    assert.equal(starrocks.kind, "starrocks");
    assert.equal(starrocks.profile.explain, "none");
    assert.equal(starrocks.cancelSupported, true);
  });
});
