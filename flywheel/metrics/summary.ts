// Aggregates trial records into pass@k / pass^k (per case, then averaged over
// cases) plus per-scorer mean +/- std, and lists flaky cases.

import type { CaseRecord } from "../results";
import { bootstrapCI, mean, passAtK, passHatK, std } from "./stats";

export interface GroupStats {
  cases: number;
  trialsPerCase: number;
  /** Mean over cases of pass@k for k = 1..n. Keys are k. */
  passAt: Record<number, number>;
  /** Mean over cases of pass^k for k = 1..n. */
  passHat: Record<number, number>;
  /** 95% bootstrap CI (over cases) of pass@1. */
  passAt1CI: [number, number];
  scorers: Record<string, { mean: number; std: number; n: number }>;
}

export interface RunSummary {
  overall: GroupStats;
  /** Gated population: reviewed regression cases. */
  regression: GroupStats;
  capability: GroupStats;
  candidates: GroupStats;
  byKind: Record<string, GroupStats>;
  flaky: { id: string; passes: number; trials: number }[];
}

export function casePasses(c: CaseRecord): { n: number; c: number } {
  return { n: c.trials.length, c: c.trials.filter((t) => t.pass).length };
}

export function groupStats(cases: CaseRecord[]): GroupStats {
  const n = cases.length ? Math.min(...cases.map((c) => c.trials.length)) : 0;
  const passAt: Record<number, number> = {};
  const passHat: Record<number, number> = {};
  for (let k = 1; k <= n; k++) {
    passAt[k] = mean(cases.map((cr) => passAtK(cr.trials.length, casePasses(cr).c, k)));
    passHat[k] = mean(cases.map((cr) => passHatK(cr.trials.length, casePasses(cr).c, k)));
  }
  const names = new Set(cases.flatMap((c) => c.trials.flatMap((t) => Object.keys(t.scores))));
  const scorers: GroupStats["scorers"] = {};
  for (const name of names) {
    const vals = cases.flatMap((c) => c.trials.map((t) => t.scores[name])).filter((v): v is number => typeof v === "number");
    if (vals.length) scorers[name] = { mean: mean(vals), std: std(vals), n: vals.length };
  }
  const p1 = (s: CaseRecord[]) => mean(s.map((cr) => casePasses(cr).c / cr.trials.length));
  return { cases: cases.length, trialsPerCase: n, passAt, passHat, passAt1CI: bootstrapCI(cases, p1), scorers };
}

export function summarize(cases: CaseRecord[]): RunSummary {
  const byKind: Record<string, GroupStats> = {};
  for (const kind of [...new Set(cases.map((c) => c.tags.kind))].sort()) {
    byKind[kind] = groupStats(cases.filter((c) => c.tags.kind === kind));
  }
  return {
    overall: groupStats(cases),
    regression: groupStats(cases.filter((c) => c.suite === "regression" && c.status === "reviewed")),
    capability: groupStats(cases.filter((c) => c.suite === "capability" && c.status === "reviewed")),
    candidates: groupStats(cases.filter((c) => c.status === "candidate")),
    byKind,
    flaky: cases
      .map((c) => ({ id: c.id, passes: casePasses(c).c, trials: c.trials.length }))
      .filter((f) => f.passes > 0 && f.passes < f.trials),
  };
}
