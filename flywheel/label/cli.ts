// Terminal labeling tool. Shows a recorded answer (question, SQL, rows, answer)
// WITHOUT the judge's verdict (blind labeling avoids anchoring), and appends the
// human's 1-4 grade to labels/human.jsonl. Sampling is stratified by the judge's
// label so every grade bucket gets coverage, which kappa needs.
//
//   npm run label -- --n 20 [--run results/<id>.json] [--labeler you]

import { createPrompter } from "./prompt";
import { userInfo } from "node:os";
import { rng } from "../../db/seed";
import { JUDGE_LABELS, type JudgeLabel } from "../../evals/scorers/judge";
import { loadRun, type RunFile } from "../results";
import { appendLabel, loadLabels, splitFor, type HumanLabel } from "./store";
import type { Cell } from "../../agent/db";

export interface LabelItem extends Omit<HumanLabel, "label" | "labeler" | "labeledAt" | "notes" | "split"> {
  judgeLabel?: JudgeLabel;
}

/** Unlabeled, de-duplicated outputs from a run, interleaved across judge-label buckets. */
export function sampleForLabeling(run: RunFile, alreadyLabeled: Set<string>, n: number, seed = 1): LabelItem[] {
  const seen = new Set<string>();
  const buckets = new Map<string, LabelItem[]>();
  for (const c of run.cases) {
    for (const t of c.trials) {
      if (alreadyLabeled.has(t.outputHash) || seen.has(t.outputHash)) continue;
      seen.add(t.outputHash);
      const item: LabelItem = {
        outputHash: t.outputHash,
        caseId: c.id,
        runId: run.runId,
        question: c.question,
        sql: t.output.sql,
        columns: t.output.columns,
        rows: t.output.rows,
        answer: t.output.answer,
        error: t.output.error,
        judgeLabel: t.judge?.label,
      };
      const key = item.judgeLabel ?? "unjudged";
      buckets.set(key, [...(buckets.get(key) ?? []), item]);
    }
  }
  const r = rng(seed);
  for (const items of buckets.values()) items.sort(() => r() - 0.5);
  const out: LabelItem[] = [];
  const lists = [...buckets.values()];
  while (out.length < n && lists.some((l) => l.length)) {
    for (const l of lists) if (l.length && out.length < n) out.push(l.shift()!);
  }
  return out;
}

function table(columns: string[], rows: Cell[][], max = 8): string {
  if (!columns.length) return "  (no rows)";
  const shown = rows.slice(0, max).map((r) => r.map((c) => (c === null ? "NULL" : String(c))));
  const widths = columns.map((c, i) => Math.min(28, Math.max(c.length, ...shown.map((r) => r[i]?.length ?? 0))));
  const fmt = (cells: string[]) => "  " + cells.map((c, i) => c.slice(0, 28).padEnd(widths[i])).join(" │ ");
  return [fmt(columns), "  " + widths.map((w) => "─".repeat(w)).join("─┼─"), ...shown.map(fmt), rows.length > max ? `  … ${rows.length - max} more rows` : ""]
    .filter(Boolean)
    .join("\n");
}

export async function labelCli({ runPath, n, labeler }: { runPath?: string; n: number; labeler?: string }) {
  if (!runPath) throw new Error("No results file found. Run `npm run eval` first or pass --run.");
  const run = loadRun(runPath);
  const done = new Set(loadLabels().map((l) => l.outputHash));
  const items = sampleForLabeling(run, done, n);
  if (!items.length) return console.log("Nothing new to label in this run.");
  const who = labeler ?? process.env.LABELER ?? userInfo().username;
  const rl = createPrompter();
  console.log(`\nLabeling ${items.length} answers from ${run.runId} as "${who}". The judge's verdict is hidden on purpose.\n`);
  console.log("Grades: 1 wrong · 2 weak · 3 acceptable · 4 great   (s = skip, q = quit)\n");
  let saved = 0;
  try {
    for (const [i, it] of items.entries()) {
      console.log(`━━━ ${i + 1}/${items.length} · ${it.caseId} ━━━`);
      console.log(`Q: ${it.question}\n`);
      console.log(`SQL: ${it.sql || "(none)"}\n`);
      console.log(it.error ? `  ERROR: ${it.error}` : table(it.columns, it.rows));
      console.log(`\nAnswer: ${it.answer}\n`);
      let grade: string;
      do grade = ((await rl.ask("Grade [1-4/s/q]: ")) ?? "q").trim().toLowerCase();
      while (!["1", "2", "3", "4", "s", "q"].includes(grade));
      if (grade === "q") break;
      if (grade === "s") continue;
      const notes = ((await rl.ask("Note (optional): ")) ?? "").trim();
      const { judgeLabel: _hidden, ...snapshot } = it;
      appendLabel({
        ...snapshot,
        label: JUDGE_LABELS[Number(grade) - 1],
        labeler: who,
        labeledAt: new Date().toISOString(),
        notes: notes || undefined,
        split: splitFor(it.outputHash),
      });
      saved++;
      console.log();
    }
  } finally {
    rl.close();
  }
  const total = loadLabels().length;
  console.log(`Saved ${saved} labels (${total} total). Next: npm run judge:calibrate`);
}
