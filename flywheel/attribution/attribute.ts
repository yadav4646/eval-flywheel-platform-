// "The score dropped. Why?"
//
//   1. Fingerprint diff: which components changed (prompt, tools, model, agent code,
//      DB schema, dataset, scorers, judge).
//   2. Dataset isolation: compare only cases both runs share; new cases are reported
//      separately so harder curated cases never look like a regression.
//   3. Measurement vs behavior: re-score the base run's recorded outputs with the
//      current scorers/gold/judge. base -> base' is the measurement effect,
//      base' -> head is the agent-behavior effect.
//   4. Per-case significance (Fisher exact) on base' vs head.
//   5. Ablation: revert each changed prompt/tools/model component on the regressed
//      cases and see which revert recovers the score.
//   6. Optional bisect for code changes / multi-commit ranges.

import { BEHAVIOR_COMPONENTS, COMPONENTS, diffFingerprints, MEASUREMENT_COMPONENTS, type Component } from "../fingerprint";
import { judgeModel } from "../models";
import { num, pct } from "../report";
import type { RunFile } from "../results";
import type { GoldenCase } from "../../evals/dataset";
import { ablate, ABLATABLE, type Ablation } from "./ablate";
import { bisect, type BisectResult } from "./bisect";
import { compareCases, passRate, scorerMean, type CaseDelta } from "./compare";
import { rescoreRun } from "./rescore";

export interface AttributionResult {
  baseId: string;
  headId: string;
  baseSha?: string;
  headSha?: string;
  changed: Component[];
  common: number;
  newCases: string[];
  removedCases: string[];
  pass: { base: number; baseRescored: number; head: number };
  measurementDelta: number;
  behaviorDelta: number;
  measurementFlips: string[];
  /** pass@1 on just the regressed cases: base (re-scored) vs head. */
  regressed: { base: number; head: number };
  regressions: CaseDelta[];
  improvements: CaseDelta[];
  scorers: { name: string; base: number; baseRescored: number; head: number }[];
  ablations: Ablation[];
  bisect?: BisectResult;
  verdict: string;
}

export async function attribute(base: RunFile, head: RunFile, opts: { ablate?: boolean; bisect?: boolean; golden?: GoldenCase[] } = {}): Promise<AttributionResult> {
  if (base.mode !== head.mode) throw new Error(`Cannot compare a ${base.mode} run with a ${head.mode} run.`);
  const changed = diffFingerprints(base.fingerprint, head.fingerprint);
  const headIds = new Set(head.cases.map((c) => c.id));
  const baseIds = new Set(base.cases.map((c) => c.id));
  const commonIds = new Set([...baseIds].filter((id) => headIds.has(id)));

  // 3. Re-score base outputs under the head's measurement.
  const judgeChanged = changed.includes("judge") && head.judge.enabled;
  const rescored = await rescoreRun(base, { judge: judgeChanged ? judgeModel(head.mode === "mock") : undefined, judgeTrusted: head.judge.trusted, golden: opts.golden });
  const baseC = base.cases.filter((c) => commonIds.has(c.id));
  const baseR = rescored.filter((c) => commonIds.has(c.id));
  const headC = head.cases.filter((c) => commonIds.has(c.id));
  const rById = new Map(baseR.map((c) => [c.id, c]));
  const measurementFlips = baseC
    .filter((c) => {
      const r = rById.get(c.id);
      return r && r.trials.filter((t) => t.pass).length !== c.trials.filter((t) => t.pass).length;
    })
    .map((c) => c.id);

  const pass = { base: passRate(baseC), baseRescored: passRate(baseR), head: passRate(headC) };
  const { regressions, improvements } = compareCases(baseR, headC);
  const regIds = new Set(regressions.map((r) => r.id));
  const regressed = { base: passRate(baseR.filter((c) => regIds.has(c.id))), head: passRate(headC.filter((c) => regIds.has(c.id))) };
  const scorerNames = [...new Set(headC.flatMap((c) => c.trials.flatMap((t) => Object.keys(t.scores))))];
  const scorers = scorerNames.map((name) => ({ name, base: scorerMean(baseC, name), baseRescored: scorerMean(baseR, name), head: scorerMean(headC, name) }));

  // 5. Ablation on regressed cases.
  let ablations: Ablation[] = [];
  const ablatable = changed.filter((c) => ABLATABLE.includes(c));
  if (opts.ablate !== false && regressions.length && ablatable.length) {
    ablations = await ablate(base, head, ablatable, regressions.map((r) => r.id));
  }

  // 6. Bisect (opt-in): code changes can't be ablated by swapping a value.
  let bisectRes: BisectResult | undefined;
  if (opts.bisect && regressions.length) {
    bisectRes = bisect({ goodSha: base.fingerprint.git.sha, ids: regressions.map((r) => r.id), threshold: (pass.baseRescored + pass.head) / 2, k: head.k, mock: head.mode === "mock" });
  }

  const result: AttributionResult = {
    baseId: base.runId,
    headId: head.runId,
    baseSha: base.fingerprint.git.sha,
    headSha: head.fingerprint.git.sha,
    changed,
    common: commonIds.size,
    newCases: [...headIds].filter((id) => !baseIds.has(id)),
    removedCases: [...baseIds].filter((id) => !headIds.has(id)),
    pass,
    measurementDelta: pass.baseRescored - pass.base,
    behaviorDelta: pass.head - pass.baseRescored,
    measurementFlips,
    regressed,
    regressions,
    improvements,
    scorers,
    ablations,
    bisect: bisectRes,
    verdict: "",
  };
  result.verdict = verdict(result);
  return result;
}

