// The k-trial eval runner. Every case runs k times; every trial is scored by the
// code scorers (+ the LLM judge) and gets a pass/fail. With BRAINTRUST_API_KEY the
// run is also a Braintrust experiment (trialCount = k) tagged with the fingerprint;
// without it the same code runs locally. Either way a results file is written.

import { createHash } from "node:crypto";
import { Eval } from "braintrust";
import type { LanguageModel } from "ai";
import { runAgent, type AgentOutput } from "../agent/agent";
import type { ToolDescriptions } from "../agent/tools";
import { loadGolden, filterCases, type CaseFilter, type GoldenCase } from "../evals/dataset";
import { scoreWithCode, goldResults } from "../evals/scorers";
import { judgeAnswer } from "../evals/scorers/judge";
import { config } from "./config";
import { fingerprint, type Fingerprint } from "./fingerprint";
import { summarize } from "./metrics/summary";
import { resetMockTrials } from "./mock/model";
import { agentModel, agentModelId, judgeModel, judgeModelId } from "./models";
import { judgeTrust } from "./judge/trust";
import { ROW_PREVIEW, trialPasses, type CaseRecord, type JudgeTrust, type RunFile, type StoredOutput, type TrialRecord } from "./results";

export interface RunOptions {
  mock: boolean;
  k: number;
  filter?: CaseFilter;
  cases?: GoldenCase[];
  judge?: boolean;
  label?: string;
  /** Send to Braintrust as an experiment (default: when BRAINTRUST_API_KEY is set and not mock). */
  sendLogs?: boolean;
  /** Overrides for ablation (attribution) runs. */
  systemPrompt?: string;
  toolDescriptions?: Partial<ToolDescriptions>;
  modelId?: string;
  concurrency?: number;
  quiet?: boolean;
}

export function toStored(o: AgentOutput): StoredOutput {
  return {
    sql: o.sql,
    answer: o.answer,
    columns: o.columns,
    rows: o.rows.slice(0, ROW_PREVIEW),
    rowCount: o.rows.length,
    error: o.error,
    submitted: o.submitted,
    steps: o.steps,
    queries: o.queries,
    durationMs: o.durationMs,
    usage: o.usage,
  };
}

export const hashOutput = (o: Pick<StoredOutput, "sql" | "answer">) =>
  createHash("sha256").update(`${o.sql}\n<>\n${o.answer}`).digest("hex").slice(0, 16);

interface TrialDeps {
  model: LanguageModel;
  judge?: LanguageModel;
  judgeTrusted: boolean;
  systemPrompt?: string;
  toolDescriptions?: Partial<ToolDescriptions>;
}

export async function runTrial(tc: GoldenCase, trial: number, deps: TrialDeps): Promise<TrialRecord> {
  const out = await runAgent({ question: tc.question, model: deps.model, system: deps.systemPrompt, toolDescriptions: deps.toolDescriptions });
  const code = scoreWithCode(tc, out);
  const scores: Record<string, number | null> = Object.fromEntries(Object.entries(code).map(([k, v]) => [k, v?.score ?? null]));
  let judge: TrialRecord["judge"];
  if (deps.judge) {
    try {
      const v = await judgeAnswer(deps.judge, { question: tc.question, sql: out.sql, columns: out.columns, rows: out.rows, answer: out.answer, error: out.error });
      scores.judge = v.score;
      judge = { label: v.label, reasoning: v.reasoning };
    } catch (e) {
      scores.judge = null;
      judge = undefined;
      if (process.env.DEBUG) console.error("judge failed:", e);
    }
  }
  const stored = toStored(out);
  return { trial, output: stored, outputHash: hashOutput(stored), scores, judge, pass: trialPasses(scores, deps.judgeTrusted) };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}

