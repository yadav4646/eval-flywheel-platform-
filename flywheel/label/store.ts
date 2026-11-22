import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Cell } from "../../agent/db";
import type { JudgeLabel } from "../../evals/scorers/judge";
import { LABELS_PATH } from "../paths";

/** One human judgment. Carries a snapshot of what was judged, so calibration never depends on old results files. */
export interface HumanLabel {
  outputHash: string;
  caseId: string;
  runId: string;
  question: string;
  sql: string;
  columns: string[];
  rows: Cell[][];
  answer: string;
  error?: string;
  label: JudgeLabel;
  labeler: string;
  labeledAt: string;
  notes?: string;
  split: "dev" | "test";
}

/** Stable 50/50 split by output hash: iterate the judge prompt on dev, report agreement on test. */
export const splitFor = (outputHash: string): "dev" | "test" => (parseInt(outputHash.slice(0, 8), 16) % 2 === 0 ? "dev" : "test");

export function loadLabels(path = LABELS_PATH): HumanLabel[] {
  if (!existsSync(path)) return [];
  const all = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HumanLabel);
  // Last label wins if an output was relabeled.
  return [...new Map(all.map((l) => [l.outputHash, l])).values()];
}

export function appendLabel(label: HumanLabel, path = LABELS_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(label) + "\n");
}
