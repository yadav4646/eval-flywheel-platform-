// Did the final SQL run? (Read-only enforcement happens in agent/db.ts; a write
// attempt surfaces here as an error.)
import type { Scorer } from "./types";

export const executes: Scorer = ({ testCase, output }) => {
  const hasSql = output.sql.trim().length > 0;
  if (testCase.goldSql === null && !hasSql) return null; // correctly declined: nothing to execute
  if (!hasSql) return { name: "executes", score: 0, metadata: { reason: "no SQL submitted" } };
  if (output.error) return { name: "executes", score: 0, metadata: { reason: output.error } };
  return { name: "executes", score: 1, metadata: { rows: output.rows.length } };
};
