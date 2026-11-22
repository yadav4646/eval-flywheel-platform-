// Minimal production surface: a question box backed by the analyst, with
// thumbs up/down and "correct the SQL" feedback that feeds the flywheel.
//
//   npm run serve            (real model; MOCK=1 for the deterministic mock)

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { isMock } from "../flywheel/models";
import { ROOT } from "../flywheel/paths";
import { createAnalyst, type AnalystService } from "./analyst";

const AskBody = z.object({ question: z.string().min(3).max(500), sessionId: z.string().max(100).optional() });
const FeedbackBody = z.object({
  spanId: z.string().min(1),
  rating: z.enum(["up", "down"]).optional(),
  correctedSql: z.string().max(4000).optional(),
  comment: z.string().max(1000).optional(),
});

export function createApp(analyst: AnalystService) {
  const app = new Hono();
  app.get("/", (c) => c.html(readFileSync(join(ROOT, "server", "public", "index.html"), "utf-8")));
  app.get("/api/health", (c) => c.json({ ok: true, tracing: analyst.sink.kind }));
  app.post("/api/ask", async (c) => {
    const body = AskBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Body must be { question: string }" }, 400);
    return c.json(await analyst.ask(body.data.question, { sessionId: body.data.sessionId }));
  });
  app.post("/api/feedback", async (c) => {
    const body = FeedbackBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid feedback body" }, 400);
    try {
      await analyst.feedback(body.data);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: `Corrected SQL rejected: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = isMock();
  const analyst = createAnalyst({ mock });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: createApp(analyst).fetch, port });
  console.log(`SQL Analyst on http://localhost:${port}  (model: ${mock ? "mock" : "openai"}, traces: ${analyst.sink.kind})`);
  const shutdown = async () => {
    await analyst.sink.flush();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
