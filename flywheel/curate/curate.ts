// The curation pipeline: production traces -> golden dataset.
//
//   pull -> classify (signals) -> dedupe (embeddings) -> toCase (gold SQL) -> stratified promote
//
// New cases land in evals/datasets/golden.jsonl (and the Braintrust dataset when a
// key is set) as suite=capability. Unless the gold came from a human correction
// they are status=candidate: they run in every eval but never gate CI until a
// human accepts them with `npm run curate:review`.

import { initDataset } from "braintrust";
import { loadGolden, saveGolden, type GoldenCase } from "../../evals/dataset";
import { config } from "../config";
import { drafterModel, embeddingModel } from "../models";
import { dedupe, Embedder } from "./dedupe";
import { pullBraintrust, pullLocal, readCursor, writeCursor } from "./pull";
import { classify } from "./signals";
import { toCase } from "./toCase";
import type { Classified, TraceRecord } from "./types";

export interface CurateOptions {
  mock: boolean;
  source?: "braintrust" | "local";
  since?: string;
  dryRun?: boolean;
  maxNew?: number;
  traces?: TraceRecord[]; // inject (tests)
  goldenPath?: string;
}

export interface CurateResult {
  pulled: number;
  classified: Classified[];
  duplicates: { question: string; duplicateOf: string; similarity: number }[];
  rejected: { question: string; reason: string }[];
  promoted: GoldenCase[];
  overflow: number;
}

/** Highest priority first, then round-robin across kinds so one failure mode can't flood the dataset. */
export function stratify(cases: { c: GoldenCase; priority: number }[], max: number): GoldenCase[] {
  const byKind = new Map<string, { c: GoldenCase; priority: number }[]>();
  for (const x of [...cases].sort((a, b) => b.priority - a.priority)) {
    byKind.set(x.c.tags.kind, [...(byKind.get(x.c.tags.kind) ?? []), x]);
  }
  const out: GoldenCase[] = [];
  const lists = [...byKind.values()].sort((a, b) => b[0].priority - a[0].priority);
  while (out.length < max && lists.some((l) => l.length)) {
    for (const l of lists) if (l.length && out.length < max) out.push(l.shift()!.c);
  }
  return out;
}

export async function runCuration(opts: CurateOptions): Promise<CurateResult> {
  const source = opts.source ?? (process.env.BRAINTRUST_API_KEY && !opts.mock ? "braintrust" : "local");
  const since = opts.since ?? readCursor(source);
  const traces = opts.traces ?? (source === "braintrust" ? await pullBraintrust(since) : pullLocal(since));
  const golden = loadGolden(opts.goldenPath);

  const classified = traces
    .map((t) => classify(t))
    .filter((c): c is Classified => c !== null)
    .sort((a, b) => b.priority - a.priority);

  const embedder = new Embedder(embeddingModel(opts.mock), opts.mock ? "mock" : config.models.embedding);
  const { kept, dropped } = await dedupe(classified, (c) => c.trace.question, golden.map((g) => g.question), embedder, config.curation.dedupeCosine);

  const drafter = drafterModel(opts.mock);
  const rejected: CurateResult["rejected"] = [];
  const built: { c: GoldenCase; priority: number }[] = [];
  for (const item of kept) {
    const r = await toCase(item, drafter);
    if (r.ok) built.push({ c: r.case, priority: item.priority });
    else rejected.push({ question: item.trace.question, reason: r.reason });
  }
  const max = opts.maxNew ?? config.curation.maxNewCasesPerRun;
  const existingIds = new Set(golden.map((g) => g.id));
  const promoted = stratify(built.filter((b) => !existingIds.has(b.c.id)), max);

  if (!opts.dryRun) {
    if (promoted.length) {
      saveGolden([...golden, ...promoted], opts.goldenPath);
      if (process.env.BRAINTRUST_API_KEY && !opts.mock) {
        const ds = initDataset({ project: config.braintrustProject, dataset: config.datasetName });
        for (const c of promoted) {
          ds.insert({ id: c.id, input: { question: c.question }, expected: { sql: c.goldSql, acceptableSql: c.acceptableSql }, metadata: { ...c.tags, suite: c.suite, status: c.status, ...c.provenance } });
        }
        await ds.flush();
      }
    }
    const latest = traces.map((t) => t.createdAt).sort().pop();
    if (latest && !opts.traces) writeCursor(source, latest);
  }

  return {
    pulled: traces.length,
    classified,
    duplicates: dropped.map((d) => ({ question: d.item.trace.question, duplicateOf: d.duplicateOf, similarity: d.similarity })),
    rejected,
    promoted,
    overflow: built.length - promoted.length,
  };
}

export function renderCuration(r: CurateResult, dryRun = false): string {
  const bySignal = new Map<string, number>();
  for (const c of r.classified) bySignal.set(c.signal, (bySignal.get(c.signal) ?? 0) + 1);
  return [
    `## Curation${dryRun ? " (dry run)" : ""}`,
    "",
    `Pulled **${r.pulled}** traces → **${r.classified.length}** with a curation signal → **${r.duplicates.length}** near-duplicates dropped → **${r.rejected.length}** rejected → **${r.promoted.length}** new cases${r.overflow > 0 ? ` (${r.overflow} more held back by the per-run cap)` : ""}.`,
    "",
    `Signals: ${[...bySignal].map(([s, n]) => `${s} ×${n}`).join(", ") || "none"}`,
    "",
    r.promoted.length ? "| New case | Kind | Signal | Gold from | Status |\n|---|---|---|---|---|" : null,
    ...r.promoted.map((c) => `| ${c.question} | ${c.tags.kind} | ${c.provenance.signal} | ${c.provenance.goldFrom} | ${c.status} |`),
    "",
    r.duplicates.length
      ? `<details><summary>Near-duplicates dropped (${r.duplicates.length})</summary>\n\n${r.duplicates.map((d) => `- "${d.question}" ≈ "${d.duplicateOf}" (cos ${d.similarity.toFixed(2)})`).join("\n")}\n\n</details>`
      : null,
    r.rejected.length ? `<details><summary>Rejected (${r.rejected.length})</summary>\n\n${r.rejected.map((x) => `- "${x.question}": ${x.reason}`).join("\n")}\n\n</details>` : null,
    r.promoted.some((c) => c.status === "candidate") ? "\nCandidates run in every eval but don't gate CI until reviewed: `npm run curate:review`." : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export async function curate(opts: CurateOptions): Promise<string> {
  return renderCuration(await runCuration(opts), opts.dryRun);
}
