// Production tracing. Each /api/ask is one root span ("analyst-turn") with the
// question, the SQL/answer, online scores (computable without gold), and the run
// fingerprint. User feedback (thumbs, corrected SQL) is attached to that span.
//
// With BRAINTRUST_API_KEY: Braintrust project logs (LLM + tool calls become child
// spans via wrapAISDK). Without it: traces/turns.jsonl + traces/feedback.jsonl,
// which the curation pipeline reads the same way, so the flywheel runs offline.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as ai from "ai";
import { initLogger, wrapAISDK, type Logger } from "braintrust";
import type { AgentOutput } from "../agent/agent";
import { config } from "../flywheel/config";
import { TRACES_DIR } from "../flywheel/paths";

export interface TurnMeta {
  source: "prod" | "simulated";
  sessionId?: string;
  model: string;
  fingerprint: Record<string, string>;
  gitSha?: string;
}

export interface Feedback {
  spanId: string;
  rating?: "up" | "down";
  correctedSql?: string;
  comment?: string;
}

/** Scores we can compute on live traffic with no gold answer: these drive curation. */
export function onlineScores(out: AgentOutput): Record<string, number | null> {
  const hasSql = out.sql.trim().length > 0;
  return {
    executes: hasSql ? (out.error ? 0 : 1) : null,
    nonempty_result: hasSql && !out.error ? (out.rows.length > 0 ? 1 : 0) : null,
    submitted: out.submitted ? 1 : 0,
    efficiency: out.steps ? Math.max(0, 1 - Math.max(0, out.steps - 5) / 3) : null,
  };
}

export interface TraceSink {
  kind: "braintrust" | "local";
  /** Runs `fn` inside a root span and logs its result. Returns the span id used for feedback. */
  traceTurn(question: string, meta: TurnMeta, fn: (generate: typeof ai.generateText) => Promise<AgentOutput>): Promise<{ spanId: string; out: AgentOutput }>;
  logFeedback(fb: Feedback): Promise<void>;
  flush(): Promise<void>;
}

function turnOutput(out: AgentOutput) {
  return {
    sql: out.sql,
    answer: out.answer,
    columns: out.columns,
    rows: out.rows.slice(0, 20),
    rowCount: out.rows.length,
    error: out.error,
    submitted: out.submitted,
  };
}

function turnMetadata(out: AgentOutput, meta: TurnMeta) {
  return { ...meta, steps: out.steps, queries: out.queries, durationMs: out.durationMs, toolCalls: out.toolCalls.map((c) => c.name) };
}

class BraintrustSink implements TraceSink {
  kind = "braintrust" as const;
  private logger: Logger<true>;
  private wrapped: typeof ai;
  constructor() {
    this.logger = initLogger({ projectName: config.braintrustProject, apiKey: process.env.BRAINTRUST_API_KEY });
    this.wrapped = wrapAISDK(ai);
  }
  async traceTurn(question: string, meta: TurnMeta, fn: (g: typeof ai.generateText) => Promise<AgentOutput>) {
    return this.logger.traced(
      async (span) => {
        const out = await fn(this.wrapped.generateText);
        span.log({
          input: { question },
          output: turnOutput(out),
          scores: onlineScores(out),
          metadata: turnMetadata(out, meta),
          metrics: { prompt_tokens: out.usage.inputTokens, completion_tokens: out.usage.outputTokens },
          tags: [meta.source],
        });
        return { spanId: span.id, out };
      },
      { name: "analyst-turn", type: "task" },
    );
  }
  async logFeedback(fb: Feedback) {
    this.logger.logFeedback({
      id: fb.spanId,
      scores: fb.rating ? { user_rating: fb.rating === "up" ? 1 : 0 } : undefined,
      expected: fb.correctedSql ? { sql: fb.correctedSql } : undefined,
      comment: fb.comment,
      metadata: { correctedSql: fb.correctedSql },
      source: "external",
    });
  }
  async flush() {
    await this.logger.flush();
  }
}

class LocalSink implements TraceSink {
  kind = "local" as const;
  constructor(private dir = TRACES_DIR) {
    mkdirSync(dir, { recursive: true });
  }
  async traceTurn(question: string, meta: TurnMeta, fn: (g: typeof ai.generateText) => Promise<AgentOutput>) {
    const out = await fn(ai.generateText);
    const spanId = randomUUID();
    const rec = {
      id: spanId,
      created: new Date().toISOString(),
      span_attributes: { name: "analyst-turn" },
      input: { question },
      output: turnOutput(out),
      scores: onlineScores(out),
      metadata: turnMetadata(out, meta),
    };
    appendFileSync(join(this.dir, "turns.jsonl"), JSON.stringify(rec) + "\n");
    return { spanId, out };
  }
  async logFeedback(fb: Feedback) {
    appendFileSync(join(this.dir, "feedback.jsonl"), JSON.stringify({ ...fb, created: new Date().toISOString() }) + "\n");
  }
  async flush() {}
}

export function createSink(kind?: "braintrust" | "local", dir?: string): TraceSink {
  const k = kind ?? (process.env.BRAINTRUST_API_KEY ? "braintrust" : "local");
  return k === "braintrust" ? new BraintrustSink() : new LocalSink(dir);
}
