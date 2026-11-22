// Human review of auto-curated candidates. Accepting a case makes it gate CI
// (as a capability case, or a regression case if you graduate it).
//
//   npm run curate:review

import { createPrompter } from "../label/prompt";
import { assertReadOnly, tryRunSql } from "../../agent/db";
import { loadGolden, saveGolden } from "../../evals/dataset";

export async function review() {
  const cases = loadGolden();
  const pending = cases.filter((c) => c.status === "candidate");
  if (!pending.length) return console.log("No candidate cases to review.");
  const rl = createPrompter();
  console.log(`${pending.length} candidates. [a] accept as capability · [r] accept as regression · [e] edit gold SQL · [x] reject · [s] skip · [q] quit\n`);
  try {
    for (const c of pending) {
      console.log(`━━━ ${c.id} (${c.tags.kind}/${c.tags.difficulty}, signal: ${c.provenance.signal}, gold from: ${c.provenance.goldFrom})`);
      console.log(`Q: ${c.question}`);
      console.log(`Gold SQL: ${c.goldSql ?? "(none: should be declined as unanswerable)"}`);
      if (c.goldSql) {
        const res = tryRunSql(c.goldSql);
        console.log("error" in res ? `  ERROR: ${res.error}` : `  → ${res.rowCount} rows: ${JSON.stringify(res.rows.slice(0, 5))}`);
      }
      let choice = "";
      while (!["a", "r", "e", "x", "s", "q"].includes(choice)) choice = ((await rl.ask("> ")) ?? "q").trim().toLowerCase();
      if (choice === "q") break;
      if (choice === "s") continue;
      if (choice === "x") {
        cases.splice(cases.indexOf(c), 1);
      } else {
        if (choice === "e") {
          const sql = ((await rl.ask("New gold SQL (empty = unanswerable): ")) ?? "").trim();
          if (sql) {
            try {
              assertReadOnly(sql);
            } catch (e) {
              console.log(`Rejected: ${(e as Error).message}`);
              continue;
            }
            const res = tryRunSql(sql);
            if ("error" in res) {
              console.log(`Rejected: ${res.error}`);
              continue;
            }
          }
          c.goldSql = sql || null;
        }
        c.status = "reviewed";
        c.suite = choice === "r" ? "regression" : "capability";
      }
      saveGolden(cases);
      console.log("saved\n");
    }
  } finally {
    rl.close();
  }
}
