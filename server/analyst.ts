// The production entry point, shared by the HTTP server and the traffic
// simulator: run the agent inside a traced turn, accept feedback.

import { runAgent } from "../agent/agent";
import { assertReadOnly, runSql } from "../agent/db";
import { fingerprint } from "../flywheel/fingerprint";
import { agentModel, agentModelId, judgeModelId } from "../flywheel/models";
import { createSink, type Feedback, type TraceSink, type TurnMeta } from "./tracing";

export interface AnalystService {
  sink: TraceSink;
  ask(question: string, opts?: { source?: TurnMeta["source"]; sessionId?: string }): Promise<{
    spanId: string;
    sql: string;
    answer: string;
    columns: string[];
    rows: unknown[][];
    error?: string;
  }>;
  feedback(fb: Feedback): Promise<void>;
}

export function createAnalyst({ mock, sink = createSink() }: { mock: boolean; sink?: TraceSink }): AnalystService {
  const model = agentModel(mock);
  const fp = fingerprint({ model: agentModelId(mock), judgeModel: judgeModelId(mock) });
  return {
    sink,
    async ask(question, opts = {}) {
      const meta: TurnMeta = {
        source: opts.source ?? "prod",
        sessionId: opts.sessionId,
        model: fp.artifacts.model,
        fingerprint: fp.hashes,
        gitSha: fp.git.sha,
      };
      const { spanId, out } = await sink.traceTurn(question, meta, (generate) => runAgent({ question, model, generate }));
      return { spanId, sql: out.sql, answer: out.answer, columns: out.columns, rows: out.rows.slice(0, 50), error: out.error };
    },
    async feedback(fb) {
      if (fb.correctedSql) {
        assertReadOnly(fb.correctedSql); // throws on unsafe SQL
        runSql(fb.correctedSql, 1); // throws if it doesn't execute
      }
      await sink.logFeedback(fb);
    },
  };
}
