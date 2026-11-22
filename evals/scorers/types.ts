import type { Cell, QueryResult } from "../../agent/db";
import type { GoldenCase } from "../dataset";

/** The subset of an agent output that scorers need (also what results files store). */
export interface ScorableOutput {
  sql: string;
  answer: string;
  columns: string[];
  rows: Cell[][];
  error?: string;
  submitted: boolean;
  steps: number;
  queries: number;
}

export interface ScoreContext {
  testCase: GoldenCase;
  output: ScorableOutput;
  /** Executed results of goldSql followed by each acceptableSql (empty for unanswerable cases). */
  gold: QueryResult[];
}

export interface ScoreResult {
  name: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/** null = not applicable to this case (excluded from the scorer's mean). */
export type Scorer = (ctx: ScoreContext) => ScoreResult | null;
