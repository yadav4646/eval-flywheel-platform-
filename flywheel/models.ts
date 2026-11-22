// Model factory: real OpenAI models, or deterministic mocks when --mock / MOCK=1
// (or when no OPENAI_API_KEY is set and the caller allows falling back).

import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";
import { config } from "./config";
import { mockAnalystModel, mockDrafterModel, mockEmbeddingModel, mockJudgeModel } from "./mock/model";

export function isMock(flag?: boolean): boolean {
  if (flag !== undefined) return flag;
  return process.env.MOCK === "1" || !process.env.OPENAI_API_KEY;
}

let openai: ReturnType<typeof createOpenAI> | null = null;
function provider() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set. Use --mock to run without it.");
  openai ??= createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/** Model ids are recorded in fingerprints; mocks are prefixed so they never collide with real runs. */
export function agentModelId(mock: boolean, override?: string) {
  const id = override ?? config.models.agent;
  return mock ? `mock:${id}` : id;
}

export function agentModel(mock: boolean, override?: string): LanguageModel {
  const id = override ?? config.models.agent;
  return mock ? mockAnalystModel({ modelId: `mock:${id}` }) : provider()(id);
}

export function judgeModelId(mock: boolean) {
  return mock ? `mock:${config.models.judge}` : config.models.judge;
}

export function judgeModel(mock: boolean): LanguageModel {
  return mock ? mockJudgeModel({ modelId: judgeModelId(true) }) : provider()(config.models.judge);
}

export function drafterModel(mock: boolean): LanguageModel {
  return mock ? mockDrafterModel() : provider()(config.models.drafter);
}

export function embeddingModel(mock: boolean): EmbeddingModel {
  return mock ? mockEmbeddingModel() : provider().embedding(config.models.embedding);
}
