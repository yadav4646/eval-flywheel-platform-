// Deterministic mock LLMs implementing the AI SDK LanguageModelV4 / EmbeddingModelV4
// specs, so the REAL agent loop, tools, SQL execution, scorers, tracing and
// curation all run without API keys (CI on forks, local dev, tests).
//
// The analyst mock is intentionally imperfect, with failure rates that depend
// on things a real model is sensitive to:
//   - case difficulty (hard cases fail more often -> pass@k != pass^k)
//   - the system prompt (removing the business glossary breaks revenue questions)
//   - the model id (a "nano" model is sloppier)
// That makes variance, attribution and the CI gate demonstrable offline.

import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, EmbeddingModelV4 } from "@ai-sdk/provider";
import { rng } from "../../db/seed";
import { normalizeQuestion, oracle } from "./oracle";

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: o, text: o, reasoning: undefined },
});

function result(content: LanguageModelV4Content[], finish: "stop" | "tool-calls") {
  return {
    content,
    finishReason: { unified: finish, raw: undefined },
    usage: usage(800, 120),
    warnings: [],
  } as Awaited<ReturnType<LanguageModelV4["doGenerate"]>>;
}

function toolCall(name: string, input: unknown, id: string): LanguageModelV4Content {
  return { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) };
}

interface ParsedPrompt {
  system: string;
  user: string;
  toolResults: { toolName: string; value: unknown }[];
}

function parsePrompt(opts: LanguageModelV4CallOptions): ParsedPrompt {
  let system = "";
  let user = "";
  const toolResults: ParsedPrompt["toolResults"] = [];
  for (const msg of opts.prompt) {
    if (msg.role === "system") system += msg.content;
    else if (msg.role === "user") user += msg.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    else if (msg.role === "tool" || msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          const out = part.output as { type: string; value: unknown };
          toolResults.push({ toolName: part.toolName, value: out?.value });
        }
      }
    }
  }
  return { system, user, toolResults };
}

/** Wrong-but-plausible variants of a correct query. */
function mutate(sql: string, r: () => number, preferRevenueMistake: boolean): string {
  const revenueMistakes = [
    (s: string) => s.replace(/o\.status NOT IN \('cancelled', 'returned'\)/g, "1 = 1"),
    (s: string) => s.replace(/\(1 - oi\.discount_pct \/ 100\.0\)/g, "1"),
  ].filter((f) => f(sql) !== sql);
  const generic = [
    (s: string) => s.replace(/status != 'cancelled'/g, "1 = 1"),
    (s: string) => s.replace(/LIMIT (\d+)/i, (_, n) => `LIMIT ${Number(n) + 1}`),
    (s: string) => s.replace(/\bDESC\b/, "ASC"),
    (s: string) => s.replace(/COUNT\(\*\)/, "COUNT(*) + 1"),
    (s: string) => s.replace(/FROM orders/, "FROM orders_archive"), // schema guess -> SQL error
  ].filter((f) => f(sql) !== sql);
  const pool = preferRevenueMistake && revenueMistakes.length ? revenueMistakes : [...revenueMistakes, ...generic];
  if (!pool.length) return sql.replace(/^SELECT/i, "SELECT 1 AS wrong,");
  return pool[Math.floor(r() * pool.length)](sql);
}

function describeRows(value: unknown): string {
  const v = value as { columns?: string[]; rows?: unknown[][]; error?: string } | undefined;
  if (!v || v.error) return "I couldn't compute that from the data.";
  const rows = v.rows ?? [];
  if (rows.length === 0) return "The query returned no rows.";
  if (rows.length === 1 && rows[0].length === 1) return `The answer is ${String(rows[0][0])}.`;
  const shown = rows.slice(0, 3).map((r) => r.map((c) => String(c)).join(": ")).join("; ");
  return `Top results: ${shown}${rows.length > 3 ? ` (and ${rows.length - 3} more)` : ""}.`;
}

const UNANSWERABLE_HINTS = /conversion|marketing|channel|profit|margin|cost|traffic|session|click|campaign|refund reason|inventory|stock|employee|salary/i;

export interface MockOptions {
  modelId?: string;
}

/** Per-question trial counter so repeated trials of a case see different (but reproducible) draws. */
const trialCounters = new Map<string, number>();
export function resetMockTrials() {
  trialCounters.clear();
}

