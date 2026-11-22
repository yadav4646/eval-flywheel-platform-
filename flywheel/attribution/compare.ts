// Case-level comparison of two runs on the cases they share.

import { config } from "../config";
import { fisherOneSided, mean } from "../metrics/stats";
import { casePasses } from "../metrics/summary";
import type { CaseRecord } from "../results";

export interface CaseDelta {
  id: string;
  kind: string;
  suite: string;
  status: string;
  base: { c: number; n: number };
  head: { c: number; n: number };
  /** One-sided Fisher p for "base pass rate > head pass rate" (or the reverse, for improvements). */
  p: number;
  /** Scorers whose mean dropped on this case. */
  scorerDrops: { name: string; base: number; head: number }[];
  baseSql?: string;
  headSql?: string;
}

function scorerMeans(c: CaseRecord): Record<string, number> {
  const names = new Set(c.trials.flatMap((t) => Object.keys(t.scores)));
  const out: Record<string, number> = {};
  for (const n of names) {
    const vals = c.trials.map((t) => t.scores[n]).filter((v): v is number => typeof v === "number");
    if (vals.length) out[n] = mean(vals);
  }
  return out;
}

/** The SQL a case's failing trials produced most often (a readable example for reports). */
function representativeSql(c: CaseRecord, failing: boolean): string | undefined {
  const pool = c.trials.filter((t) => t.pass === !failing);
  return (pool[0] ?? c.trials[0])?.output.sql;
}

export function compareCases(base: CaseRecord[], head: CaseRecord[], alpha: number = config.gate.caseRegressionP) {
  const headById = new Map(head.map((c) => [c.id, c]));
  const regressions: CaseDelta[] = [];
  const improvements: CaseDelta[] = [];
  for (const b of base) {
    const h = headById.get(b.id);
    if (!h) continue;
    const bp = casePasses(b);
    const hp = casePasses(h);
    const bm = scorerMeans(b);
    const hm = scorerMeans(h);
    const scorerDrops = Object.keys(bm)
      .filter((n) => n in hm && hm[n] < bm[n] - 1e-9)
      .map((n) => ({ name: n, base: bm[n], head: hm[n] }));
    const delta = (p: number): CaseDelta => ({
      id: b.id,
      kind: b.tags.kind,
      suite: h.suite,
      status: h.status,
      base: bp,
      head: hp,
      p,
      scorerDrops,
      baseSql: representativeSql(b, false),
      headSql: representativeSql(h, true),
    });
    const pDown = fisherOneSided(bp.c, bp.n, hp.c, hp.n);
    const pUp = fisherOneSided(hp.c, hp.n, bp.c, bp.n);
    if (pDown <= alpha) regressions.push(delta(pDown));
    else if (pUp <= alpha) improvements.push(delta(pUp));
  }
  return { regressions: regressions.sort((a, b) => a.p - b.p), improvements };
}

export function passRate(cases: CaseRecord[]): number {
  return mean(cases.map((c) => casePasses(c).c / c.trials.length));
}

export function scorerMean(cases: CaseRecord[], name: string): number {
  return mean(cases.flatMap((c) => c.trials.map((t) => t.scores[name])).filter((v): v is number => typeof v === "number"));
}
