// Informational: steps used vs budget. Not part of the pass rule; useful for
// spotting a change that makes the agent flail (cost and latency regressions).
import type { Scorer } from "./types";

const BUDGET_STEPS = 5;

export const efficiency: Scorer = ({ output }) => {
  if (output.steps === 0) return null;
  const over = Math.max(0, output.steps - BUDGET_STEPS);
  return { name: "efficiency", score: Math.max(0, 1 - over / 3), metadata: { steps: output.steps, queries: output.queries } };
};