export function mockAnalystModel({ modelId = "mock-analyst" }: MockOptions = {}): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId,
    supportedUrls: {},
    async doStream() {
      throw new Error("mock analyst does not stream");
    },
    async doGenerate(opts) {
      const { system, user, toolResults } = parsePrompt(opts);
      const key = normalizeQuestion(user);
      // The trial index travels inside our own tool-call ids, so each conversation
      // stays self-consistent even when several trials of one case run concurrently.
      const priorIds = opts.prompt.flatMap((m) =>
        m.role === "assistant" ? m.content.filter((p) => p.type === "tool-call").map((p) => (p as { toolCallId: string }).toolCallId) : [],
      );
      let trial = Number(/_t(\d+)_/.exec(priorIds[0] ?? "")?.[1] ?? NaN);
      if (Number.isNaN(trial)) {
        trial = (trialCounters.get(key) ?? -1) + 1;
        trialCounters.set(key, trial);
      }
      const callId = (n: number) => `call_${hash32(key) % 100000}_t${trial}_${n}`;

      // Step 0: look at the schema (if the prompt tells us to).
      if (toolResults.length === 0 && /listTables|describeTable/.test(system)) {
        return result([toolCall("listTables", {}, callId(0))], "tool-calls");
      }
      const r = rng(hash32(`${key}#${trial}#${modelId}`));
      const entry = oracle().get(key);
      const ranQuery = toolResults.find((t) => t.toolName === "runQuery");

      // Final step: submit an answer grounded in what the query returned.
      if (ranQuery) {
        const lastQuery = [...opts.prompt]
          .flatMap((m) => (m.role === "assistant" ? m.content : []))
          .filter((p) => p.type === "tool-call" && p.toolName === "runQuery")
          .pop() as { input: unknown } | undefined;
        const input = typeof lastQuery?.input === "string" ? JSON.parse(lastQuery.input) : lastQuery?.input;
        const sloppyAnswer = rng(hash32(`${key}#${trial}#${modelId}#answer`))() < 0.015;
        const answer = sloppyAnswer ? "Here is the breakdown you asked for." : describeRows(ranQuery.value);
        return result([toolCall("submitAnswer", { sql: input?.sql ?? "", answer }, callId(2))], "tool-calls");
      }

      // Decide what to do with the question.
      const unanswerable = entry ? entry.sql === null : UNANSWERABLE_HINTS.test(user);
      if (unanswerable) {
        if (r() < 0.96) {
          return result(
            [toolCall("submitAnswer", { sql: "", answer: "The database doesn't contain that information, so I can't answer it." }, callId(1))],
            "tool-calls",
          );
        }
        return result([toolCall("runQuery", { sql: "SELECT COUNT(*) AS n FROM customers" }, callId(1))], "tool-calls");
      }

      const goldSql = entry?.sql ?? "SELECT COUNT(*) AS orders FROM orders WHERE status != 'cancelled'";
      const isRevenue = /discount_pct|status NOT IN/.test(goldSql);
      const hasGlossary = /business glossary/i.test(system);
      const hasSchemaRule = /never guess column names/i.test(system);
      const base = { easy: 0.01, medium: 0.03, hard: 0.2 }[entry?.difficulty ?? "medium"] + (entry?.ambiguous ? 0.05 : 0);
      let pErr = base;
      if (!hasGlossary && isRevenue) pErr += 0.65;
      if (!hasSchemaRule) pErr += 0.1;
      if (/nano/.test(modelId)) pErr += 0.15;
      const sql = r() < Math.min(0.95, pErr) ? mutate(goldSql, r, !hasGlossary && isRevenue) : goldSql;
      return result([toolCall("runQuery", { sql }, callId(1))], "tool-calls");
    },
  };
}

/** Mock judge: returns a JSON label consistent with how grounded the answer is in the rows. */
export function mockJudgeModel({ modelId = "mock-judge" }: MockOptions = {}): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId,
    supportedUrls: {},
    async doStream() {
      throw new Error("mock judge does not stream");
    },
    async doGenerate(opts) {
      const { user } = parsePrompt(opts);
      const answer = /<answer>([\s\S]*?)<\/answer>/.exec(user)?.[1] ?? "";
      const rows = /<rows>([\s\S]*?)<\/rows>/.exec(user)?.[1] ?? "";
      const nums = answer.match(/-?\d[\d,]*(\.\d+)?/g)?.map((n) => n.replace(/,/g, "")) ?? [];
      const declined = /can't|cannot|doesn't contain|not available/i.test(answer);
      const grounded = nums.length > 0 && nums.every((n) => rows.includes(n));
      const h = hash32(answer) % 10;
      let label: string;
      if (declined) label = rows.trim() === "" || rows.includes("[]") ? "great" : "weak";
      else if (grounded) label = h < 7 ? "great" : "acceptable";
      else if (nums.length === 0) label = h < 5 ? "weak" : "acceptable";
      else label = h < 6 ? "wrong" : "weak";
      const text = JSON.stringify({ reasoning: `mock judge: grounded=${grounded} declined=${declined}`, label });
      return result([{ type: "text", text }], "stop");
    },
  };
}

/** Mock drafter: proposes gold SQL for a curated question (from the oracle). */
export function mockDrafterModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-drafter",
    supportedUrls: {},
    async doStream() {
      throw new Error("mock drafter does not stream");
    },
    async doGenerate(opts) {
      const { user } = parsePrompt(opts);
      const q = /<question>([\s\S]*?)<\/question>/.exec(user)?.[1] ?? user;
      const entry = oracle().get(normalizeQuestion(q));
      const text = JSON.stringify({ answerable: entry ? entry.sql !== null : false, sql: entry?.sql ?? "" });
      return result([{ type: "text", text }], "stop");
    },
  };
}

/**
 * Hashing-trick embedding (word unigrams + char trigrams). Deterministic and
 * dependency-free, but LEXICAL: it catches near-verbatim repeats, not paraphrases
 * ("AOV" vs "average order value"). Semantic dedupe needs the real embedding model.
 */
export function hashEmbed(text: string, dims = 256): number[] {
  const v = new Array(dims).fill(0);
  const norm = normalizeQuestion(text);
  const feats = [...norm.split(" "), ...Array.from({ length: Math.max(0, norm.length - 2) }, (_, i) => norm.slice(i, i + 3))];
  for (const f of feats) v[hash32(f) % dims] += 1;
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / len);
}

export function mockEmbeddingModel(): EmbeddingModelV4 {
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-embedding",
    maxEmbeddingsPerCall: 2048,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      return { embeddings: values.map((t) => hashEmbed(t)), warnings: [] };
    },
  } as EmbeddingModelV4;
}
