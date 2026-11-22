// The analyst's tools. makeTools() takes optional description overrides so
// attribution can re-run the agent with a previous run's tool descriptions
// (component ablation).

import { tool } from "ai";
import { z } from "zod";
import { describeTable, listTables, tryRunSql } from "./db";

/** How many rows the model sees from runQuery (the full result is still capped at MAX_ROWS). */
const ROWS_SHOWN_TO_MODEL = 30;

export const TOOL_DESCRIPTIONS = {
  listTables: "List every table in the shop database with its row count.",
  describeTable:
    "Show a table's columns (name, type, primary key), its CREATE statement, and 3 sample rows. Call this before querying a table you have not inspected.",
  runQuery:
    "Run ONE read-only SQLite SELECT/WITH query and get the columns and up to 30 rows back. Returns { error } if the query fails.",
  submitAnswer:
    "Submit the final answer. Call exactly once, at the end. `sql` is the final query whose result supports the answer (empty string if the question cannot be answered from the data). `answer` is 1-3 plain-English sentences with the key numbers.",
} as const;

export type ToolDescriptions = Record<keyof typeof TOOL_DESCRIPTIONS, string>;

export const TOOL_SCHEMAS = {
  listTables: z.object({}),
  describeTable: z.object({ table: z.string().describe("Table name") }),
  runQuery: z.object({ sql: z.string().describe("A single SQLite SELECT or WITH query") }),
  submitAnswer: z.object({
    sql: z.string().describe("Final SQL query, or empty string if unanswerable"),
    answer: z.string().describe("Short plain-English answer stating the key numbers"),
  }),
};

export function makeTools(descriptions: Partial<ToolDescriptions> = {}) {
  const d = { ...TOOL_DESCRIPTIONS, ...descriptions };
  return {
    listTables: tool({
      description: d.listTables,
      inputSchema: TOOL_SCHEMAS.listTables,
      execute: async () => listTables(),
    }),
    describeTable: tool({
      description: d.describeTable,
      inputSchema: TOOL_SCHEMAS.describeTable,
      execute: async ({ table }) => describeTable(table),
    }),
    runQuery: tool({
      description: d.runQuery,
      inputSchema: TOOL_SCHEMAS.runQuery,
      execute: async ({ sql }) => {
        const res = tryRunSql(sql);
        if ("error" in res) return res;
        return {
          columns: res.columns,
          rows: res.rows.slice(0, ROWS_SHOWN_TO_MODEL),
          rowCount: res.rowCount,
          truncated: res.truncated || res.rowCount > ROWS_SHOWN_TO_MODEL,
        };
      },
    }),
    submitAnswer: tool({
      description: d.submitAnswer,
      inputSchema: TOOL_SCHEMAS.submitAnswer,
      execute: async () => ({ ok: true }),
    }),
  };
}

export type AnalystTools = ReturnType<typeof makeTools>;

/** Stable, serializable view of the tool surface (used for fingerprinting). */
export function toolSpec(descriptions: Partial<ToolDescriptions> = {}) {
  const d = { ...TOOL_DESCRIPTIONS, ...descriptions };
  return Object.fromEntries(
    Object.entries(TOOL_SCHEMAS).map(([name, schema]) => [
      name,
      { description: d[name as keyof ToolDescriptions], inputSchema: z.toJSONSchema(schema) },
    ]),
  );
}
