import { describe, expect, it } from "vitest";
import { cellsEqual, resultsMatch } from "../evals/scorers/resultMatch";
import { answerGrounded, numbersIn } from "../evals/scorers/answerGrounded";
import { refusal } from "../evals/scorers/refusal";
import { executes } from "../evals/scorers/executes";
import { scoreWithCode } from "../evals/scorers";
import { loadGolden, type GoldenCase } from "../evals/dataset";
import type { ScorableOutput } from "../evals/scorers/types";

const gold = { rows: [["Books", 21825.73], ["Electronics", 886877.49]] };

describe("resultsMatch", () => {
  it("ignores row order", () => {
    expect(resultsMatch({ rows: [["Electronics", 886877.49], ["Books", 21825.73]] }, gold)).toBe(true);
  });
  it("ignores column order and names, allows extra columns", () => {
    expect(resultsMatch({ rows: [[886877.49, "Electronics", 5], [21825.73, "Books", 4]] }, gold)).toBe(true);
  });
  it("tolerates rounding at the coarser precision", () => {
    expect(resultsMatch({ rows: [["Books", 21825.7311], ["Electronics", 886877.4899]] }, gold)).toBe(true);
    expect(resultsMatch({ rows: [["Books", 21826], ["Electronics", 886877]] }, gold)).toBe(true);
    expect(cellsEqual(7.09, 7.1)).toBe(true);
  });
  it("rejects wrong values, missing rows, and missing columns", () => {
    expect(resultsMatch({ rows: [["Books", 2182573], ["Electronics", 88687749]] }, gold)).toBe(false); // cents, not dollars
    expect(resultsMatch({ rows: [["Books", 21825.73]] }, gold)).toBe(false);
    expect(resultsMatch({ rows: [["Books"], ["Electronics"]] }, gold)).toBe(false);
  });
  it("is case-insensitive for strings and matches numeric strings", () => {
    expect(cellsEqual("books", "Books")).toBe(true);
    expect(cellsEqual("42", 42)).toBe(true);
    expect(cellsEqual(null, null)).toBe(true);
    expect(cellsEqual(null, 0)).toBe(false);
  });
});

const tc = (over: Partial<GoldenCase> = {}): GoldenCase => ({
  id: "t",
  question: "q",
  goldSql: "SELECT 55 AS customers",
  acceptableSql: [],
  tags: { kind: "filter", difficulty: "easy", topics: [] },
  suite: "regression",
  status: "reviewed",
  provenance: { source: "handwritten", createdAt: "2026-01-01" },
  ...over,
});
const out = (over: Partial<ScorableOutput> = {}): ScorableOutput => ({ sql: "SELECT 55", answer: "There are 55 customers.", columns: ["n"], rows: [[55]], submitted: true, steps: 3, queries: 1, ...over });

describe("answerGrounded", () => {
  it("parses formatted numbers", () => {
    expect(numbersIn("Revenue was $449,039.47 (up 3.5%)")).toEqual([449039.47, 3.5]);
  });
  it("scores the fraction of gold values mentioned", () => {
    const g = [{ columns: ["c", "v"], rows: [["Books", 10], ["Audio", 20]], rowCount: 2, truncated: false }];
    expect(answerGrounded({ testCase: tc(), output: out({ answer: "Books 10, Audio 20" }), gold: g })?.score).toBe(1);
    expect(answerGrounded({ testCase: tc(), output: out({ answer: "Books leads." }), gold: g })?.score).toBe(0.25);
  });
});

describe("refusal / executes", () => {
  it("rewards declining unanswerable questions, ignores answerable ones", () => {
    const un = tc({ goldSql: null });
    expect(refusal({ testCase: un, output: out({ sql: "", rows: [], answer: "The database doesn't contain marketing data." }), gold: [] })?.score).toBe(1);
    expect(refusal({ testCase: un, output: out({ answer: "The conversion rate is 12%." }), gold: [] })?.score).toBe(0);
    expect(refusal({ testCase: tc(), output: out(), gold: [] })).toBeNull();
  });
  it("executes: null when correctly declining, 0 on error", () => {
    expect(executes({ testCase: tc({ goldSql: null }), output: out({ sql: "" }), gold: [] })).toBeNull();
    expect(executes({ testCase: tc(), output: out({ error: "no such column" }), gold: [] })?.score).toBe(0);
  });
});

describe("golden dataset", () => {
  it("every gold and acceptable query executes and returns rows", () => {
    for (const c of loadGolden()) {
      const res = scoreWithCode(c, out({ sql: c.goldSql ?? "", rows: [], answer: "" }));
      expect(res).toBeTruthy();
    }
  });
  it("gold SQL scores itself as a match", async () => {
    const { runSql } = await import("../agent/db");
    for (const c of loadGolden().filter((g) => g.goldSql)) {
      const r = runSql(c.goldSql!);
      const s = scoreWithCode(c, out({ sql: c.goldSql!, columns: r.columns, rows: r.rows }));
      expect(s.resultMatch?.score, c.id).toBe(1);
    }
  });
});
