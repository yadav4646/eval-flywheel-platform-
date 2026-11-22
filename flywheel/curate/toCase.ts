// Turn a production trace into a golden case. The hard part is the gold SQL:
//   1. a user's corrected SQL (human-verified)            -> status reviewed
//   2. the agent's own SQL on a thumbs-up turn            -> status candidate
//   3. a stronger model's draft, validated by executing it -> status candidate
// Drafts that fail to execute or return nothing are rejected, not guessed.

import { createHash } from "node:crypto";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { db, tryRunSql } from "../../agent/db";
import { BUSINESS_GLOSSARY } from "../../agent/prompt";
import type { Difficulty, GoldenCase, Kind } from "../../evals/dataset";
import type { Classified } from "./types";

export function inferKind(sql: string | null): Kind {
  if (sql === null) return "unanswerable";
  const s = sql.toLowerCase();
  if (/\bover\s*\(/.test(s)) return "window";
  if (/strftime|julianday|\bdate\(|order_date\s*(between|>=|<=|>|<)/.test(s)) return "date";
  if (/\bjoin\b/.test(s)) return "join";
  if (/group by|count\(|sum\(|avg\(|max\(|min\(/.test(s)) return "aggregate";
  return "filter";
}

export function inferDifficulty(sql: string | null): Difficulty {
  if (sql === null) return "medium";
  const s = sql.toLowerCase();
  const score =
    (s.match(/\bjoin\b/g)?.length ?? 0) +
    (/\bover\s*\(/.test(s) ? 2 : 0) +
    (/^\s*with\b/.test(s) ? 1 : 0) +
    ((s.match(/\(\s*select\b/g)?.length ?? 0) > 0 ? 1 : 0) +
    (/group by/.test(s) ? 1 : 0) +
    (/having/.test(s) ? 1 : 0);
  return score <= 1 ? "easy" : score <= 3 ? "medium" : "hard";
}

let schemaCache: string | null = null;
export function schemaDDL(): string {
  schemaCache ??= (db().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { sql: string }[])
    .map((r) => r.sql)
    .join(";\n\n");
  return schemaCache;
}

const DraftSchema = z.object({
  answerable: z.boolean().describe("false if the schema has no data that can answer the question"),
  sql: z.string().describe("A single SQLite SELECT/WITH query answering the question, or empty string if unanswerable"),
});

export async function draftGoldSql(model: LanguageModel, question: string): Promise<{ answerable: boolean; sql: string }> {
  const { output } = await generateText({
    model,
    system: `You write reference ("gold") SQLite queries for an evaluation dataset. Be exact and conventional. Use these definitions:\n\n${BUSINESS_GLOSSARY}\n\nSchema:\n${schemaDDL()}`,
    prompt: `<question>${question}</question>\nWrite the single query whose result answers the question. Return only columns needed to answer it.`,
    output: Output.object({ schema: DraftSchema }),
    temperature: 0,
  });
  return output;
}

export type ToCaseResult = { ok: true; case: GoldenCase } | { ok: false; reason: string };

export async function toCase({ trace, signal }: Classified, drafter: LanguageModel): Promise<ToCaseResult> {
  let goldSql: string | null;
  let goldFrom: NonNullable<GoldenCase["provenance"]["goldFrom"]>;

  if (trace.feedback.correctedSql) {
    goldSql = trace.feedback.correctedSql;
    goldFrom = "user_correction";
  } else if (signal === "thumbs_up" && trace.output.sql && !trace.output.error && trace.output.rowCount > 0) {
    goldSql = trace.output.sql;
    goldFrom = "accepted_output";
  } else {
    const draft = await draftGoldSql(drafter, trace.question);
    goldSql = draft.answerable && draft.sql.trim() ? draft.sql : null;
    goldFrom = "llm_draft";
  }

  if (goldSql !== null) {
    const res = tryRunSql(goldSql);
    if ("error" in res) return { ok: false, reason: `gold SQL failed: ${res.error}` };
    if (res.rowCount === 0) return { ok: false, reason: "gold SQL returned no rows" };
  }

  const kind = inferKind(goldSql);
  const hash = createHash("sha256").update(trace.question).digest("hex").slice(0, 8);
  return {
    ok: true,
    case: {
      id: `prod-${kind}-${hash}`,
      question: trace.question,
      goldSql,
      acceptableSql: [],
      tags: { kind, difficulty: inferDifficulty(goldSql), topics: /discount_pct/.test(goldSql ?? "") ? ["revenue"] : [] },
      suite: "capability",
      status: goldFrom === "user_correction" ? "reviewed" : "candidate",
      provenance: {
        source: trace.metadata.source === "simulated" ? "simulated" : "production",
        createdAt: new Date().toISOString().slice(0, 10),
        traceId: trace.id,
        signal,
        goldFrom,
      },
    },
  };
}
