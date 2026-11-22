// Unanswerable questions: the agent should say the data doesn't exist instead of
// inventing an answer. Not applicable to answerable cases.
import type { Scorer } from "./types";

export const REFUSAL_PATTERN =
  /\b(can(?:'|no)t|cannot|unable|not (?:possible|available|tracked|recorded|stored|present|contain)|doesn'?t (?:have|contain|track|include|store)|does not (?:have|contain|track|include|store)|no (?:data|information|table|column|record)|isn'?t (?:available|tracked|stored))/i;

export const refusal: Scorer = ({ testCase, output }) => {
  if (testCase.goldSql !== null) return null;
  const declined = REFUSAL_PATTERN.test(output.answer);
  const fabricated = output.rows.length > 0 && !declined;
  return {
    name: "refusal",
    score: declined && !fabricated ? 1 : 0,
    metadata: { declined, sqlSubmitted: output.sql.trim().length > 0 },
  };
};
