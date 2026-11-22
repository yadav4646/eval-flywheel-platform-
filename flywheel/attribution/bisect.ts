// When the cause is code (agent/ or db/) or spans several commits, bisect the
// commit range, evaluating only the regressed cases at each step (bounded cost).

import { execFileSync, spawnSync } from "node:child_process";
import { loadGolden } from "../../evals/dataset";
import { ROOT } from "../paths";
import { runEval } from "../run";
import { passRate } from "./compare";

/** `git bisect run` step: exit 0 = good, 1 = bad, 125 = skip (can't evaluate this commit). */
export async function bisectStep({ ids, threshold, k, mock }: { ids: string[]; threshold: number; k: number; mock: boolean }): Promise<number> {
  try {
    const cases = loadGolden().filter((c) => ids.includes(c.id));
    if (!cases.length) return 125;
    const run = await runEval({ mock, k, cases, judge: false, sendLogs: false, quiet: true });
    const rate = passRate(run.cases);
    console.log(`bisect-step: pass rate ${rate.toFixed(2)} on ${cases.length} cases (threshold ${threshold})`);
    return rate >= threshold ? 0 : 1;
  } catch (e) {
    console.error(`bisect-step: cannot evaluate this commit: ${(e as Error).message}`);
    return 125;
  }
}

export interface BisectResult {
  firstBad?: string;
  subject?: string;
  error?: string;
  log?: string;
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

export function bisect({ goodSha, ids, threshold, k, mock }: { goodSha?: string; ids: string[]; threshold: number; k: number; mock: boolean }): BisectResult {
  if (!goodSha) return { error: "base run has no git sha" };
  try {
    if (git("status", "--porcelain")) return { error: "working tree is dirty; commit or stash before bisecting" };
    git("cat-file", "-e", `${goodSha}^{commit}`);
  } catch {
    return { error: `commit ${goodSha} not in local history (fetch more history, e.g. git fetch --depth=200)` };
  }
  try {
    git("bisect", "start", "HEAD", goodSha);
    const res = spawnSync(
      "git",
      ["bisect", "run", "npx", "tsx", "flywheel/cli.ts", "bisect-step", "--ids", ids.join(","), "--threshold", String(threshold), "--k", String(k), ...(mock ? ["--mock"] : [])],
      { cwd: ROOT, encoding: "utf-8" },
    );
    const log = `${res.stdout}\n${res.stderr}`;
    const m = /([0-9a-f]{7,40}) is the first bad commit/.exec(log);
    if (!m) return { error: "bisect did not converge", log: log.slice(-2000) };
    return { firstBad: m[1].slice(0, 12), subject: git("log", "-1", "--pretty=%s", m[1]), log: log.slice(-2000) };
  } finally {
    try {
      git("bisect", "reset");
    } catch {
      /* not bisecting */
    }
  }
}
