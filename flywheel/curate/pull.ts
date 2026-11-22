// Pull analyst turns from Braintrust (BTQL over project logs) or from the local
// trace files, merge user feedback in, and advance a cursor so each trace is
// curated once.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { STATE_DIR, TRACES_DIR } from "../paths";
import type { TraceRecord } from "./types";

const API = process.env.BRAINTRUST_API_URL ?? "https://api.braintrust.dev";

interface RawRow {
  id: string;
  created: string;
  input?: { question?: string };
  output?: { sql?: string; answer?: string; rowCount?: number; error?: string; submitted?: boolean };
  expected?: { sql?: string } | null;
  scores?: Record<string, number | null>;
  metadata?: Record<string, unknown> | null;
}

export function normalize(row: RawRow, fb: TraceRecord["feedback"] = {}): TraceRecord | null {
  const question = row.input?.question;
  if (!question) return null;
  const rating = row.scores?.user_rating;
  return {
    id: row.id,
    createdAt: row.created,
    question,
    output: {
      sql: row.output?.sql ?? "",
      answer: row.output?.answer ?? "",
      rowCount: row.output?.rowCount ?? 0,
      error: row.output?.error,
      submitted: row.output?.submitted ?? false,
    },
    scores: row.scores ?? {},
    metadata: (row.metadata ?? {}) as TraceRecord["metadata"],
    feedback: {
      rating: fb.rating ?? (rating === 1 ? "up" : rating === 0 ? "down" : undefined),
      correctedSql: fb.correctedSql ?? row.expected?.sql ?? (row.metadata?.correctedSql as string | undefined),
      comment: fb.comment,
    },
  };
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

export function pullLocal(since?: string, dir = TRACES_DIR): TraceRecord[] {
  const feedback = new Map<string, TraceRecord["feedback"]>();
  for (const f of readJsonl<{ spanId: string } & TraceRecord["feedback"]>(join(dir, "feedback.jsonl"))) {
    const prev = feedback.get(f.spanId) ?? {};
    feedback.set(f.spanId, { rating: f.rating ?? prev.rating, correctedSql: f.correctedSql ?? prev.correctedSql, comment: f.comment ?? prev.comment });
  }
  return readJsonl<RawRow>(join(dir, "turns.jsonl"))
    .filter((r) => !since || r.created > since)
    .map((r) => normalize(r, feedback.get(r.id)))
    .filter((t): t is TraceRecord => t !== null);
}

async function bt(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.BRAINTRUST_API_KEY}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Braintrust ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function pullBraintrust(since?: string, limit = 1000): Promise<TraceRecord[]> {
  if (!process.env.BRAINTRUST_API_KEY) throw new Error("BRAINTRUST_API_KEY is not set (use --source local).");
  const projects = (await bt(`/v1/project?project_name=${encodeURIComponent(config.braintrustProject)}`)) as { objects: { id: string }[] };
  const projectId = projects.objects[0]?.id;
  if (!projectId) throw new Error(`Braintrust project "${config.braintrustProject}" not found. Has the server logged anything yet?`);
  const filters = [`span_attributes.name = 'analyst-turn'`, since ? `created > '${since.replace(/'/g, "")}'` : ""].filter(Boolean).join(" and ");
  const query = `select: * | from: project_logs('${projectId}') | filter: ${filters} | sort: created asc | limit: ${limit}`;
  const { data } = (await bt("/btql", { method: "POST", body: JSON.stringify({ query, fmt: "json" }) })) as { data: RawRow[] };
  return data.map((r) => normalize(r)).filter((t): t is TraceRecord => t !== null);
}

const cursorPath = (source: string) => join(STATE_DIR, `curation-cursor-${source}.json`);

export function readCursor(source: string): string | undefined {
  const p = cursorPath(source);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as { since: string }).since : undefined;
}

export function writeCursor(source: string, since: string) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(cursorPath(source), JSON.stringify({ since }));
}
