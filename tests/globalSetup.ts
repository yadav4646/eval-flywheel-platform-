import { existsSync } from "node:fs";
import { seed } from "../db/seed";
import { DB_PATH } from "../flywheel/paths";

export default function setup() {
  if (!existsSync(DB_PATH)) seed();
  process.env.MOCK = "1";
}
