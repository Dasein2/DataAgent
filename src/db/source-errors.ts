import { AppError } from "../errors.js";

const disconnected = new Set([
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR", "PROTOCOL_ENQUEUE_AFTER_QUIT",
  "PROTOCOL_PACKETS_OUT_OF_ORDER", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTCONN", "57P01", "57P02", "57P03",
]);

export function sourceConnectionLost(error: unknown): boolean {
  const e = error as { code?: string; fatal?: boolean; message?: string } | null;
  return Boolean(e && (e.fatal || e.code === "SESSION_UNAVAILABLE" || disconnected.has(e.code ?? "") ||
    /^08\d{3}$/.test(e.code ?? "") || /connection is in closed state|connection terminated(?: unexpectedly)?|client was closed|client has encountered a connection error/i.test(e.message ?? "")));
}

export function sourceError(error: unknown, unavailable?: string): AppError {
  if (unavailable || sourceConnectionLost(error)) return new AppError("SESSION_UNAVAILABLE", unavailable ?? "Database connection was lost. Reconnect before querying again.");
  if (error instanceof AppError) return error;
  const e = error as { code?: string; errno?: number; message?: string } | null;
  const message = e?.message ?? "Unknown source error";
  if (["PROTOCOL_SEQUENCE_TIMEOUT", "ER_QUERY_TIMEOUT", "ER_QUERY_INTERRUPTED", "57014"].includes(e?.code ?? "") || /query.*timed out|statement timeout|query timeout/i.test(message))
    return new AppError("QUERY_TIMEOUT", message);
  if (["ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "42703", "42P01"].includes(e?.code ?? "") || /unknown column|unknown table|unresolved column/i.test(message))
    return new AppError("SQL_FIELD_ERROR", message);
  if (["ER_PARSE_ERROR", "ER_SYNTAX_ERROR", "42601", "42883"].includes(e?.code ?? "") || /syntax error|no matching function/i.test(message))
    return new AppError("SQL_DIALECT_ERROR", message);
  if (["ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "42501"].includes(e?.code ?? ""))
    return new AppError("SQL_SCOPE_VIOLATION", "Database privileges do not permit this operation");
  return new AppError("INTERNAL_ERROR", `Source operation failed: ${message}`);
}
