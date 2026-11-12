import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeDorisGrants, analyzeGrantRows, analyzeGrants, summarizeWrites } from "../src/db/grants.js";

/** The column order of Doris `SHOW GRANTS` (docs 2.x/3.x/4.x). */
const DORIS_FIELDS = [
  { name: "UserIdentity" },
  { name: "Comment" },
  { name: "Password" },
  { name: "Roles" },
  { name: "GlobalPrivs" },
  { name: "CatalogPrivs" },
  { name: "DatabasePrivs" },
  { name: "TablePrivs" },
  { name: "ColPrivs" },
  { name: "ResourcePrivs" },
  { name: "WorkloadGroupPrivs" },
];

/** Builds one Doris row with the privilege columns filled in by name. */
function dorisRow(privs: {
  global?: string | null;
  catalog?: string | null;
  database?: string | null;
  table?: string | null;
  workload?: string | null;
}): unknown[] {
  return [
    "'lihaoyang'@'%'",
    "",
    "Yes",
    "",
    privs.global ?? null,
    privs.catalog ?? null,
    privs.database ?? null,
    privs.table ?? null,
    null,
    null,
    privs.workload ?? null,
  ];
}

describe("MySQL-style GRANT lines", () => {
  it("accepts a SELECT-only account", () => {
    const analysis = analyzeGrants([
      "GRANT SELECT ON `app`.* TO `ro`@`%`",
      "GRANT USAGE ON *.* TO `ro`@`%`",
    ]);
    assert.equal(analysis.parsed, 2);
    assert.deepEqual(analysis.writes, []);
    assert.deepEqual(analysis.reads, ["SELECT", "USAGE"]);
  });

  it("reports write privileges with their scope", () => {
    const analysis = analyzeGrants(["GRANT SELECT, INSERT, DELETE ON `app`.* TO `w`@`%`"]);
    assert.deepEqual(
      analysis.writes.map((write) => `${write.privilege}@${write.scope}`),
      ["INSERT@app.*", "DELETE@app.*"],
    );
  });

  it("keeps dispatching MySQL output through the line parser", () => {
    const analysis = analyzeGrantRows([{ name: "Grants for ro@%" }], [
      ["GRANT SELECT ON `app`.* TO `ro`@`%`"],
    ]);
    assert.equal(analysis.parsed, 1);
    assert.deepEqual(analysis.writes, []);
  });
});

describe("Doris/StarRocks columnar SHOW GRANTS", () => {
  it("recognises the columnar shape instead of refusing it", () => {
    const analysis = analyzeDorisGrants(DORIS_FIELDS, [
      dorisRow({ database: "internal.ods_app_: Select_priv", workload: "normal: Usage_priv" }),
    ]);
    assert.equal(analysis.parsed, 1);
    assert.deepEqual(analysis.writes, []);
    assert.ok(analysis.reads.includes("SELECT_PRIV"));
    assert.ok(analysis.reads.includes("USAGE_PRIV"));
  });

  it("reports every writable privilege on a mixed account", () => {
    // Verbatim DatabasePrivs from a real Doris cluster.
    const database =
      "internal.bs_ai_lab_test: Select_priv; " +
      "internal.dws_app_data: Select_priv,Load_priv,Alter_priv,Create_priv,Drop_priv; " +
      "internal.information_schema: Select_priv; internal.mysql: Select_priv; " +
      "internal.ods_app_app_community: Select_priv; internal.ods_app_base_data: Select_priv; " +
      "internal.ods_app_jh_data: Select_priv; internal.ods_oa_oaaftersales: Select_priv; " +
      "internal.ods_oa_oafinancial: Select_priv; lingxing_api_data_catalog.public: Select_priv";
    const analysis = analyzeDorisGrants(DORIS_FIELDS, [dorisRow({ database, workload: "normal: Usage_priv" })]);

    assert.equal(analysis.parsed, 1);
    assert.deepEqual(
      analysis.writes.map((write) => `${write.privilege}@${write.scope}`),
      [
        "LOAD_PRIV@internal.dws_app_data",
        "ALTER_PRIV@internal.dws_app_data",
        "CREATE_PRIV@internal.dws_app_data",
        "DROP_PRIV@internal.dws_app_data",
      ],
    );
    // The message a caller sees must name the offending scope, not "no recognizable GRANT lines".
    assert.match(summarizeWrites(analysis), /LOAD_PRIV on internal\.dws_app_data/);
  });

  it("treats a bare global privilege as scope *", () => {
    const analysis = analyzeDorisGrants(DORIS_FIELDS, [dorisRow({ global: "Admin_priv" })]);
    assert.deepEqual(
      analysis.writes.map((write) => `${write.privilege}@${write.scope}`),
      ["ADMIN_PRIV@*"],
    );
  });

  it("parses JSON privilege cells", () => {
    const readOnly = analyzeDorisGrants(DORIS_FIELDS, [dorisRow({ global: '{"Select_priv":true}' })]);
    assert.deepEqual(readOnly.writes, []);
    assert.ok(readOnly.reads.includes("SELECT_PRIV"));

    const writable = analyzeDorisGrants(DORIS_FIELDS, [dorisRow({ global: '{"Admin_priv":true}' })]);
    assert.equal(writable.writes[0]?.privilege, "ADMIN_PRIV");
  });

  it("fails closed on an unknown privilege name", () => {
    const analysis = analyzeDorisGrants(DORIS_FIELDS, [dorisRow({ database: "internal.db: Select_priv,Some_new_priv" })]);
    assert.deepEqual(analysis.writes.map((write) => write.privilege), ["SOME_NEW_PRIV"]);
  });

  it("fails closed on an unparseable cell", () => {
    const analysis = analyzeDorisGrants(DORIS_FIELDS, [dorisRow({ global: "{not json" })]);
    assert.equal(analysis.writes[0]?.privilege, "UNPARSED");
    assert.equal(analysis.unparsed.length, 1);
  });

  it("still refuses an unrecognised shape", () => {
    const analysis = analyzeDorisGrants([{ name: "Something" }], [["whatever"]]);
    assert.equal(analysis.parsed, 0);
  });

  it("counts an account with no privileges as recognised", () => {
    const analysis = analyzeDorisGrants(DORIS_FIELDS, [dorisRow({})]);
    assert.equal(analysis.parsed, 1);
    assert.deepEqual(analysis.writes, []);
  });

  it("dispatches Doris output away from the line parser", () => {
    const analysis = analyzeGrantRows(DORIS_FIELDS, [dorisRow({ database: "internal.ods_app_: Select_priv" })]);
    assert.equal(analysis.parsed, 1);
    assert.deepEqual(analysis.writes, []);
  });
});
