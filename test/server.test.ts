import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { GitManager } from "../src/git.js";
import type { ModelMessage, ModelRoute } from "../src/model.js";
import type { BrokerPort, ModelPort } from "../src/orchestrator.js";
import { createServer } from "../src/server.js";
import { ForgeStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class QueueModel implements ModelPort {
  constructor(private readonly values: unknown[]) {}
  async callJson<T>(_route: ModelRoute, _messages: ModelMessage[], schema: z.ZodType<T>): Promise<T> {
    return schema.parse(this.values.shift());
  }
}

const broker: BrokerPort = {
  async health() { return { status: "ok" }; },
  async run() { throw new Error("not expected"); },
  async preview() { throw new Error("not expected"); },
};

describe("HTTP API", () => {
  it("creates a project from natural language and exposes durable state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forgeos-server-")); roots.push(root);
    const app = await createServer({
      store: new ForgeStore(":memory:"), workspaceRoot: root, staticRoot: path.resolve("public"), logger: false,
      git: new GitManager(), broker,
      model: new QueueModel([
        { name: "Habit Ledger", requirements: [{ id: "tracking", title: "Track habits", description: "Record daily completion", acceptanceCriteria: ["A habit can be marked complete"] }] },
        { summary: "Build a zero-dependency habit tracker", implementationNotes: ["Use server-rendered HTML"] },
      ]),
    });
    const created = await app.inject({ method: "POST", url: "/api/projects", payload: { message: "创建一个习惯追踪应用" } });
    expect(created.statusCode).toBe(201);
    const project = created.json().project;
    const snapshot = await app.inject({ method: "GET", url: `/api/projects/${project.id}/snapshot` });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().tasks.some((task: { kind: string }) => task.kind === "planning")).toBe(true);
    expect(snapshot.json().questions[0].status).toBe("open");
    const events = await app.inject({ method: "GET", url: `/api/projects/${project.id}/events?afterSeq=0` });
    expect(events.json().events.length).toBeGreaterThan(4);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().broker).toBe("ok");
    await app.close();
  });

  it("rejects invalid natural-language requests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forgeos-server-")); roots.push(root);
    const app = await createServer({ store: new ForgeStore(":memory:"), workspaceRoot: root, staticRoot: path.resolve("public"), logger: false, model: new QueueModel([]), git: new GitManager(), broker });
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: { message: "x" } })).statusCode).toBe(400);
    await app.close();
  });
});
