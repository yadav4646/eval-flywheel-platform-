import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calibrate, splitMetrics } from "../flywheel/judge/calibrate";
import { judgeTrust } from "../flywheel/judge/trust";
import { judgeHash } from "../flywheel/fingerprint";
import { judgeModelId } from "../flywheel/models";
import { sampleForLabeling } from "../flywheel/label/cli";
import { splitFor, type HumanLabel } from "../flywheel/label/store";
import { runEval } from "../flywheel/run";
import { loadGolden } from "../evals/dataset";

describe("splitMetrics", () => {
  it("computes agreement, kappa and binary pass/fail agreement", () => {
    const m = splitMetrics([
      { human: "great", judge: "great" },
      { human: "acceptable", judge: "great" },
      { human: "weak", judge: "weak" },
      { human: "wrong", judge: "weak" },
    ]);
    expect(m.exact).toBe(0.5);
    expect(m.withinOne).toBe(1);
    expect(m.binary.agreement).toBe(1);
    expect(m.kappa).toBeGreaterThan(0.5);
  });
});

describe("labeling + calibration", () => {
  it("samples unlabeled outputs across judge buckets and calibrates against labels", async () => {
    const run = await runEval({ mock: true, k: 2, cases: loadGolden().slice(0, 12), judge: true, sendLogs: false, quiet: true });
    const items = sampleForLabeling(run, new Set(), 10);
    expect(items.length).toBe(10);
    expect(new Set(items.map((i) => i.outputHash)).size).toBe(10);
    // Fake "human" labels for the test only: agree with the judge except on a couple.
    const labels: HumanLabel[] = items.map((it, i) => ({
      ...it,
      label: i % 5 === 0 ? "wrong" : (it.judgeLabel ?? "acceptable"),
      labeler: "test",
      labeledAt: "2026-11-22",
      split: splitFor(it.outputHash),
    }));
    const out = join(mkdtempSync(join(tmpdir(), "cal-")), "cal.json");
    const cal = await calibrate({ mock: true, labels, out });
    expect(cal.dev.n + cal.test.n).toBe(10);
    expect(cal.judgeHash).toBe(judgeHash(judgeModelId(true)));
  });
});

describe("judgeTrust", () => {
  const write = (o: object) => {
    const p = join(mkdtempSync(join(tmpdir(), "trust-")), "cal.json");
    writeFileSync(p, JSON.stringify(o));
    return p;
  };
  const metrics = (n: number, kappa: number) => ({ n, kappa, exact: 0, withinOne: 0, kappaCI: [0, 0], confusion: [], binary: { agreement: 0, tpr: 0, tnr: 0 } });
  it("requires a calibration for this exact judge with enough labels and kappa", () => {
    expect(judgeTrust("h", true, "/nonexistent").trusted).toBe(false);
    expect(judgeTrust("h", true, write({ judgeHash: "other", test: metrics(50, 0.9) })).reason).toMatch(/changed/);
    expect(judgeTrust("h", true, write({ judgeHash: "h", test: metrics(5, 0.9) })).trusted).toBe(false);
    expect(judgeTrust("h", true, write({ judgeHash: "h", test: metrics(50, 0.4) })).trusted).toBe(false);
    expect(judgeTrust("h", true, write({ judgeHash: "h", test: metrics(50, 0.8) })).trusted).toBe(true);
  });
});
