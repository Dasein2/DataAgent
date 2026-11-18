import parser from "node-sql-parser";
/** Conservative opt-in cache eligibility: unknown/session/volatile functions are never reusable. */
export function reusableSql(sql: string, dialect: "Postgresql" | "MySQL"): boolean {
  if (/\b(current_\w*|localtime\w*|session_user|system_user|current_user|user)\b/i.test(sql) || /@/.test(sql))
    return false;
  const pure = new Set([
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "round",
    "abs",
    "coalesce",
    "nullif",
    "lower",
    "upper",
    "length",
    "concat",
    "date_trunc",
    "date_format",
    "extract",
    "row_number",
    "rank",
    "dense_rank",
    "lag",
    "lead",
    "greatest",
    "least",
  ]);
  try {
    const ast = new parser.Parser().astify(sql, { database: dialect });
    let safe = true;
    const visit = (v: any) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) {
        v.forEach(visit);
        return;
      }
      if (v.type === "function" || v.type === "aggr_func") {
        const name =
          typeof v.name === "string"
            ? v.name.toLowerCase()
            : (v.name?.name ?? [])
                .map((p: any) => p.value)
                .join(".")
                .toLowerCase();
        if (!pure.has(name)) safe = false;
      }
      Object.values(v).forEach(visit);
    };
    visit(ast);
    return safe;
  } catch {
    return false;
  }
}
