// Read-only access to the shop DB. Every query the agent (or a scorer) runs
// goes through runSql(), which enforces: a single SELECT/WITH statement, a
// read-only connection, and a row cap.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { DB_PATH } from "../flywheel/paths";

export const MAX_ROWS = 200;

export type Cell = string | number | null;
export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  rowCount: number; // rows returned (after cap)
  truncated: boolean;
}

let conn: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (conn) return conn;
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}. Run \`npm run db:seed\` first.`);
  }
  conn = new DatabaseSync(DB_PATH, { readOnly: true });
  return conn;
}

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;

/** Strip comments and string literals so keyword checks don't trip on data. */
function stripForChecks(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export class UnsafeSqlError extends Error {}

/** Throws UnsafeSqlError unless sql is a single read-only SELECT/WITH statement. */
export function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) throw new UnsafeSqlError("Empty SQL");
  const checked = stripForChecks(trimmed);
  if (checked.includes(";")) throw new UnsafeSqlError("Only a single statement is allowed");
  if (!/^\s*(select|with)\b/i.test(checked)) throw new UnsafeSqlError("Only SELECT / WITH queries are allowed");
  if (FORBIDDEN.test(checked)) throw new UnsafeSqlError("Query contains a forbidden keyword");
  return trimmed;
}

function normalizeCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string") return v;
  return String(v);
}

export function runSql(sql: string, maxRows = MAX_ROWS): QueryResult {
  const safe = assertReadOnly(sql);
  const stmt = db().prepare(safe);
  stmt.setReturnArrays(true);
  const columns = stmt.columns().map((c) => c.name);
  const rows: Cell[][] = [];
  let truncated = false;
  for (const row of stmt.iterate() as Iterable<unknown[]>) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(row.map(normalizeCell));
  }
  return { columns, rows, rowCount: rows.length, truncated };
}

/** Like runSql but returns an error string instead of throwing. */
export function tryRunSql(sql: string, maxRows = MAX_ROWS): QueryResult | { error: string } {
  try {
    return runSql(sql, maxRows);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function listTables(): { name: string; rows: number }[] {
  const names = db()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return names.map(({ name }) => ({
    name,
    rows: (db().prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
  }));
}

export function describeTable(name: string) {
  const exists = db().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { sql: string }
    | undefined;
  if (!exists) return { error: `No table named ${name}` };
  const cols = db().prepare(`SELECT name, type, "notnull" AS notNull, pk FROM pragma_table_info(?)`).all(name);
  const sample = runSql(`SELECT * FROM "${name}" LIMIT 3`);
  return { name, ddl: exists.sql, columns: cols, sampleRows: sample };
}
