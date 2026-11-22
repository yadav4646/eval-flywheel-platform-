// Execution accuracy: does the agent's result set equal the gold result set?
//
// - Row order is ignored (ties make order ambiguous; top-N membership comes from LIMIT).
// - Column names and order are ignored; extra columns in the prediction are allowed
//   (e.g. returning id + name when gold returns name).
// - Numbers match at the coarser of the two values' displayed precision, so
//   ROUND(x, 2) vs an unrounded x, or 7.09 vs 7.1, both count as equal.
// - Ambiguous cases pass if the result matches ANY acceptable interpretation.

import type { Cell, QueryResult } from "../../agent/db";
import type { Scorer } from "./types";

function decimals(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const s = n.toString();
  if (s.includes("e")) return 6;
  return Math.min(6, s.split(".")[1]?.length ?? 0);
}

function asNumber(v: Cell): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  if (a === null || b === null) return a === b;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) {
    const tol = 0.5 * 10 ** -Math.min(decimals(na), decimals(nb)) + 1e-9;
    return Math.abs(na - nb) <= tol;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function sortKey(v: Cell): string {
  if (v === null) return "0:";
  const n = asNumber(v);
  return n !== null ? `1:${n.toFixed(6).padStart(24, "0")}` : `2:${String(v).trim().toLowerCase()}`;
}

function sortedColumn(rows: Cell[][], col: number): Cell[] {
  return rows.map((r) => r[col]).sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
}

function multisetEqual(a: Cell[], b: Cell[]) {
  return a.length === b.length && a.every((v, i) => cellsEqual(v, b[i]));
}

function rowsEqualAsMultiset(a: Cell[][], b: Cell[][]): boolean {
  if (a.length !== b.length) return false;
  const used = new Array(b.length).fill(false);
  outer: for (const ra of a) {
    for (let j = 0; j < b.length; j++) {
      if (!used[j] && ra.length === b[j].length && ra.every((v, k) => cellsEqual(v, b[j][k]))) {
        used[j] = true;
        continue outer;
      }
    }
    return false;
  }
  return true;
}

/** Returns true if `pred` contains `gold` up to column renaming/reordering and row order. */
export function resultsMatch(pred: Pick<QueryResult, "rows">, gold: Pick<QueryResult, "rows">): boolean {
  if (pred.rows.length !== gold.rows.length) return false;
  if (gold.rows.length === 0) return true;
  const g = gold.rows[0].length;
  const p = pred.rows[0].length;
  if (p < g) return false;

  // Candidate pred columns for each gold column: same multiset of values.
  const goldCols = Array.from({ length: g }, (_, j) => sortedColumn(gold.rows, j));
  const predCols = Array.from({ length: p }, (_, i) => sortedColumn(pred.rows, i));
  const candidates = goldCols.map((gc) => predCols.map((pc, i) => (multisetEqual(gc, pc) ? i : -1)).filter((i) => i >= 0));
  if (candidates.some((c) => c.length === 0)) return false;

  // Backtrack over injective column assignments (tiny search in practice).
  const assignment: number[] = [];
  const taken = new Set<number>();
  const search = (j: number): boolean => {
    if (j === g) {
      const projected = pred.rows.map((r) => assignment.map((i) => r[i]));
      return rowsEqualAsMultiset(projected, gold.rows);
    }
    for (const i of candidates[j]) {
      if (taken.has(i)) continue;
      taken.add(i);
      assignment[j] = i;
      if (search(j + 1)) return true;
      taken.delete(i);
    }
    return false;
  };
  return search(0);
}

/** Index of the first gold interpretation the output matches, or -1. */
export function matchedInterpretation(output: { rows: Cell[][]; error?: string; sql: string }, gold: QueryResult[]): number {
  if (output.error || !output.sql.trim()) return -1;
  return gold.findIndex((g) => resultsMatch(output, g));
}

export const resultMatch: Scorer = ({ testCase, output, gold }) => {
  if (testCase.goldSql === null) return null;
  if (!output.sql.trim()) return { name: "resultMatch", score: 0, metadata: { reason: "no SQL submitted" } };
  if (output.error) return { name: "resultMatch", score: 0, metadata: { reason: "SQL error" } };
  const idx = matchedInterpretation(output, gold);
  return {
    name: "resultMatch",
    score: idx >= 0 ? 1 : 0,
    metadata: {
      interpretation: idx,
      predRows: output.rows.length,
      goldRows: gold[0]?.rows.length,
      predCols: output.columns,
      goldCols: gold[0]?.columns,
    },
  };
};
