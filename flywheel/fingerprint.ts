// A run's fingerprint: a hash per component that can change agent behavior or
// the measurement. Attribution diffs two fingerprints to say WHAT changed.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_PROMPT } from "../agent/prompt";
import { TOOL_DESCRIPTIONS, toolSpec } from "../agent/tools";
import { JUDGE_PROMPT } from "../evals/scorers/judge";
import { ROOT, GOLDEN_PATH } from "./paths";

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

function hashFiles(dir: string, filter: (f: string) => boolean = (f) => f.endsWith(".ts")): string {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return sha("");
  const files = readdirSync(abs).filter(filter).sort();
  return sha(files.map((f) => `${f}\n${readFileSync(join(abs, f), "utf-8")}`).join("\n---\n"));
}

function git(cmd: string): string | undefined {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}

/** Components, in the order attribution reports them. */
export const COMPONENTS = ["prompt", "tools", "model", "agentCode", "dbSchema", "dataset", "scorers", "judge"] as const;
export type Component = (typeof COMPONENTS)[number];

/** Components that change the agent's behavior (vs. the measurement). */
export const BEHAVIOR_COMPONENTS: Component[] = ["prompt", "tools", "model", "agentCode", "dbSchema"];
export const MEASUREMENT_COMPONENTS: Component[] = ["dataset", "scorers", "judge"];

export const judgeHash = (judgeModel: string) => sha(JUDGE_PROMPT + judgeModel);

export interface Fingerprint {
  hashes: Record<Component, string>;
  /** Raw values needed to re-run the agent with an older component (ablation). */
  artifacts: {
    systemPrompt: string;
    toolDescriptions: Record<string, string>;
    model: string;
    judgeModel: string;
  };
  git: { sha?: string; branch?: string; dirty: boolean; subject?: string };
}

export function fingerprint(opts: { model: string; judgeModel: string; systemPrompt?: string; toolDescriptions?: Record<string, string> }): Fingerprint {
  const systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
  const toolDescriptions = { ...TOOL_DESCRIPTIONS, ...(opts.toolDescriptions ?? {}) };
  const status = git("status --porcelain");
  return {
    hashes: {
      prompt: sha(systemPrompt),
      tools: sha(JSON.stringify(toolSpec(toolDescriptions))),
      model: sha(opts.model),
      // prompt.ts and tools.ts are tracked as their own components; hash the rest of agent/.
      agentCode: hashFiles("agent", (f) => f.endsWith(".ts") && f !== "prompt.ts" && f !== "tools.ts"),
      dbSchema: sha(readFileSync(join(ROOT, "db", "schema.sql"), "utf-8") + readFileSync(join(ROOT, "db", "seed.ts"), "utf-8")),
      dataset: existsSync(GOLDEN_PATH) ? sha(readFileSync(GOLDEN_PATH, "utf-8")) : sha(""),
      scorers: hashFiles("evals/scorers", (f) => f.endsWith(".ts") && f !== "judge.ts"),
      judge: judgeHash(opts.judgeModel),
    },
    artifacts: { systemPrompt, toolDescriptions, model: opts.model, judgeModel: opts.judgeModel },
    git: {
      sha: git("rev-parse --short HEAD"),
      branch: git("rev-parse --abbrev-ref HEAD"),
      dirty: !!status,
      subject: git("log -1 --pretty=%s"),
    },
  };
}

export function diffFingerprints(base: Fingerprint, head: Fingerprint): Component[] {
  return COMPONENTS.filter((c) => base.hashes[c] !== head.hashes[c]);
}
