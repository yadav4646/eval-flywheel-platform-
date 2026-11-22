import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnalyst } from "../server/analyst";
import { createApp } from "../server/index";
import { createSink } from "../server/tracing";
import { pullLocal } from "../flywheel/curate/pull";

describe("server + local tracing", () => {
  const dir = mkdtempSync(join(tmpdir(), "traces-"));
  const app = createApp(createAnalyst({ mock: true, sink: createSink("local", dir) }));
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("answers, traces the turn, and attaches feedback", async () => {
    const res = await post("/api/ask", { question: "How many customers are in Germany?" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spanId: string; sql: string; answer: string; rows: unknown[][] };
    expect(body.sql).toMatch(/country = 'DE'/);
    expect(body.rows).toEqual([[55]]);

    expect((await post("/api/feedback", { spanId: body.spanId, rating: "down", correctedSql: "DROP TABLE orders" })).status).toBe(400);
    expect((await post("/api/feedback", { spanId: body.spanId, rating: "down", correctedSql: "SELECT COUNT(*) FROM customers WHERE country = 'DE'" })).status).toBe(200);

    const traces = pullLocal(undefined, dir);
    expect(traces).toHaveLength(1);
    expect(traces[0].scores.executes).toBe(1);
    expect(traces[0].feedback).toMatchObject({ rating: "down", correctedSql: "SELECT COUNT(*) FROM customers WHERE country = 'DE'" });
  });

  it("validates input", async () => {
    expect((await post("/api/ask", { nope: 1 })).status).toBe(400);
  });
});
