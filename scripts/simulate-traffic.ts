// Bootstraps production traces before real users exist: sends the question pool
// (paraphrases of golden cases, new questions, ambiguous and unanswerable ones)
// through the same traced entry point the server uses. Traces are tagged
// source=simulated. No feedback is fabricated; only the online scores are real.
//
//   npm run simulate -- [--mock] [--n 42] [--repeat 1]

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createAnalyst } from "../server/analyst";
import { isMock } from "../flywheel/models";
import { ROOT } from "../flywheel/paths";

const { values } = parseArgs({ options: { mock: { type: "boolean" }, n: { type: "string" }, repeat: { type: "string" }, concurrency: { type: "string" } } });
const mock = isMock(values.mock);
const pool: { question: string }[] = JSON.parse(readFileSync(join(ROOT, "scripts", "traffic-pool.json"), "utf-8"));
const questions = Array.from({ length: Number(values.repeat ?? 1) }, () => pool.map((p) => p.question)).flat().slice(0, Number(values.n ?? Infinity));

const analyst = createAnalyst({ mock });
console.log(`Simulating ${questions.length} turns (${mock ? "mock" : "openai"} model, traces -> ${analyst.sink.kind})`);
let done = 0;
let failed = 0;
const queue = [...questions];
await Promise.all(
  Array.from({ length: Number(values.concurrency ?? 4) }, async () => {
    for (let q = queue.shift(); q !== undefined; q = queue.shift()) {
      const res = await analyst.ask(q, { source: "simulated", sessionId: "simulator" });
      if (res.error) failed++;
      done++;
      process.stdout.write(`  ${done}/${questions.length}\r`);
    }
  }),
);
await analyst.sink.flush();
console.log(`\nDone: ${done} turns, ${failed} with SQL errors. Next: npm run curate${mock ? " -- --mock" : ""}`);