function verdict(r: AttributionResult): string {
  const behaviorChanged = r.changed.filter((c) => BEHAVIOR_COMPONENTS.includes(c));
  const measurementChanged = r.changed.filter((c) => MEASUREMENT_COMPONENTS.includes(c));
  const parts: string[] = [];
  if (!r.changed.length) parts.push("No component changed between these runs; any difference is run-to-run noise.");
  if (Math.abs(r.measurementDelta) >= 0.02)
    parts.push(`Measurement effect ${signedPct(r.measurementDelta)} from changed ${measurementChanged.join(", ") || "gold/scorers"} (re-scoring the base outputs alone moves pass@1 by that much).`);
  if (!r.regressions.length) {
    parts.push(r.behaviorDelta < -0.02 ? `Agent behavior ${signedPct(r.behaviorDelta)}, spread thin: no single case regressed significantly.` : "No case regressed significantly.");
    return parts.join(" ");
  }
  const worstScorer = [...r.scorers].filter((s) => s.head < s.baseRescored - 0.01).sort((a, b) => a.head - a.baseRescored - (b.head - b.baseRescored))[0];
  const kinds = countBy(r.regressions.map((x) => x.kind));
  parts.push(
    `Agent behavior ${signedPct(r.behaviorDelta)}: ${r.regressions.length} case(s) regressed significantly (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")})${worstScorer ? `, mostly on ${worstScorer.name} (${num(worstScorer.baseRescored)} → ${num(worstScorer.head)})` : ""}.`,
  );
  const top = r.ablations[0];
  if (top && top.recovered > 0.05) {
    const share = top.recovered / Math.max(r.regressed.base - r.regressed.head, 1e-9);
    const strength = share >= 0.5 ? "**likely cause**" : "partial cause";
    parts.push(`Ablation: reverting **${top.component}** recovers ${signedPct(top.recovered)} of the ${signedPct(r.regressed.head - r.regressed.base)} drop on the regressed cases → the ${top.component} change is the ${strength}.`);
  } else if (r.ablations.length) {
    parts.push(`Ablation: reverting ${r.ablations.map((a) => a.component).join(", ")} does not recover the score.`);
  }
  if (r.bisect?.firstBad) parts.push(`Bisect: first bad commit **${r.bisect.firstBad}** "${r.bisect.subject}".`);
  else if (r.bisect?.error) parts.push(`Bisect not run: ${r.bisect.error}.`);
  const unablatable = behaviorChanged.filter((c) => !ABLATABLE.includes(c));
  if (unablatable.length && !(top && top.recovered > 0.05) && !r.bisect?.firstBad)
    parts.push(`Changed ${unablatable.join(", ")} cannot be swapped back in-process; run \`npm run attribute -- --bisect\` to find the commit.`);
  return parts.join(" ");
}

const signedPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`;
const countBy = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

export function renderAttribution(r: AttributionResult): string {
  const lines = [
    `## Regression attribution`,
    "",
    `Base \`${r.baseId}\`${r.baseSha ? ` (${r.baseSha})` : ""} → head \`${r.headId}\`${r.headSha ? ` (${r.headSha})` : ""}`,
    "",
    `> ${r.verdict}`,
    "",
    `**Changed components:** ${COMPONENTS.map((c) => (r.changed.includes(c) ? `**${c}**` : `~~${c}~~`)).join(" · ")}`,
    "",
    `Compared on ${r.common} shared cases${r.newCases.length ? ` (${r.newCases.length} new cases in head excluded: ${r.newCases.slice(0, 5).map((x) => `\`${x}\``).join(", ")}${r.newCases.length > 5 ? "…" : ""})` : ""}.`,
    "",
    "| pass@1 on shared cases | |",
    "|---|---:|",
    `| Base | ${pct(r.pass.base)} |`,
    `| Base outputs, re-scored with head's scorers/gold/judge | ${pct(r.pass.baseRescored)} (measurement effect ${signedPct(r.measurementDelta)}) |`,
    `| Head | ${pct(r.pass.head)} (behavior effect ${signedPct(r.behaviorDelta)}) |`,
    "",
    "| Scorer | Base | Base re-scored | Head |",
    "|---|---:|---:|---:|",
    ...r.scorers.map((s) => `| ${s.name} | ${num(s.base)} | ${num(s.baseRescored)} | ${num(s.head)} |`),
  ];
  if (r.regressions.length) {
    lines.push("", "### Significant per-case regressions (Fisher exact, one-sided)", "", "| Case | Kind | Base | Head | p | Scorers that dropped |", "|---|---|---:|---:|---:|---|");
    for (const d of r.regressions)
      lines.push(`| \`${d.id}\` | ${d.kind} | ${d.base.c}/${d.base.n} | ${d.head.c}/${d.head.n} | ${d.p.toFixed(3)} | ${d.scorerDrops.map((s) => `${s.name} ${num(s.base)}→${num(s.head)}`).join(", ")} |`);
    const ex = r.regressions.find((d) => d.baseSql && d.headSql && d.baseSql !== d.headSql);
    if (ex) lines.push("", `<details><summary>Example: \`${ex.id}\`</summary>\n\nBase (passing):\n\`\`\`sql\n${ex.baseSql}\n\`\`\`\nHead (failing):\n\`\`\`sql\n${ex.headSql}\n\`\`\`\n</details>`);
  }
  if (r.improvements.length) lines.push("", `**Significant improvements:** ${r.improvements.map((d) => `\`${d.id}\` ${d.base.c}/${d.base.n}→${d.head.c}/${d.head.n}`).join(", ")}`);
  if (r.measurementFlips.length) lines.push("", `**Cases whose pass count changed from re-scoring alone:** ${r.measurementFlips.map((x) => `\`${x}\``).join(", ")}`);
  if (r.ablations.length) {
    lines.push("", "### Ablation (regressed cases, one component reverted to base)", "", "| Reverted | Head pass | Ablated pass | Recovered |", "|---|---:|---:|---:|");
    for (const a of r.ablations) lines.push(`| ${a.component} | ${pct(a.headPass)} | ${pct(a.ablatedPass)} | ${signedPct(a.recovered)} |`);
  }
  if (r.bisect) lines.push("", r.bisect.firstBad ? `**Bisect:** first bad commit \`${r.bisect.firstBad}\`: ${r.bisect.subject}` : `**Bisect:** ${r.bisect.error}`);
  return lines.join("\n");
}

