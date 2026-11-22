// The on-disk format of an eval run (results/<runId>.json, reports/baseline*.json).
// Stores every trial's output so later steps (attribution re-scoring, labeling,
// calibration) work from recorded outputs instead of re-running the agent.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Cell } from "../agent/db";
import type { GoldenCase } from "../evals/dataset";
import type { JudgeLabel } from "../evals/scorers/judge";
import { config } from "./config";
import type { Fingerprint } from "./fingerprint";
import type { RunSummary } from "./metrics/summary";
import { RESULTS_DIR } from "./paths";

export const ROW_PREVIEW = 20;

export interface StoredOutput {
  sql: string;
  answer: string;
  columns: string[];
  /** First ROW_PREVIEW rows. The full result is reproducible: the DB is deterministic. */
  rows: Cell[][];
  rowCount: number;
  error?: string;
  submitted: boolean;
  steps: number;
  queries: number;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface TrialRecord {
  trial: number;
  output: StoredOutput;
  outputHash: string;
  scores: Record<string, number | null>;
  judge?: { label: JudgeLabel; reasoning: string };
  pass: boolean;
}

export interface CaseRecord {
  id: string;
  question: string;
  suite: GoldenCase["suite"];
  status: GoldenCase["status"];
  tags: GoldenCase["tags"];
  trials: TrialRecord[];
}

export interface JudgeTrust {
  enabled: boolean;
  /** True when a calibration for this exact judge (prompt + model hash) met the kappa bar. */
  trusted: boolean;
  kappa?: number;
  reason: string;
}

export interface RunFile {
  runId: string;
  createdAt: string;
  label?: string;
  mode: "mock" | "real";
  k: number;
  fingerprint: Fingerprint;
  judge: JudgeTrust;
  experimentUrl?: string;
  cases: CaseRecord[];
  summary: RunSummary;
}

/** The per-trial pass rule (thresholds in config.pass). null scores are "not applicable". */
export function trialPasses(scores: Record<string, number | null>, judgeTrusted: boolean): boolean {
  const p = config.pass;
  const ok = (name: string, min: number) => scores[name] === null || scores[name] === undefined || (scores[name] as number) >= min;
  return (
    ok("executes", p.executes) &&
    ok("resultMatch", p.resultMatch) &&
    ok("refusal", p.refusal) &&
    ok("answerGrounded", p.answerGrounded) &&
    (!judgeTrusted || ok("judge", p.judge))
  );
}

export function saveRun(run: RunFile, path?: string): string {
  const out = path ?? join(RESULTS_DIR, `${run.runId}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(run, null, 1));
  return out;
}

export function loadRun(path: string): RunFile {
  return JSON.parse(readFileSync(path, "utf-8")) as RunFile;
}

export function latestRunPath(): string | undefined {
  if (!existsSync(RESULTS_DIR)) return undefined;
  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json")).sort();
  return files.length ? join(RESULTS_DIR, files[files.length - 1]) : undefined;
}
