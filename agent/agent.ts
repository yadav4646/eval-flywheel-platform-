// The text-to-SQL analyst. One function, used by the production server, the
// eval runner, attribution ablations and the traffic simulator, so what we
// evaluate is exactly what we ship.

import { generateText, hasToolCall, isStepCount, type LanguageModel } from "ai";
import { SYSTEM_PROMPT } from "./prompt";
import { makeTools, type ToolDescriptions } from "./tools";
import { tryRunSql, type Cell } from "./db";

export const MAX_STEPS = 8;

export interface AgentOutput {
  sql: string;
  answer: string;
  columns: string[];
  rows: Cell[][]; // final SQL re-executed (capped)
  error?: string; // final SQL error, or agent failure
  submitted: boolean; // did the agent call submitAnswer?
  steps: number;
  queries: number; // runQuery calls
  toolCalls: { name: string; input: unknown }[];
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

export interface RunAgentArgs {
  question: string;
  model: LanguageModel;
  system?: string;
  toolDescriptions?: Partial<ToolDescriptions>;
  maxSteps?: number;
  /** Injected so tracing can pass Braintrust's wrapped generateText. */
  generate?: typeof generateText;
  abortSignal?: AbortSignal;
}

export async function runAgent({
  question,
  model,
  system = SYSTEM_PROMPT,
  toolDescriptions,
  maxSteps = MAX_STEPS,
  generate = generateText,
  abortSignal,
}: RunAgentArgs): Promise<AgentOutput> {
  const start = Date.now();
  try {
    const result = await generate({
      model,
      system,
      prompt: question,
      tools: makeTools(toolDescriptions),
      stopWhen: [hasToolCall("submitAnswer"), isStepCount(maxSteps)],
      temperature: 0,
      abortSignal,
    });

    const toolCalls: { name: string; input: unknown }[] = [];
    for (const step of result.steps) {
      for (const call of step.toolCalls ?? []) toolCalls.push({ name: call.toolName, input: call.input });
    }
    const submit = [...toolCalls].reverse().find((c) => c.name === "submitAnswer");
    const lastQuery = [...toolCalls].reverse().find((c) => c.name === "runQuery");
    const submitted = !!submit;
    const sql = submitted
      ? String((submit!.input as { sql?: string }).sql ?? "")
      : String((lastQuery?.input as { sql?: string } | undefined)?.sql ?? "");
    const answer = submitted ? String((submit!.input as { answer?: string }).answer ?? "") : result.text;

    let columns: string[] = [];
    let rows: Cell[][] = [];
    let error: string | undefined;
    if (sql.trim()) {
      const res = tryRunSql(sql);
      if ("error" in res) error = res.error;
      else ({ columns, rows } = res);
    }

    return {
      sql,
      answer,
      columns,
      rows,
      error,
      submitted,
      steps: result.steps.length,
      queries: toolCalls.filter((c) => c.name === "runQuery").length,
      toolCalls,
      usage: {
        inputTokens: result.totalUsage?.inputTokens ?? 0,
        outputTokens: result.totalUsage?.outputTokens ?? 0,
      },
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      sql: "",
      answer: "",
      columns: [],
      rows: [],
      error: `agent failed: ${e instanceof Error ? e.message : String(e)}`,
      submitted: false,
      steps: 0,
      queries: 0,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: Date.now() - start,
    };
  }
}
