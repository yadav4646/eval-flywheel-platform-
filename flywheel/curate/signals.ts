// Which production turns are worth turning into eval cases? Strongest first:
// a human told us the right SQL > a human said it's wrong > the system can tell
// something went wrong > random coverage of normal traffic.

import { createHash } from "node:crypto";
import { config } from "../config";
import type { Classified, Signal, TraceRecord } from "./types";

export const PRIORITY: Record<Signal, number> = {
  user_correction: 100,
  thumbs_down: 80,
  sql_error: 60,
  empty_result: 50,
  no_submit: 50,
  slow: 30,
  thumbs_up: 20,
  coverage: 10,
};

/** Deterministic per-trace coin flip for the coverage sample. */
function sampled(id: string, rate: number): boolean {
  return parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) / 0xffffffff < rate;
}

export function classify(t: TraceRecord, sampleRate: number = config.curation.coverageSampleRate): Classified | null {
  const signal: Signal | null = t.feedback.correctedSql
    ? "user_correction"
    : t.feedback.rating === "down"
      ? "thumbs_down"
      : t.scores.executes === 0
        ? "sql_error"
        : t.scores.nonempty_result === 0
          ? "empty_result"
          : t.scores.submitted === 0
            ? "no_submit"
            : (t.metadata.durationMs ?? 0) > config.curation.slowTurnMs
              ? "slow"
              : t.feedback.rating === "up"
                ? "thumbs_up"
                : sampled(t.id, sampleRate)
                  ? "coverage"
                  : null;
  return signal ? { trace: t, signal, priority: PRIORITY[signal] } : null;
}
