import { runSql, type QueryResult } from "../../agent/db";
import type { GoldenCase } from "../dataset";
import { answerGrounded } from "./answerGrounded";
import { efficiency } from "./efficiency";
import { executes } from "./executes";
import { refusal } from "./refusal";
import { resultMatch } from "./resultMatch";
import type { ScorableOutput, ScoreResult, Scorer } from "./types";

export const CODE_SCORERS: Record<string, Scorer> = { executes, resultMatch, answerGrounded, refusal, efficiency };

const goldCache = new Map<string, QueryResult[]>();

/** Execute a case's gold SQL (and acceptable alternatives). Cached per process. */
export function goldResults(tc: GoldenCase): QueryResult[] {
  if (tc.goldSql === null) return [];
  const key = [tc.goldSql, ...tc.acceptableSql].join("\n;;\n");
  let res = goldCache.get(key);
  if (!res) {
    res = [tc.goldSql, ...tc.acceptableSql].map((sql) => runSql(sql));
    goldCache.set(key, res);
  }
  return res;
}

export function scoreWithCode(tc: GoldenCase, output: ScorableOutput): Record<string, ScoreResult | null> {
  const ctx = { testCase: tc, output, gold: goldResults(tc) };
  return Object.fromEntries(Object.entries(CODE_SCORERS).map(([name, scorer]) => [name, scorer(ctx)]));
}

export { executes, resultMatch, answerGrounded, refusal, efficiency };
export type { ScorableOutput, ScoreResult, Scorer };
