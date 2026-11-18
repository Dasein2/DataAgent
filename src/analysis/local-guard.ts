import parser from "node-sql-parser";
import { guardSql } from "../db/guard.js";
import { AppError } from "../errors.js";
const allowed = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "round",
  "abs",
  "coalesce",
  "nullif",
  "date_trunc",
  "extract",
  "lower",
  "upper",
  "length",
  "substring",
  "concat",
  "row_number",
  "rank",
  "dense_rank",
  "lag",
  "lead",
  "greatest",
  "least",
  "percentile_cont",
  "grouping",
]);
/** AST validation handles quoted/schema-qualified function names; never rely on a text regex. */
export function validateLocalSql(sql: string): void {
  if (sql.length > 30_000) throw new AppError("INVALID_INPUT", "Local SQL exceeds 30000 characters");
  const guard = guardSql(sql, {
    engine: "postgres",
    allowedScopes: ["public"],
  });
  if (!guard.ok || guard.kind !== "select" || !guard.parsed)
    throw new AppError("SQL_FORBIDDEN_STATEMENT", "Local SQL accepts one parser-verified SELECT/WITH statement only");
  const ast = new parser.Parser().astify(sql, {
    database: "Postgresql",
  }) as any;
  const ctes = new Set<string>();
  const visit = (v: any, callback: (n: any) => void) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const n of v) visit(n, callback);
      return;
    }
    callback(v);
    for (const n of Object.values(v)) visit(n, callback);
  };
  visit(ast, (n) => {
    if (Array.isArray(n.with)) for (const cte of n.with) ctes.add(String(cte.name?.value ?? cte.name).toLowerCase());
  });
  visit(ast, (n) => {
    if (n.type === "function" || n.type === "aggr_func") {
      const name =
        typeof n.name === "string"
          ? n.name.toLowerCase()
          : (n.name?.name ?? [])
              .map((p: any) => p.value)
              .join(".")
              .toLowerCase();
      if (!allowed.has(name))
        throw new AppError("SQL_FORBIDDEN_FUNCTION", `Local analytical function ${name} is not permitted`);
    }
    if (Array.isArray(n.from))
      for (const relation of n.from) {
        if (relation.db || relation.schema || relation.type === "function")
          throw new AppError(
            "SQL_SCOPE_VIOLATION",
            "Local queries may reference only data and CTEs, not other schemas/functions",
          );
        if (
          relation.table &&
          (/^(pg_|sql_|information_schema$)/i.test(relation.table) ||
            (relation.table.toLowerCase() !== "data" && !ctes.has(relation.table.toLowerCase())))
        )
          throw new AppError("SQL_SCOPE_VIOLATION", `Unknown local relation ${relation.table}; use table data`);
      }
  });
}
