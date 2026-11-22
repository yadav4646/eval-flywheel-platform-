// Re-score a run's recorded outputs with the CURRENT scorers, dataset gold and
// judge. Comparing a base run to its re-scored self isolates measurement changes
// (scorer/gold/judge edits) from agent behavior changes. Cheap: no agent calls;
// the judge is only re-run if its hash changed.

import type { LanguageModel } from "ai";
import { tryRunSql } from "../../agent/db";
import { loadGolden, type GoldenCase } from "../../evals/dataset";
import { scoreWithCode } from "../../evals/scorers";
import { judgeAnswer } from "../../evals/scorers/judge";
import { trialPasses, type CaseRecord, type RunFile } from "../results";

export async function rescoreRun(run: RunFile, opts: { judge?: LanguageModel; judgeTrusted: boolean; golden?: GoldenCase[] }): Promise<CaseRecord[]> {
  const golden = new Map((opts.golden ?? loadGolden()).map((g) => [g.id, g]));
  const out: CaseRecord[] = [];
  for (const c of run.cases) {
    const tc = golden.get(c.id);
    if (!tc) continue; // case removed from the dataset
    const trials = [];
    for (const t of c.trials) {
      // Full rows are reproducible from the stored SQL (deterministic DB).
      let rows = t.output.rows;
      let columns = t.output.columns;
      if (t.output.sql.trim() && !t.output.error) {
        const res = tryRunSql(t.output.sql);
        if (!("error" in res)) ({ rows, columns } = res);
      }
      const code = scoreWithCode(tc, { ...t.output, rows, columns });
      const scores: Record<string, number | null> = Object.fromEntries(Object.entries(code).map(([k, v]) => [k, v?.score ?? null]));
      if (opts.judge) {
        const v = await judgeAnswer(opts.judge, { question: tc.question, sql: t.output.sql, columns, rows, answer: t.output.answer, error: t.output.error });
        scores.judge = v.score;
      } else if ("judge" in t.scores) {
        scores.judge = t.scores.judge;
      }
      trials.push({ ...t, scores, pass: trialPasses(scores, opts.judgeTrusted) });
    }
    out.push({ ...c, suite: tc.suite, status: tc.status, tags: tc.tags, trials });
  }
  return out;
}
