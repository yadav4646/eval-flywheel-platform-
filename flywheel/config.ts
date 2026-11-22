// Every knob of the flywheel in one place. Thresholds are deliberately explicit:
// changing them is a reviewed diff, not a dashboard toggle.

export const config = {
  braintrustProject: process.env.BRAINTRUST_PROJECT ?? "SQL Analyst",
  datasetName: "SQL Analyst Golden",

  models: {
    agent: process.env.AGENT_MODEL ?? "gpt-5.4-mini",
    judge: process.env.JUDGE_MODEL ?? "gpt-5.4",
    /** Drafts gold SQL for curated traces that have no human correction. */
    drafter: process.env.DRAFTER_MODEL ?? "gpt-5.4",
    embedding: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  },

  eval: {
    trials: { local: 5, ci: 3 },
    maxConcurrency: 4,
  },

  /** A single trial passes when every applicable rule holds. */
  pass: {
    executes: 1,
    resultMatch: 1,
    refusal: 1,
    answerGrounded: 0.8,
    /** Judge >= Acceptable (0.66). Only applied when the judge is calibrated. */
    judge: 0.66,
  },

  judge: {
    /** Quadratic-weighted Cohen's kappa on the held-out test labels. */
    minKappa: 0.6,
    minTestLabels: 20,
  },

  curation: {
    maxNewCasesPerRun: 10,
    dedupeCosine: 0.92,
    coverageSampleRate: 0.1,
    slowTurnMs: 30_000,
  },

  gate: {
    /** Regression suite: fraction of cases that pass all k trials (pass^k, k = trials). */
    regressionMinPassHatK: 0.85,
    /** Fisher exact one-sided p below this marks a per-case regression. */
    caseRegressionP: 0.05,
    /** Max allowed drop in a scorer's mean (regression suite) vs baseline. */
    maxScorerDrop: { executes: 0.05, resultMatch: 0.08, answerGrounded: 0.1, refusal: 0.1, judge: 0.1 } as Record<string, number>,
    /** Capability suite pass@1 may not drop more than this. */
    capabilityMaxDrop: 0.1,
  },
} as const;

export type Config = typeof config;
