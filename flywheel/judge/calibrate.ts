// Calibrate the LLM judge against human labels: run the judge on every labeled
// output and report how often they agree (exact, within-one, quadratic-weighted
// Cohen's kappa with bootstrap CI, confusion matrix, binary pass/fail agreement).
// Reported separately on the dev split (where you tune the judge prompt) and the
// held-out test split (the number you trust).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { judgeAnswer, labelIndex, JUDGE_LABELS, type JudgeLabel } from "../../evals/scorers/judge";
import { config } from "../config";
import { judgeHash } from "../fingerprint";
import { bootstrapCI, confusionMatrix, weightedKappa } from "../metrics/stats";
import { judgeModel, judgeModelId } from "../models";
import { CALIBRATION_PATH, STATE_DIR } from "../paths";
import { pct, num } from "../report";
import { loadLabels, type HumanLabel } from "../label/store";
import type { Calibration, SplitMetrics } from "./trust";

const M = JUDGE_LABELS.length;
const PASS_IDX = labelIndex("acceptable");

export function splitMetrics(pairs: { human: JudgeLabel; judge: JudgeLabel }[]): SplitMetrics {
  const h = pairs.map((p) => labelIndex(p.human));
  const j = pairs.map((p) => labelIndex(p.judge));
  const n = pairs.length;
  const exact = n ? pairs.filter((_, i) => h[i] === j[i]).length / n : NaN;
  const withinOne = n ? pairs.filter((_, i) => Math.abs(h[i] - j[i]) <= 1).length / n : NaN;
  const kappaOf = (idx: number[]) => weightedKappa(idx.map((i) => h[i]), idx.map((i) => j[i]), M);
  const all = pairs.map((_, i) => i);
  const humanPass = h.map((x) => x >= PASS_IDX);
  const judgePass = j.map((x) => x >= PASS_IDX);
  const pos = humanPass.filter(Boolean).length;
  const neg = n - pos;
  return {
    n,
    exact,
    withinOne,
    kappa: n ? kappaOf(all) : NaN,
    kappaCI: n ? bootstrapCI(all, kappaOf) : [NaN, NaN],
    confusion: confusionMatrix(h, j, M),
    binary: {
      agreement: n ? humanPass.filter((p, i) => p === judgePass[i]).length / n : NaN,
      tpr: pos ? humanPass.filter((p, i) => p && judgePass[i]).length / pos : NaN,
      tnr: neg ? humanPass.filter((p, i) => !p && !judgePass[i]).length / neg : NaN,
    },
  };
}

/** Judge verdicts are cached per (judge hash, output hash): re-calibrating only judges new labels. */
function cachePath(hash: string) {
  return join(STATE_DIR, `judge-cache-${hash}.json`);
}

export async function calibrate({ mock, labels = loadLabels(), out = CALIBRATION_PATH }: { mock: boolean; labels?: HumanLabel[]; out?: string }): Promise<Calibration> {
  if (!labels.length) throw new Error("No human labels yet. Run `npm run label` first.");
  const modelId = judgeModelId(mock);
  const hash = judgeHash(modelId);
  const model = judgeModel(mock);
  const cp = cachePath(hash);
  const cache: Record<string, JudgeLabel> = existsSync(cp) ? JSON.parse(readFileSync(cp, "utf-8")) : {};

  const pairs: { split: "dev" | "test"; human: JudgeLabel; judge: JudgeLabel }[] = [];
  for (const l of labels) {
    cache[l.outputHash] ??= (await judgeAnswer(model, l)).label;
    pairs.push({ split: l.split, human: l.label, judge: cache[l.outputHash] });
  }
  mkdirSync(dirname(cp), { recursive: true });
  writeFileSync(cp, JSON.stringify(cache));

  const cal: Calibration = {
    createdAt: new Date().toISOString(),
    judgeHash: hash,
    judgeModel: modelId,
    labels: labels.length,
    dev: splitMetrics(pairs.filter((p) => p.split === "dev")),
    test: splitMetrics(pairs.filter((p) => p.split === "test")),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(cal, null, 1));
  return cal;
}

export function renderCalibration(cal: Calibration): string {
  const trusted = cal.test.n >= config.judge.minTestLabels && cal.test.kappa >= config.judge.minKappa;
  const row = (name: string, m: SplitMetrics) =>
    `| ${name} | ${m.n} | ${pct(m.exact)} | ${pct(m.withinOne)} | ${Number.isNaN(m.kappa) ? "–" : `${num(m.kappa)} (${num(m.kappaCI[0])}–${num(m.kappaCI[1])})`} | ${pct(m.binary.agreement)} | ${pct(m.binary.tpr)} / ${pct(m.binary.tnr)} |`;
  const cm = cal.test.confusion;
  return [
    `## Judge calibration: \`${cal.judgeModel}\` (judge hash \`${cal.judgeHash}\`)`,
    "",
    `${trusted ? "✅ **Trusted**" : "⚠️ **Not trusted yet**"}: needs held-out κ ≥ ${config.judge.minKappa} on ≥ ${config.judge.minTestLabels} labels. Until then the judge is reported but excluded from pass/fail and the CI gate.`,
    "",
    "| Split | Labels | Exact agreement | Within one grade | Weighted κ (95% CI) | Pass/fail agreement | Judge TPR / TNR |",
    "|---|---:|---:|---:|---:|---:|---:|",
    row("dev (tune here)", cal.dev),
    row("**test (held out)**", cal.test),
    "",
    "Confusion matrix (test split; rows = human, columns = judge):",
    "",
    `| human \\ judge | ${JUDGE_LABELS.join(" | ")} |`,
    `|---|${JUDGE_LABELS.map(() => "---:").join("|")}|`,
    ...JUDGE_LABELS.map((l, i) => `| ${l} | ${(cm[i] ?? []).join(" | ")} |`),
  ].join("\n");
}
