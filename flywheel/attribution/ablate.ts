// Component ablation: re-run the regressed cases with ONE changed component
// reverted to the base run's version (prompt, tool descriptions or model), keeping
// everything else at head. The component whose revert recovers the score is the
// likely cause.

import type { Component } from "../fingerprint";
import { runEval } from "../run";
import { loadGolden } from "../../evals/dataset";
import type { RunFile } from "../results";
import { passRate } from "./compare";

export const ABLATABLE: Component[] = ["prompt", "tools", "model"];

export interface Ablation {
  component: Component;
  headPass: number;
  ablatedPass: number;
  recovered: number; // ablatedPass - headPass
}

export async function ablate(base: RunFile, head: RunFile, components: Component[], caseIds: string[]): Promise<Ablation[]> {
  const cases = loadGolden().filter((c) => caseIds.includes(c.id));
  const headSubset = head.cases.filter((c) => caseIds.includes(c.id));
  const headPass = passRate(headSubset);
  const mock = head.mode === "mock";
  const stripMock = (id: string) => id.replace(/^mock:/, "");
  const out: Ablation[] = [];
  for (const component of components.filter((c) => ABLATABLE.includes(c))) {
    const run = await runEval({
      mock,
      k: head.k,
      cases,
      judge: head.judge.trusted, // only spend judge calls if the judge affects pass/fail
      sendLogs: false,
      quiet: true,
      systemPrompt: component === "prompt" ? base.fingerprint.artifacts.systemPrompt : head.fingerprint.artifacts.systemPrompt,
      toolDescriptions: component === "tools" ? base.fingerprint.artifacts.toolDescriptions : head.fingerprint.artifacts.toolDescriptions,
      modelId: stripMock(component === "model" ? base.fingerprint.artifacts.model : head.fingerprint.artifacts.model),
    });
    const ablatedPass = passRate(run.cases);
    out.push({ component, headPass, ablatedPass, recovered: ablatedPass - headPass });
  }
  return out.sort((a, b) => b.recovered - a.recovered);
}
