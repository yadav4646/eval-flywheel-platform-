// Markdown rendering for runs (terminal, reports/latest.md, PR comments).

import type { GroupStats } from "./metrics/summary";
import type { RunFile } from "./results";

export const pct = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`);
export const num = (x: number | undefined, d = 2) => (x === undefined || Number.isNaN(x) ? "–" : x.toFixed(d));

function row(name: string, g: GroupStats, k: number) {
  if (!g.cases) return `| ${name} | 0 | – | – | – |`;
  const kk = Math.min(k, g.trialsPerCase);
  return `| ${name} | ${g.cases} | ${pct(g.passAt[1])} (${pct(g.passAt1CI[0])}–${pct(g.passAt1CI[1])}) | ${pct(g.passAt[kk])} | ${pct(g.passHat[kk])} |`;
}

export function renderRun(run: RunFile): string {
  const s = run.summary;
  const k = run.k;
  const fp = run.fingerprint;
  const lines = [
    `## Eval run \`${run.runId}\``,
    "",
    `- **Mode:** ${run.mode} · **trials per case (k):** ${k} · **model:** \`${fp.artifacts.model}\``,
    `- **Git:** \`${fp.git.sha ?? "?"}\`${fp.git.dirty ? " (dirty)" : ""} on \`${fp.git.branch ?? "?"}\`${fp.git.subject ? ` · ${fp.git.subject}` : ""}`,
    `- **Judge:** ${run.judge.trusted ? "✅ counted" : "⚠️ reported only"}: ${run.judge.reason}`,
    run.experimentUrl ? `- **Braintrust experiment:** ${run.experimentUrl}` : "",
    "",
    `| Population | Cases | pass@1 (95% CI) | pass@${k} | pass^${k} |`,
    "|---|---:|---:|---:|---:|",
    row("**Regression** (gated)", s.regression, k),
    row("Capability", s.capability, k),
    row("Candidates (unreviewed)", s.candidates, k),
    row("All", s.overall, k),
    "",
    "<details><summary>By kind</summary>",
    "",
    `| Kind | Cases | pass@1 (95% CI) | pass@${k} | pass^${k} |`,
    "|---|---:|---:|---:|---:|",
    ...Object.entries(s.byKind).map(([kind, g]) => row(kind, g, k)),
    "",
    "</details>",
    "",
    "| Scorer (all cases) | Mean | Std across trials | N |",
    "|---|---:|---:|---:|",
    ...Object.entries(s.overall.scorers).map(([name, v]) => `| ${name} | ${num(v.mean)} | ${num(v.std)} | ${v.n} |`),
    "",
    s.flaky.length
      ? `**Flaky cases** (passed some trials, failed others: run-to-run variance): ${s.flaky.map((f) => `\`${f.id}\` ${f.passes}/${f.trials}`).join(", ")}`
      : "**Flaky cases:** none",
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}
