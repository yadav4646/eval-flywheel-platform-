import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { GOLDEN_PATH } from "../flywheel/paths";

export type Kind = "filter" | "join" | "aggregate" | "window" | "date" | "ambiguous" | "unanswerable";
export type Difficulty = "easy" | "medium" | "hard";
/** regression: must keep passing (gated). capability: what we're trying to get better at (tracked, softly gated). */
export type Suite = "regression" | "capability";
/** candidate: auto-curated, not yet reviewed by a human; never gates CI. */
export type Status = "reviewed" | "candidate";

export interface GoldenCase {
  id: string;
  question: string;
  /** null = the database cannot answer this; the agent should decline. */
  goldSql: string | null;
  /** Other interpretations that also count as correct (ambiguous questions). */
  acceptableSql: string[];
  tags: { kind: Kind; difficulty: Difficulty; topics: string[] };
  suite: Suite;
  status: Status;
  provenance: {
    source: "handwritten" | "production" | "simulated";
    createdAt: string;
    traceId?: string;
    signal?: string;
    goldFrom?: "user_correction" | "accepted_output" | "llm_draft";
  };
}

export function loadGolden(path = GOLDEN_PATH): GoldenCase[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GoldenCase);
}

export function saveGolden(cases: GoldenCase[], path = GOLDEN_PATH) {
  writeFileSync(path, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
}

export interface CaseFilter {
  suite?: Suite;
  status?: Status;
  ids?: string[];
  kinds?: Kind[];
  limit?: number;
}

export function filterCases(cases: GoldenCase[], f: CaseFilter = {}): GoldenCase[] {
  let out = cases.filter(
    (c) =>
      (!f.suite || c.suite === f.suite) &&
      (!f.status || c.status === f.status) &&
      (!f.ids || f.ids.includes(c.id)) &&
      (!f.kinds || f.kinds.includes(c.tags.kind)),
  );
  if (f.limit) out = out.slice(0, f.limit);
  return out;
}
