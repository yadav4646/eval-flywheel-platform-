/** A production turn, normalized from Braintrust project logs or the local trace files. */
export interface TraceRecord {
  id: string;
  createdAt: string;
  question: string;
  output: { sql: string; answer: string; rowCount: number; error?: string; submitted: boolean };
  scores: Record<string, number | null | undefined>;
  metadata: { source?: string; model?: string; durationMs?: number; steps?: number; [k: string]: unknown };
  feedback: { rating?: "up" | "down"; correctedSql?: string; comment?: string };
}

export type Signal = "user_correction" | "thumbs_down" | "sql_error" | "empty_result" | "no_submit" | "slow" | "thumbs_up" | "coverage";

export interface Classified {
  trace: TraceRecord;
  signal: Signal;
  priority: number;
}
