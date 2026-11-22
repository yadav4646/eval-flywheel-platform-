// End-to-end in mock mode: the real agent loop, tools, SQL, scorers, metrics,
// gate and attribution, with deterministic mock models.

import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, BUSINESS_GLOSSARY } from "../agent/prompt";
import { loadGolden } from "../evals/dataset";
import { attribute } from "../flywheel/attribution/attribute";
import { gate } from "../flywheel/gate/gate";
import { runEval } from "../flywheel/run";
import type { RunFile } from "../flywheel/results";

const ids = ["filter-de-customers", "rev-total-2024", "rev-q4-2024", "rev-monthly-2025", "rev-aov", "agg-return-rate", "unans-conversion-rate", "rev-by-top-category"];
const cases = loadGolden().filter((c) => ids.includes(c.id));
const DEGRADED = SYSTEM_PROMPT.replace(BUSINESS_GLOSSARY, "Use sensible definitions for business metrics.");
const quiet = { mock: true, cases, judge: false, sendLogs: false, quiet: true } as const;

describe("k-trial runner", () => {
  it("is deterministic in mock mode and reports pass@k >= pass^k", async () => {
    const a = await runEval({ ...quiet, k: 5 });
    const b = await runEval({ ...quiet, k: 5 });
    expect(a.cases.map((c) => c.trials.map((t) => t.pass))).toEqual(b.cases.map((c) => c.trials.map((t) => t.pass)));
    const s = a.summary.overall;
    expect(s.trialsPerCase).toBe(5);
    expect(s.passAt[5]).toBeGreaterThanOrEqual(s.passAt[1]);
    expect(s.passHat[5]).toBeLessThanOrEqual(s.passAt[1]);
    expect(a.cases.every((c) => c.trials.length === 5)).toBe(true);
  });
});

describe("gate + attribution", () => {
  let base: RunFile;
  it("passes an unchanged agent and fails a degraded prompt", async () => {
    base = await runEval({ ...quiet, k: 5 });
    const same = await runEval({ ...quiet, k: 3 });
    expect(gate(same, base).passed).toBe(true);
    const degraded = await runEval({ ...quiet, k: 3, systemPrompt: DEGRADED });
    const v = gate(degraded, base);
    expect(v.passed).toBe(false);
    expect(v.checks.find((c) => c.name.startsWith("Per-case regressions (regression"))?.status).toBe("fail");
  });

  it("names the prompt when only the prompt changed", async () => {
    const head = await runEval({ ...quiet, k: 3, systemPrompt: DEGRADED });
    const r = await attribute(base, head);
    expect(r.changed).toEqual(["prompt"]);
    expect(r.measurementDelta).toBe(0);
    expect(r.behaviorDelta).toBeLessThan(0);
    expect(r.regressions.length).toBeGreaterThan(0);
    expect(r.ablations[0].component).toBe("prompt");
    expect(r.verdict).toMatch(/prompt change is the \*\*likely cause\*\*/);
  });

  it("separates prompt from model when both changed", async () => {
    const head = await runEval({ ...quiet, k: 3, systemPrompt: DEGRADED, modelId: "gpt-5.4-nano" });
    const r = await attribute(base, head);
    expect(r.changed).toEqual(expect.arrayContaining(["prompt", "model"]));
    expect(r.ablations.map((a) => a.component)).toEqual(expect.arrayContaining(["prompt", "model"]));
    expect(r.ablations[0].component).toBe("prompt"); // the glossary removal, not the model, broke revenue questions
  });

  it("attributes a gold-answer change to measurement, not behavior", async () => {
    // Someone "fixes" a gold query (here: wrongly) without touching the agent.
    const changed = cases.map((c) => (c.id === "filter-de-customers" ? { ...c, goldSql: "SELECT COUNT(*) AS customers FROM customers WHERE country = 'GB'" } : c));
    const head = await runEval({ ...quiet, k: 3, cases: changed });
    const r = await attribute(base, head, { golden: changed });
    expect(r.measurementFlips).toContain("filter-de-customers");
    expect(r.measurementDelta).toBeLessThan(0);
    expect(r.regressions.map((x) => x.id)).not.toContain("filter-de-customers"); // not blamed on the agent
    expect(r.verdict).toMatch(/Measurement effect/);
  });
});
