#!/usr/bin/env tsx
// One entry point for the whole flywheel:
//
//   eval       run k trials per case, write results/<runId>.json + reports/latest.md
//   baseline   run (or copy a run) into reports/baseline[.mock].json
//   gate       pass/fail a run against the baseline (CI)
//   attribute  explain WHY a run differs from the baseline
//   curate     pull production traces -> new golden cases
//   review     accept/edit/reject curated candidate cases
//   label      hand-label answers for judge calibration
//   calibrate  measure judge-vs-human agreement (kappa)

import "dotenv/config";
import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { isMock } from "./models";
import { REPORTS_DIR } from "./paths";
import { renderRun } from "./report";
import { latestRunPath, loadRun, saveRun } from "./results";
import type { Kind, Suite, Status } from "../evals/dataset";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    mock: { type: "boolean" },
    k: { type: "string" },
    ci: { type: "boolean" },
    suite: { type: "string" },
    status: { type: "string" },
    kind: { type: "string", multiple: true },
    ids: { type: "string" },
    limit: { type: "string" },
    "no-judge": { type: "boolean" },
    "no-send": { type: "boolean" },
    label: { type: "string" },
    out: { type: "string" },
    base: { type: "string" },
    head: { type: "string" },
    run: { type: "string" },
    "no-ablate": { type: "boolean" },
    bisect: { type: "boolean" },
    report: { type: "string" },
    source: { type: "string" },
    since: { type: "string" },
    "dry-run": { type: "boolean" },
    n: { type: "string" },
    labeler: { type: "string" },
    threshold: { type: "string" },
    "report-only": { type: "boolean" },
  },
});

const cmd = positionals[0];
const mock = isMock(values.mock);
const k = Number(values.k ?? (values.ci ? config.eval.trials.ci : config.eval.trials.local));

function filter() {
  return {
    suite: values.suite as Suite | undefined,
    status: values.status as Status | undefined,
    kinds: values.kind as Kind[] | undefined,
    ids: values.ids?.split(",").map((s) => s.trim()),
    limit: values.limit ? Number(values.limit) : undefined,
  };
}

export function defaultBaselinePath(isMockRun: boolean) {
  return join(REPORTS_DIR, isMockRun ? "baseline.mock.json" : "baseline.json");
}

async function main() {
  switch (cmd) {
    case "eval": {
      const { runEval } = await import("./run");
      const run = await runEval({ mock, k, filter: filter(), judge: !values["no-judge"], label: values.label, sendLogs: values["no-send"] ? false : undefined });
      const path = saveRun(run, values.out);
      const md = renderRun(run);
      mkdirSync(REPORTS_DIR, { recursive: true });
      writeFileSync(join(REPORTS_DIR, "latest.md"), md + "\n");
      console.log(md);
      console.log(`\nResults: ${path}`);
      break;
    }
    case "baseline": {
      // Promote an existing run, or run a fresh one, to the committed baseline.
      let path = values.run;
      if (!path) {
        const { runEval } = await import("./run");
        const run = await runEval({ mock, k, filter: filter(), judge: !values["no-judge"], label: "baseline" });
        path = saveRun(run);
      }
      const run = loadRun(path);
      const dest = values.out ?? defaultBaselinePath(run.mode === "mock");
      copyFileSync(path, dest);
      console.log(renderRun(run));
      console.log(`\nBaseline updated: ${dest}  (commit it in your PR so the change is reviewed)`);
      break;
    }
    case "gate": {
      const { gate, renderGate } = await import("./gate/gate");
      const headPath = values.head ?? latestRunPath();
      if (!headPath) throw new Error("No run to gate. Run `npm run eval` first or pass --head.");
      const head = loadRun(headPath);
      const basePath = values.base ?? defaultBaselinePath(head.mode === "mock");
      const base = existsSync(basePath) ? loadRun(basePath) : undefined;
      const verdict = gate(head, base);
      const md = renderGate(verdict, head, base);
      if (values.report) writeFileSync(values.report, md + "\n");
      console.log(md);
      if (!verdict.passed && !values["report-only"]) process.exit(1);
      break;
    }
    case "attribute": {
      const { attribute, renderAttribution } = await import("./attribution/attribute");
      const headPath = values.head ?? latestRunPath();
      if (!headPath) throw new Error("No head run. Pass --head.");
      const head = loadRun(headPath);
      const base = loadRun(values.base ?? defaultBaselinePath(head.mode === "mock"));
      const result = await attribute(base, head, { ablate: !values["no-ablate"], bisect: !!values.bisect });
      const md = renderAttribution(result);
      if (values.report) writeFileSync(values.report, md + "\n");
      console.log(md);
      break;
    }
    case "bisect-step": {
      const { bisectStep } = await import("./attribution/bisect");
      process.exit(await bisectStep({ ids: values.ids!.split(","), threshold: Number(values.threshold ?? 0.5), k, mock }));
    }
    case "curate": {
      const { curate } = await import("./curate/curate");
      const report = await curate({ mock, source: values.source as "braintrust" | "local" | undefined, since: values.since, dryRun: !!values["dry-run"] });
      if (values.report) writeFileSync(values.report, report + "\n");
      console.log(report);
      break;
    }
    case "review": {
      const { review } = await import("./curate/review");
      await review();
      break;
    }
    case "label": {
      const { labelCli } = await import("./label/cli");
      await labelCli({ runPath: values.run ?? latestRunPath(), n: Number(values.n ?? 20), labeler: values.labeler });
      break;
    }
    case "calibrate": {
      const { calibrate, renderCalibration } = await import("./judge/calibrate");
      const cal = await calibrate({ mock });
      const md = renderCalibration(cal);
      writeFileSync(join(REPORTS_DIR, "judge-calibration.md"), md + "\n");
      console.log(md);
      break;
    }
    default:
      console.log(`Usage: tsx flywheel/cli.ts <eval|baseline|gate|attribute|curate|review|label|calibrate> [--mock] [--k N] ...
See README.md for every flag.`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? (process.env.DEBUG ? e.stack : e.message) : e);
  process.exit(1);
});
