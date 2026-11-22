import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GOLDEN_PATH } from "../flywheel/paths";
import { classify } from "../flywheel/curate/signals";
import { inferDifficulty, inferKind, toCase } from "../flywheel/curate/toCase";
import { runCuration, stratify } from "../flywheel/curate/curate";
import { dedupe, Embedder } from "../flywheel/curate/dedupe";
import { mockDrafterModel, mockEmbeddingModel } from "../flywheel/mock/model";
import { loadGolden, type GoldenCase } from "../evals/dataset";
import type { TraceRecord } from "../flywheel/curate/types";

const trace = (over: Partial<TraceRecord> = {}): TraceRecord => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  createdAt: "2026-11-22T10:00:00Z",
  question: "How many orders were returned in 2025?",
  output: { sql: "SELECT 1", answer: "1", rowCount: 1, submitted: true },
  scores: { executes: 1, nonempty_result: 1, submitted: 1 },
  metadata: { source: "prod", durationMs: 1000 },
  feedback: {},
  ...over,
});

describe("signals", () => {
  it("ranks a human correction above everything", () => {
    expect(classify(trace({ feedback: { correctedSql: "SELECT 1", rating: "down" }, scores: { executes: 0 } }))?.signal).toBe("user_correction");
    expect(classify(trace({ feedback: { rating: "down" } }))?.signal).toBe("thumbs_down");
    expect(classify(trace({ scores: { executes: 0 } }))?.signal).toBe("sql_error");
    expect(classify(trace({ scores: { executes: 1, nonempty_result: 0 } }))?.signal).toBe("empty_result");
    expect(classify(trace({ feedback: { rating: "up" } }))?.signal).toBe("thumbs_up");
  });
  it("samples normal traffic for coverage", () => {
    expect(classify(trace(), 0)).toBeNull();
    expect(classify(trace(), 1)?.signal).toBe("coverage");
  });
});

describe("toCase", () => {
  it("uses a user's corrected SQL as reviewed gold", async () => {
    const sql = "SELECT COUNT(*) FROM orders WHERE status = 'returned' AND strftime('%Y', order_date) = '2025'";
    const r = await toCase({ trace: trace({ feedback: { correctedSql: sql } }), signal: "user_correction", priority: 100 }, mockDrafterModel());
    expect(r.ok && r.case.goldSql).toBe(sql);
    expect(r.ok && r.case.status).toBe("reviewed");
    expect(r.ok && r.case.tags.kind).toBe("date");
  });
  it("drafts gold for other signals and marks it a candidate", async () => {
    const r = await toCase({ trace: trace({ scores: { executes: 0 } }), signal: "sql_error", priority: 60 }, mockDrafterModel());
    expect(r.ok && r.case.status).toBe("candidate");
    expect(r.ok && r.case.provenance.goldFrom).toBe("llm_draft");
  });
  it("rejects gold SQL that fails", async () => {
    const r = await toCase({ trace: trace({ feedback: { correctedSql: "SELECT nope FROM orders" } }), signal: "user_correction", priority: 100 }, mockDrafterModel());
    expect(r.ok).toBe(false);
  });
  it("infers kind and difficulty from SQL", () => {
    expect(inferKind(null)).toBe("unanswerable");
    expect(inferKind("SELECT a, ROW_NUMBER() OVER (ORDER BY a) FROM t")).toBe("window");
    expect(inferKind("SELECT COUNT(*) FROM a JOIN b ON 1")).toBe("join");
    expect(inferDifficulty("SELECT name FROM products")).toBe("easy");
    expect(inferDifficulty("WITH x AS (SELECT 1) SELECT * FROM a JOIN b ON 1 JOIN c ON 1 GROUP BY 1 HAVING 1")).toBe("hard");
  });
});

describe("dedupe", () => {
  it("drops exact and near-verbatim repeats, keeps new questions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const e = new Embedder(mockEmbeddingModel(), "mock", join(dir, "cache.json"));
    const items = ["How many customers are in Germany?", "how many customers are in germany", "Which warehouse ships most?"];
    const r = await dedupe(items, (x) => x, ["How many customers are in Germany?"], e, 0.92);
    expect(r.kept).toEqual(["Which warehouse ships most?"]);
    expect(r.dropped).toHaveLength(2);
  });
});

describe("stratify", () => {
  it("caps the batch and spreads it across kinds", () => {
    const mk = (id: string, kind: GoldenCase["tags"]["kind"], priority: number) => ({ c: { id, tags: { kind } } as GoldenCase, priority });
    const out = stratify([mk("a1", "join", 60), mk("a2", "join", 60), mk("a3", "join", 60), mk("b1", "date", 50), mk("c1", "filter", 10)], 3);
    expect(out.map((c) => c.id)).toEqual(["a1", "b1", "c1"]);
  });
});

describe("runCuration", () => {
  it("promotes new cases into the golden file and skips duplicates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-"));
    const goldenPath = join(dir, "golden.jsonl");
    writeFileSync(goldenPath, readFileSync(GOLDEN_PATH));
    const before = loadGolden(goldenPath).length;
    const traces = [
      trace({ id: "t1", question: "How many customers are in Germany?", feedback: { rating: "down" } }), // exact duplicate of a golden case
      trace({ id: "t2", question: "How many orders were returned in 2025?", feedback: { correctedSql: "SELECT COUNT(*) AS n FROM orders WHERE status = 'returned' AND order_date >= '2025-01-01'" } }),
      trace({ id: "t3", question: "Which warehouse ships the most orders?", scores: { executes: 0 } }),
    ];
    const r = await runCuration({ mock: true, traces, goldenPath, maxNew: 10 });
    expect(r.duplicates.map((d) => d.question)).toContain("How many customers are in Germany?");
    expect(r.promoted.map((c) => c.question).sort()).toEqual(["How many orders were returned in 2025?", "Which warehouse ships the most orders?"]);
    const after = loadGolden(goldenPath);
    expect(after.length).toBe(before + 2);
    const unans = after.find((c) => c.question.startsWith("Which warehouse"))!;
    expect(unans.goldSql).toBeNull();
    expect(unans.status).toBe("candidate");
  });
});
