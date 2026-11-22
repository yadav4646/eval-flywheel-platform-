// LLM-as-judge for the natural-language answer. Code scorers decide whether the
// SQL result is right; the judge decides whether the ANSWER is good: faithful
// to the rows, actually answers the question, flags assumptions, is clear.
//
// The judge is only trusted (counted in pass/fail and the CI gate) once it agrees
// with human labels: see flywheel/judge/calibrate.ts.

import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { Cell } from "../../agent/db";

export const JUDGE_LABELS = ["wrong", "weak", "acceptable", "great"] as const;
export type JudgeLabel = (typeof JUDGE_LABELS)[number];
/** Ordinal index (0..3) used for kappa; score is the index scaled to 0..1. */
export const labelIndex = (l: JudgeLabel) => JUDGE_LABELS.indexOf(l);
export const labelScore = (l: JudgeLabel) => Number((labelIndex(l) / 3).toFixed(2));

export const JUDGE_PROMPT = `You are grading a data analyst's answer to a business question. You see the question, the SQL the analyst ran, the rows that SQL returned, and the analyst's final answer.

Grade the ANSWER on this 4-point scale:

- great: Directly answers the question. Every number or name it states appears in (or is a correct rounding of) the rows. States any assumption it had to make. Concise.
- acceptable: Answers the question and is faithful to the rows, but is vague, omits a key number, or buries the answer.
- weak: Only partly answers the question, misreads the rows, uses wrong units (e.g. cents as dollars), or makes an unflagged assumption that changes the meaning.
- wrong: States numbers or facts not supported by the rows, answers a different question, or invents data. For questions the database cannot answer, an answer that fabricates a result is wrong and a clear "the data doesn't contain this" is great.

Judge only the answer's faithfulness and usefulness given these rows. Do not re-derive the SQL yourself.`;

const JudgeSchema = z.object({
  reasoning: z.string().describe("One or two sentences explaining the grade"),
  label: z.enum(JUDGE_LABELS),
});

export interface JudgeInput {
  question: string;
  sql: string;
  columns: string[];
  rows: Cell[][];
  answer: string;
  error?: string;
}

export interface JudgeVerdict {
  label: JudgeLabel;
  score: number;
  reasoning: string;
}

const MAX_ROWS_FOR_JUDGE = 20;

export function judgeUserMessage(i: JudgeInput): string {
  const rows = i.error ? `ERROR: ${i.error}` : JSON.stringify({ columns: i.columns, rows: i.rows.slice(0, MAX_ROWS_FOR_JUDGE) });
  return [
    `<question>${i.question}</question>`,
    `<sql>${i.sql || "(none)"}</sql>`,
    `<rows>${i.sql ? rows : ""}</rows>`,
    i.rows.length > MAX_ROWS_FOR_JUDGE ? `<note>${i.rows.length - MAX_ROWS_FOR_JUDGE} more rows not shown</note>` : "",
    `<answer>${i.answer}</answer>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function judgeAnswer(model: LanguageModel, input: JudgeInput): Promise<JudgeVerdict> {
  const { output } = await generateText({
    model,
    system: JUDGE_PROMPT,
    prompt: judgeUserMessage(input),
    output: Output.object({ schema: JudgeSchema }),
    temperature: 0,
  });
  return { label: output.label, score: labelScore(output.label), reasoning: output.reasoning };
}
