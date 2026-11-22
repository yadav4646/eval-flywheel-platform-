// What the mock "knows": question -> intended SQL. Built from the golden dataset
// plus the traffic-simulation pool. Used ONLY by the mock models (keyless mode);
// the real agent never sees it.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadGolden, type GoldenCase } from "../../evals/dataset";
import { ROOT } from "../paths";

export interface OracleEntry {
  sql: string | null;
  difficulty: "easy" | "medium" | "hard";
  ambiguous: boolean;
}

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").replace(/\s+/g, " ").trim();
}

let cache: Map<string, OracleEntry> | null = null;

export function oracle(): Map<string, OracleEntry> {
  if (cache) return cache;
  const m = new Map<string, OracleEntry>();
  const add = (q: string, e: OracleEntry) => m.set(normalizeQuestion(q), e);
  for (const c of loadGolden() as GoldenCase[]) {
    add(c.question, { sql: c.goldSql, difficulty: c.tags.difficulty, ambiguous: c.tags.kind === "ambiguous" });
  }
  const pool = join(ROOT, "scripts", "traffic-pool.json");
  if (existsSync(pool)) {
    for (const p of JSON.parse(readFileSync(pool, "utf-8")) as { question: string; mockSql: string | null; difficulty?: OracleEntry["difficulty"] }[]) {
      if (!m.has(normalizeQuestion(p.question))) add(p.question, { sql: p.mockSql, difficulty: p.difficulty ?? "medium", ambiguous: false });
    }
  }
  cache = m;
  return m;
}

export function resetOracle() {
  cache = null;
}
