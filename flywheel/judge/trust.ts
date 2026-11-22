// Is the LLM judge trustworthy enough to count? Only if a calibration exists for
// this exact judge (same prompt + model hash) and its held-out kappa clears the bar.

import { existsSync, readFileSync } from "node:fs";
import { config } from "../config";
import { CALIBRATION_PATH } from "../paths";
import type { JudgeTrust } from "../results";

export interface SplitMetrics {
  n: number;
  exact: number;
  withinOne: number;
  kappa: number;
  kappaCI: [number, number];
  confusion: number[][]; // rows = human, cols = judge (wrong..great)
  binary: { agreement: number; tpr: number; tnr: number }; // pass = >= acceptable
}

export interface Calibration {
  createdAt: string;
  judgeHash: string;
  judgeModel: string;
  labels: number;
  dev: SplitMetrics;
  test: SplitMetrics;
}

export function loadCalibration(path = CALIBRATION_PATH): Calibration | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as Calibration;
}

export function judgeTrust(judgeHash: string, enabled: boolean, path = CALIBRATION_PATH): JudgeTrust {
  if (!enabled) return { enabled, trusted: false, reason: "judge disabled for this run" };
  const cal = loadCalibration(path);
  if (!cal) return { enabled, trusted: false, reason: "no calibration yet: label outputs (`npm run label`) then `npm run judge:calibrate`" };
  if (cal.judgeHash !== judgeHash)
    return { enabled, trusted: false, kappa: cal.test.kappa, reason: "judge prompt or model changed since the last calibration; re-run `npm run judge:calibrate`" };
  if (cal.test.n < config.judge.minTestLabels)
    return { enabled, trusted: false, kappa: cal.test.kappa, reason: `only ${cal.test.n} held-out labels (need ${config.judge.minTestLabels})` };
  if (!(cal.test.kappa >= config.judge.minKappa))
    return { enabled, trusted: false, kappa: cal.test.kappa, reason: `held-out kappa ${cal.test.kappa.toFixed(2)} < ${config.judge.minKappa}` };
  return { enabled, trusted: true, kappa: cal.test.kappa, reason: `calibrated: held-out kappa ${cal.test.kappa.toFixed(2)} on ${cal.test.n} labels` };
}
