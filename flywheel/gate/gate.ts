// The CI gate. Fails the build when the agent got worse in a way that is more
// than noise. Every rule and threshold lives in flywheel/config.ts.
//
// Population rules:
//   - regression suite (reviewed): hard gate (reliability + no significant case drops)
//   - capability suite (reviewed): soft gate (pass@1 may not drop more than X)
//   - candidates (auto-curated, unreviewed): never gate
//   - the LLM judge counts only when calibrated (see judge/trust.ts)

import { config } from "../config";
import { num, pct, renderRun } from "../report";
import type { CaseRecord, RunFile } from "../results";
import { compareCases, passRate, scorerMean } from "../attribution/compare";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface GateVerdict {
  passed: boolean;
  checks: Check[];
}

const reviewed = (cases: CaseRecord[], suite: "regression" | "capability") => cases.filter((c) => c.status === "reviewed" && c.suite === suite);

export function gate(head: RunFile, base?: RunFile): GateVerdict {
  const g = config.gate;
  const checks: Check[] = [];
  const reg = head.summary.regression;
  // Reliability is always judged as pass^K with K = the CI trial count, estimated
  // from however many trials were run, so a local k=5 run faces the same bar as CI.
  const k = Math.min(config.eval.trials.ci, reg.trialsPerCase);

  // 1. Absolute reliability of the regression suite.
  if (!reg.cases) checks.push({ name: "Regression reliability", status: "skip", detail: "no reviewed regression cases in this run" });
  else {
    const ph = reg.passHat[k];
    checks.push({
      name: `Regression reliability (pass^${k})`,
      status: ph >= g.regressionMinPassHatK ? "pass" : "fail",
      detail: `${pct(ph)} of regression cases passed all ${k} trials (min ${pct(g.regressionMinPassHatK)}); pass@1 ${pct(reg.passAt[1])}`,
    });
  }

  // Judge status (informational).
  checks.push({
    name: "LLM judge",
    status: head.judge.trusted ? "pass" : "warn",
    detail: head.judge.trusted ? `counted in pass/fail: ${head.judge.reason}` : `excluded from pass/fail: ${head.judge.reason}`,
  });

  if (!base) {
    checks.push({ name: "Baseline comparison", status: "warn", detail: "no baseline committed yet: run `npm run baseline:update` and commit reports/baseline*.json" });
    return finish(checks);
  }
  if (base.mode !== head.mode) {
    checks.push({ name: "Baseline comparison", status: "fail", detail: `baseline is a ${base.mode} run but head is ${head.mode}` });
    return finish(checks);
  }

  const headIds = new Set(head.cases.map((c) => c.id));
  const shared = (cs: CaseRecord[]) => cs.filter((c) => headIds.has(c.id));
  const baseIds = new Set(base.cases.map((c) => c.id));
  const headShared = (cs: CaseRecord[]) => cs.filter((c) => baseIds.has(c.id));

  // 2. No significant per-case regression in the regression suite.
  const { regressions } = compareCases(shared(base.cases), head.cases);
  const regDrops = regressions.filter((r) => r.status === "reviewed" && r.suite === "regression");
  const capDrops = regressions.filter((r) => r.status === "reviewed" && r.suite === "capability");
  checks.push({
    name: "Per-case regressions (regression suite)",
    status: regDrops.length ? "fail" : "pass",
    detail: regDrops.length
      ? regDrops.map((r) => `\`${r.id}\` ${r.base.c}/${r.base.n}→${r.head.c}/${r.head.n} (p=${r.p.toFixed(3)})`).join(", ")
      : `none significant at p ≤ ${g.caseRegressionP}`,
  });
  if (capDrops.length) checks.push({ name: "Per-case regressions (capability)", status: "warn", detail: capDrops.map((r) => `\`${r.id}\` ${r.base.c}/${r.base.n}→${r.head.c}/${r.head.n}`).join(", ") });

  // 3. Scorer means on the regression suite.
  const baseReg = reviewed(shared(base.cases), "regression");
  const headReg = reviewed(headShared(head.cases), "regression");
  const scorerFails: string[] = [];
  for (const [name, maxDrop] of Object.entries(g.maxScorerDrop)) {
    if (name === "judge" && !head.judge.trusted) continue;
    const b = scorerMean(baseReg, name);
    const h = scorerMean(headReg, name);
    if (Number.isFinite(b) && Number.isFinite(h) && b - h > maxDrop) scorerFails.push(`${name} ${num(b)}→${num(h)} (max drop ${maxDrop})`);
  }
  checks.push({ name: "Scorer means (regression suite)", status: scorerFails.length ? "fail" : "pass", detail: scorerFails.join(", ") || "all within tolerance" });

  // 4. Capability suite may not slide much.
  const baseCap = reviewed(shared(base.cases), "capability");
  const headCap = reviewed(headShared(head.cases), "capability");
  if (baseCap.length) {
    const b = passRate(baseCap);
    const h = passRate(headCap);
    checks.push({
      name: "Capability pass@1",
      status: b - h > g.capabilityMaxDrop ? "fail" : "pass",
      detail: `${pct(b)} → ${pct(h)} (max drop ${pct(g.capabilityMaxDrop)})`,
    });
  } else checks.push({ name: "Capability pass@1", status: "skip", detail: "no reviewed capability cases shared with the baseline" });

  const candidates = head.cases.filter((c) => c.status === "candidate").length;
  if (candidates) checks.push({ name: "Candidates", status: "skip", detail: `${candidates} unreviewed curated case(s) reported but not gated` });
  return finish(checks);
}

function finish(checks: Check[]): GateVerdict {
  return { passed: !checks.some((c) => c.status === "fail"), checks };
}

const ICON: Record<CheckStatus, string> = { pass: "✅", fail: "❌", warn: "⚠️", skip: "➖" };

export function renderGate(v: GateVerdict, head: RunFile, base?: RunFile): string {
  return [
    `# Eval gate: ${v.passed ? "✅ PASSED" : "❌ FAILED"}`,
    "",
    base ? `Baseline: \`${base.runId}\`${base.fingerprint.git.sha ? ` (${base.fingerprint.git.sha})` : ""}` : "Baseline: none",
    "",
    "| Check | Result | Detail |",
    "|---|:---:|---|",
    ...v.checks.map((c) => `| ${c.name} | ${ICON[c.status]} | ${c.detail} |`),
    "",
    renderRun(head),
  ].join("\n");
}
