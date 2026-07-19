import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { BrokerClient } from "./broker-client.js";
import { GitManager } from "./git.js";
import { SiliconFlowGateway } from "./model.js";
import { Orchestrator, type BrokerPort, type GitPort, type ModelPort } from "./orchestrator.js";
import { ForgeStore } from "./store.js";

const createProjectSchema = z.object({ message: z.string().trim().min(3).max(12_000) }).strict();
const messageSchema = z.object({
  text: z.string().trim().min(1).max(12_000),
  contextQuestionId: z.string().uuid().optional(),
}).strict();
const idParamsSchema = z.object({ id: z.string().uuid() });
const eventsQuerySchema = z.object({ afterSeq: z.coerce.number().int().nonnegative().default(0) });

export interface ServerOptions {
  store?: ForgeStore;
  model?: ModelPort;
  git?: GitPort;
  broker?: BrokerPort;
  workspaceRoot?: string;
  staticRoot?: string;
  logger?: boolean;
}

function currentStaticRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, process.env.NODE_ENV === "production" ? "../public" : "../public");
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join("; ");
  return error instanceof Error ? error.message : "Unexpected server error";
}

export async function createServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.env.FORGEOS_WORKSPACE_ROOT ?? ".forgeos/workspaces");
  await mkdir(workspaceRoot, { recursive: true });
  const store = options.store ?? new ForgeStore(process.env.FORGEOS_DB_PATH ?? ".forgeos/forgeos.sqlite");
  let model: ModelPort;
  if (options.model) {
    model = options.model;
  } else {
    const gateway = new SiliconFlowGateway({
      configPath: process.env.MODEL_CONFIG_PATH ?? "config/models.json",
      secretFile: process.env.SILICONFLOW_API_KEY_FILE,
    });
    model = gateway;
  }
  const broker = options.broker ?? new BrokerClient({
    baseUrl: process.env.BROKER_URL,
    tokenFile: process.env.BROKER_TOKEN_FILE,
  });
  const orchestrator = new Orchestrator({
    store, model, git: options.git ?? new GitManager(), broker,
    workspaceRoot,
  });
  orchestrator.recoverIncompleteProjects();
  const app = Fastify({ logger: options.logger ?? process.env.NODE_ENV !== "test", bodyLimit: 64 * 1024 });

  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : /not found/iu.test(errorMessage(error)) ? 404 : 500;
    if (status === 500) app.log.error(error);
    return reply.code(status).send({ error: status === 500 ? "OPERATION_FAILED" : "INVALID_REQUEST", message: errorMessage(error) });
  });

  app.get("/api/health", async (_request, reply) => {
    let brokerStatus = "unavailable";
    try { brokerStatus = (await broker.health?.())?.status ?? "ok"; } catch { brokerStatus = "unavailable"; }
    return reply.send({ status: "ok", database: "ok", broker: brokerStatus, modelConfigured: Boolean(process.env.SILICONFLOW_API_KEY_FILE) });
  });
  app.get("/api/projects", async () => ({ projects: store.listProjects() }));
  app.post("/api/projects", async (request, reply) => {
    const { message } = createProjectSchema.parse(request.body);
    const snapshot = await orchestrator.createProject(message);
    return reply.code(201).send(snapshot);
  });
  app.post("/api/projects/:id/messages", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = messageSchema.parse(request.body);
    return await orchestrator.handleMessage(id, body.text, body.contextQuestionId);
  });
  app.get("/api/projects/:id/snapshot", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { ...store.getSnapshot(id), events: store.getEvents(id) };
  });
  app.get("/api/projects/:id/events", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { afterSeq } = eventsQuerySchema.parse(request.query);
    return { events: store.getEvents(id, afterSeq) };
  });
  app.get("/api/projects/:id/stream", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const { afterSeq } = eventsQuerySchema.parse(request.query);
    store.getProject(id) ?? (() => { throw new Error("Project not found"); })();
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for (const event of store.getEvents(id, afterSeq)) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = store.subscribe(id, (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 20_000);
    request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  await app.register(fastifyStatic, {
    root: options.staticRoot ?? currentStaticRoot(),
    prefix: "/",
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "NOT_FOUND", message: "API route not found" });
    return reply.sendFile("index.html");
  });

  app.addHook("onClose", async () => store.close());
  return app;
}

export async function startServer(): Promise<void> {
  const app = await createServer();
  await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000) });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await startServer();
