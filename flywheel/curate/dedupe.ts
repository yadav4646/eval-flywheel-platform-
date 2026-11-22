// Near-duplicate detection on questions with embeddings (cosine similarity),
// cached on disk so re-runs don't re-embed the whole dataset.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cosineSimilarity, embedMany, type EmbeddingModel } from "ai";
import { normalizeQuestion } from "../mock/oracle";
import { EMBED_CACHE_PATH } from "../paths";

export class Embedder {
  private cache: Record<string, number[]>;
  constructor(private model: EmbeddingModel, private modelId: string, private cachePath = EMBED_CACHE_PATH) {
    this.cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf-8")) : {};
  }
  private key(text: string) {
    return createHash("sha256").update(`${this.modelId}\n${normalizeQuestion(text)}`).digest("hex").slice(0, 20);
  }
  async embed(texts: string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter((t) => !this.cache[this.key(t)]))];
    if (missing.length) {
      const { embeddings } = await embedMany({ model: this.model, values: missing });
      missing.forEach((t, i) => (this.cache[this.key(t)] = embeddings[i]));
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(this.cache));
    }
    return texts.map((t) => this.cache[this.key(t)]);
  }
}

export interface DedupeResult<T> {
  kept: T[];
  dropped: { item: T; duplicateOf: string; similarity: number }[];
}

/**
 * Keep items whose question is not within `threshold` cosine of any existing
 * question or of an item kept earlier in this batch (items should be sorted by priority).
 */
export async function dedupe<T>(items: T[], questionOf: (t: T) => string, existing: string[], embedder: Embedder, threshold: number): Promise<DedupeResult<T>> {
  const existingVecs = await embedder.embed(existing);
  const itemVecs = await embedder.embed(items.map(questionOf));
  const pool: { q: string; v: number[] }[] = existing.map((q, i) => ({ q, v: existingVecs[i] }));
  const exact = new Set(existing.map(normalizeQuestion));
  const kept: T[] = [];
  const dropped: DedupeResult<T>["dropped"] = [];
  items.forEach((item, i) => {
    const q = questionOf(item);
    if (exact.has(normalizeQuestion(q))) return dropped.push({ item, duplicateOf: q, similarity: 1 });
    let best = { q: "", s: -1 };
    for (const p of pool) {
      const s = cosineSimilarity(itemVecs[i], p.v);
      if (s > best.s) best = { q: p.q, s };
    }
    if (best.s >= threshold) return dropped.push({ item, duplicateOf: best.q, similarity: best.s });
    kept.push(item);
    pool.push({ q, v: itemVecs[i] });
    exact.add(normalizeQuestion(q));
  });
  return { kept, dropped };
}
