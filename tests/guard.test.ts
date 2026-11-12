import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardSql, type GuardOptions } from "../src/db/guard.js";

const pg: GuardOptions = { engine: "postgres", allowedScopes: ["public", "analytics"], workspace: "dwa_sess1" };
const my: GuardOptions = { engine: "mysql", allowedScopes: ["app", "analytics"], workspace: "dwa_sess1" };

describe("guardSql allowed statements", () => {
  const cases = [
    ["select", "SELECT id, name FROM public.users WHERE id = 1 LIMIT 10"],
    ["select with cte", "WITH recent AS (SELECT * FROM public.orders WHERE created_at > now() - interval '7 day') SELECT count(*) FROM recent"],
    ["select with subquery", "SELECT o.id, (SELECT count(*) FROM public.items i WHERE i.order_id = o.id) FROM public.orders o"],
    ["values", "VALUES (1, 2), (3, 4)"],
    ["explain", "EXPLAIN SELECT * FROM public.users"],
    ["explain analyze", "EXPLAIN ANALYZE SELECT count(*) FROM public.users"],
  ] as const;

  for (const [name, sql] of cases) {
    it(`accepts ${name}`, () => {
      const result = guardSql(sql, pg);
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.code, undefined);
    });
  }

  it("records tables and limit flags", () => {
    const result = guardSql("SELECT * FROM public.users LIMIT 5", pg);
    assert.equal(result.hasLimit, true);
    assert.ok(result.tables.some((table) => table.includes("users")), JSON.stringify(result.tables));
  });

  it("accepts MySQL string functions that collide with keywords", () => {
    const result = guardSql("SELECT REPLACE(name, 'a', 'b'), TRUNCATE(price, 2) FROM app.products", my);
    assert.equal(result.ok, true, result.reason);
  });

  it("allows a single trailing semicolon", () => {
    assert.equal(guardSql("SELECT 1;", pg).ok, true);
  });

  it("ignores semicolons inside strings, comments and dollar quotes", () => {
    assert.equal(guardSql("SELECT ';' AS a, 1 AS b -- ; comment", pg).ok, true);
    assert.equal(guardSql("SELECT $$a;b$$ AS x", pg).ok, true);
    assert.equal(guardSql("SELECT 'it''s; fine'", pg).ok, true);
    assert.equal(guardSql("SELECT `a;b` FROM app.t", my).ok, true);
  });
});