export async function runEval(opts: RunOptions): Promise<RunFile> {
  const { mock, k } = opts;
  if (mock) resetMockTrials();
  const cases = opts.cases ?? filterCases(loadGolden(), opts.filter);
  if (!cases.length) throw new Error("No cases matched the filter.");
  cases.forEach(goldResults); // fail fast if a gold query is broken

  const modelId = agentModelId(mock, opts.modelId);
  const fp: Fingerprint = fingerprint({
    model: modelId,
    judgeModel: judgeModelId(mock),
    systemPrompt: opts.systemPrompt,
    toolDescriptions: opts.toolDescriptions as Record<string, string> | undefined,
  });
  const judgeEnabled = opts.judge ?? true;
  const trust: JudgeTrust = judgeTrust(fp.hashes.judge, judgeEnabled);
  const deps: TrialDeps = {
    model: agentModel(mock, opts.modelId),
    judge: judgeEnabled ? judgeModel(mock) : undefined,
    judgeTrusted: trust.trusted,
    systemPrompt: opts.systemPrompt,
    toolDescriptions: opts.toolDescriptions,
  };
  const log = (s: string) => !opts.quiet && process.stderr.write(s);
  const records = new Map<string, TrialRecord[]>(cases.map((c) => [c.id, []]));
  const sendLogs = opts.sendLogs ?? (!mock && !!process.env.BRAINTRUST_API_KEY);
  let experimentUrl: string | undefined;

  log(`Running ${cases.length} cases x ${k} trials (${mock ? "mock" : modelId}${sendLogs ? ", logging to Braintrust" : ", local"})\n`);

  if (sendLogs) {
    // One Braintrust experiment; the task computes the full trial record so the
    // dashboard and our local metrics are computed from identical data.
    const scoreNames = ["executes", "resultMatch", "answerGrounded", "refusal", "efficiency", "judge", "pass"];
    const res = await Eval<GoldenCase, TrialRecord, GoldenCase, Record<string, unknown>>(config.braintrustProject, {
      experimentName: opts.label ?? `${fp.git.branch ?? "local"}@${fp.git.sha ?? "nogit"}${fp.git.dirty ? "+dirty" : ""}`,
      data: () => cases.map((c) => ({ input: c, expected: c, metadata: { id: c.id, suite: c.suite, status: c.status, ...c.tags } })),
      task: async (tc, hooks) => runTrial(tc, hooks.trialIndex, deps),
      scores: scoreNames.map((name) => ({ output }: { output: TrialRecord }) => {
        const v = name === "pass" ? (output.pass ? 1 : 0) : output.scores[name];
        return v === null || v === undefined ? null : { name, score: v };
      }),
      trialCount: k,
      maxConcurrency: opts.concurrency ?? config.eval.maxConcurrency,
      metadata: { k, fingerprint: fp.hashes, git: fp.git, judge: trust },
    });
    experimentUrl = res.summary.experimentUrl;
    for (const r of res.results) {
      const id = (r.metadata as { id: string }).id;
      if (r.output) records.get(id)!.push(r.output);
    }
  } else {
    const jobs = cases.flatMap((c) => Array.from({ length: k }, (_, t) => ({ c, t })));
    let done = 0;
    await pool(jobs, opts.concurrency ?? config.eval.maxConcurrency, async ({ c, t }) => {
      records.get(c.id)!.push(await runTrial(c, t, deps));
      done++;
      if (done % 10 === 0 || done === jobs.length) log(`  ${done}/${jobs.length} trials\r`);
    });
    log("\n");
  }

  const caseRecords: CaseRecord[] = cases.map((c) => ({
    id: c.id,
    question: c.question,
    suite: c.suite,
    status: c.status,
    tags: c.tags,
    trials: records.get(c.id)!.sort((a, b) => a.trial - b.trial),
  }));
  const createdAt = new Date().toISOString();
  return {
    runId: `${createdAt.replace(/[:.]/g, "-")}-${mock ? "mock" : "real"}-${fp.git.sha ?? "nogit"}`,
    createdAt,
    label: opts.label,
    mode: mock ? "mock" : "real",
    k,
    fingerprint: fp,
    judge: trust,
    experimentUrl,
    cases: caseRecords,
    summary: summarize(caseRecords),
  };
}
