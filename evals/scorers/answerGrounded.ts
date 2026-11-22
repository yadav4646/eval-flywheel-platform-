// Does the plain-English answer state the right values? Checks the gold result's
// key values (first rows of the matched interpretation) against the answer text.
// Catches "correct SQL, wrong/hallucinated summary" and "rounded to the wrong unit".

import type { Cell } from "../../agent/db";
import { matchedInterpretation } from "./resultMatch";
import type { Scorer } from "./types";

const MAX_ROWS_CHECKED = 3;
const MAX_COLS_CHECKED = 3;

export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function mentioned(value: Cell, answer: string, nums: number[]): boolean {
  if (value === null) return true;
  if (typeof value === "number") {
    // Accept rounding to whole units or 1 decimal, and 0.5% relative slack.
    return nums.some((n) => Math.abs(n - value) <= Math.max(0.5, Math.abs(value) * 0.005));
  }
  const s = String(value).trim().toLowerCase();
  if (!s) return true;
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return true; // dates get reworded ("March 2025"); don't penalize
  return answer.toLowerCase().includes(s);
}

export const answerGrounded: Scorer = ({ testCase, output, gold }) => {
  if (testCase.goldSql === null || gold.length === 0) return null;
  const idx = Math.max(0, matchedInterpretation(output, gold));
  const g = gold[idx];
  if (g.rows.length === 0) return null;
  const cells = g.rows.slice(0, MAX_ROWS_CHECKED).flatMap((r) => r.slice(0, MAX_COLS_CHECKED));
  const nums = numbersIn(output.answer);
  const missing = cells.filter((c) => !mentioned(c, output.answer, nums));
  return {
    name: "answerGrounded",
    score: cells.length ? (cells.length - missing.length) / cells.length : 1,
    metadata: { checked: cells.length, missing: missing.slice(0, 5) },
  };
};