describe("guardSql rejections", () => {
  const cases: Array<[string, string]> = [
    ["SELECT 1; DROP TABLE users", "SQL_MULTIPLE_STATEMENTS"],
    ["SELECT 1; SELECT 2", "SQL_MULTIPLE_STATEMENTS"],
    ["INSERT INTO public.users(id) VALUES (1)", "SQL_FORBIDDEN_STATEMENT"],
    ["UPDATE public.users SET name = 'x'", "SQL_FORBIDDEN_STATEMENT"],
    ["DELETE FROM public.users", "SQL_FORBIDDEN_STATEMENT"],
    ["DROP TABLE public.users", "SQL_FORBIDDEN_STATEMENT"],
    ["CREATE TABLE x AS SELECT 1", "SQL_FORBIDDEN_STATEMENT"],
    ["TRUNCATE public.users", "SQL_FORBIDDEN_STATEMENT"],
    ["WITH gone AS (DELETE FROM public.users RETURNING *) SELECT * FROM gone", "SQL_FORBIDDEN_KEYWORD"],
    ["SELECT * INTO new_table FROM public.users", "SQL_FORBIDDEN_KEYWORD"],
    ["SELECT * FROM public.users FOR UPDATE", "SQL_FORBIDDEN_KEYWORD"],
    ["SELECT * FROM public.users FOR SHARE", "SQL_FORBIDDEN_KEYWORD"],
    ["SELECT pg_sleep(10)", "SQL_FORBIDDEN_FUNCTION"],
    ["SELECT pg_read_file('/etc/passwd')", "SQL_FORBIDDEN_FUNCTION"],
    ["SELECT lo_import('/etc/passwd')", "SQL_FORBIDDEN_FUNCTION"],
    ["SELECT dblink('host=x', 'select 1')", "SQL_FORBIDDEN_FUNCTION"],
    ["SET search_path = public", "SQL_FORBIDDEN_STATEMENT"],
    ["BEGIN", "SQL_FORBIDDEN_STATEMENT"],
    ["COPY public.users TO '/tmp/x.csv'", "SQL_FORBIDDEN_STATEMENT"],
    ["DO $$ BEGIN DELETE FROM public.users; END $$", "SQL_FORBIDDEN_STATEMENT"],
    ["", "SQL_EMPTY"],
    ["   \n\t", "SQL_EMPTY"],
  ];

  for (const [sql, code] of cases) {
    it(`rejects ${sql.slice(0, 48) || "(empty)"}`, () => {
      const result = guardSql(sql, pg);
      assert.equal(result.ok, false);
      assert.equal(result.code, code, result.reason);
    });
  }

  it("rejects MySQL file exfiltration", () => {
    assert.equal(guardSql("SELECT * FROM app.t INTO OUTFILE '/tmp/x'", my).code, "SQL_FORBIDDEN_KEYWORD");
    assert.equal(guardSql("LOAD DATA INFILE '/tmp/x' INTO TABLE app.t", my).code, "SQL_FORBIDDEN_STATEMENT");
    assert.equal(guardSql("SELECT load_file('/etc/passwd')", my).code, "SQL_FORBIDDEN_FUNCTION");
    assert.equal(guardSql("KILL 12", my).code, "SQL_FORBIDDEN_STATEMENT");
    assert.equal(guardSql("SHOW DATABASES", my).ok, true);
  });

  it("rejects references to another session's workspace", () => {
    const result = guardSql("SELECT * FROM dwa_other.ds_secret", pg);
    assert.equal(result.code, "SQL_SCOPE_VIOLATION", result.reason);
  });

  it("rejects unqualified workspace-like names from other sessions", () => {
    assert.equal(guardSql("SELECT * FROM dwa_other_dataset", pg).code, "SQL_SCOPE_VIOLATION");
  });

  it("warns but permits schemas outside the declared scope", () => {
    const result = guardSql("SELECT * FROM other_schema.t", pg);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((warning) => warning.includes("other_schema")));
  });

  it("reports unterminated literals instead of guessing", () => {
    assert.equal(guardSql("SELECT 'abc", pg).code, "SQL_UNTERMINATED_STRING");
    assert.equal(guardSql("SELECT `abc", my).code, "SQL_UNTERMINATED_IDENTIFIER");
  });
});

describe("guardSql engine mapping", () => {
  // Doris and StarRocks are not MySQL, but they are MySQL dialect. The guard takes the four-value
  // engine id and maps it through the profile, so no new engine branch is needed here.
  for (const engine of ["mysql", "doris", "starrocks"] as const) {
    it(`uses the MySQL dialect for ${engine}`, () => {
      const options: GuardOptions = { engine, allowedScopes: ["analytics"], workspace: "dwa_sess1" };
      const result = guardSql("SELECT `region`, COUNT(*) FROM `analytics`.`sales` GROUP BY `region`", options);
      assert.equal(result.ok, true, result.reason);
      assert.ok(result.tables.some((table) => table.includes("sales")), JSON.stringify(result.tables));
      assert.equal(guardSql("DELETE FROM `analytics`.`sales`", options).code, "SQL_FORBIDDEN_STATEMENT");
    });
  }

  it("keeps PostgreSQL dollar-quoted strings and nested comments", () => {
    assert.equal(guardSql("SELECT $$text with 'quote'$$", pg).ok, true);
    assert.equal(guardSql("SELECT 1 /* outer /* inner */ still comment */", pg).ok, true);
  });
});
