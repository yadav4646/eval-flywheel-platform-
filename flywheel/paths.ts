import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DB_PATH = process.env.SHOP_DB_PATH ?? join(ROOT, "db", "shop.sqlite");
export const GOLDEN_PATH = join(ROOT, "evals", "datasets", "golden.jsonl");
export const EMBED_CACHE_PATH = join(ROOT, "evals", "datasets", ".embeddings.json");
export const RESULTS_DIR = join(ROOT, "results");
export const REPORTS_DIR = join(ROOT, "reports");
export const LABELS_PATH = join(ROOT, "labels", "human.jsonl");
export const TRACES_DIR = join(ROOT, "traces");
export const STATE_DIR = join(ROOT, "flywheel", "state");
export const CALIBRATION_PATH = join(REPORTS_DIR, "judge-calibration.json");
