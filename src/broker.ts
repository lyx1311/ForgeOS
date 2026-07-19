import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import Fastify, { type FastifyInstance } from "fastify";
import tar from "tar-fs";
import { z } from "zod";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_PREVIEW_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_LOG_BYTES = 128 * 1024;
const CONTAINER_WORKSPACE = "/workspace";
const PREVIEW_PORT = "3000/tcp";

export const TARGET_DOCKERFILE = `FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm
WORKDIR /app
COPY package.json server.mjs ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=1s --timeout=2s --start-period=1s --retries=15 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
`;

const COMMANDS = {
  test: ["npm", "test"],
  build: ["npm", "run", "build"],
} as const;

const runRequestSchema = z.object({
  commandId: z.enum(["test", "build"]),
  runId: z.string().uuid(),
  relativeWorktree: z.string().min(1).max(512),
}).strict();

const previewRequestSchema = z.object({
  runId: z.string().uuid(),
  relativeWorktree: z.string().min(1).max(512),
}).strict();

export type BrokerCommandId = keyof typeof COMMANDS;

export interface BrokerRunRequest {
  commandId: BrokerCommandId;
  runId: string;
  relativeWorktree: string;
}

export interface BrokerRunResult {
  commandId: BrokerCommandId;
  runId: string;
  containerId: string;
  exitCode: number;
  durationMs: number;
  log: string;
  logTruncated: boolean;
  timedOut: boolean;
  imageRef: string;
}

export interface BrokerPreviewRequest {
  runId: string;
  relativeWorktree: string;
}

export interface BrokerPreviewResult {
  runId: string;
  imageRef: string;
  containerId: string;
  url: string;
  buildLog: string;
  logTruncated: boolean;
}

export interface BrokerOptions {
  docker?: Docker;
  token?: string;
  tokenFile?: string;
  workspaceRoot?: string;
  hostWorkspaceRoot?: string;
  runnerImage?: string;
  runTimeoutMs?: number;
  previewTimeoutMs?: number;
  maxLogBytes?: number;
}

class BrokerError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadToken(options: BrokerOptions): string {
  const token = options.token ?? readFileSync(options.tokenFile ?? env("BROKER_TOKEN_FILE"), "utf8").trim();
  if (token.length < 16) throw new Error("Broker token must contain at least 16 characters");
  return token;
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = header.slice("Bearer ".length);
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function safeSegments(relativePath: string): string[] {
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new BrokerError(400, "INVALID_PATH", "Path must be relative");
  }
  const segments = relativePath.split(/[\\/]/u);
  if (
    segments.length === 0 ||
    segments.length > 12 ||
    segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment) || segment === "." || segment === "..")
  ) {
    throw new BrokerError(400, "INVALID_PATH", "Path contains an unsafe segment");
  }
  return segments;
}

async function resolveWorktree(root: string, relativePath: string): Promise<{ local: string; segments: string[] }> {
  const segments = safeSegments(relativePath);
  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = await realpath(root);
    candidateReal = await realpath(path.join(rootReal, ...segments));
  } catch {
    throw new BrokerError(404, "WORKTREE_NOT_FOUND", "Worktree does not exist");
  }
  const relative = path.relative(rootReal, candidateReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BrokerError(400, "INVALID_PATH", "Worktree resolves outside the workspace root");
  }
  if (!(await stat(candidateReal)).isDirectory()) {
    throw new BrokerError(400, "INVALID_PATH", "Worktree must be a directory");
  }
  return { local: candidateReal, segments };
}

function hostPath(root: string, segments: string[]): string {
  return /^[A-Za-z]:[\\/]/u.test(root) ? path.win32.join(root, ...segments) : path.posix.join(root, ...segments);
}

function truncateLog(input: string, maximumBytes: number): { log: string; truncated: boolean } {
  const bytes = Buffer.from(input, "utf8");
  if (bytes.length <= maximumBytes) return { log: input, truncated: false };
  return { log: bytes.subarray(0, maximumBytes).toString("utf8"), truncated: true };
}

function decodeDockerLog(value: Buffer | string): string {
  if (typeof value === "string") return value;
  const chunks: Buffer[] = [];
  let cursor = 0;
  while (cursor + 8 <= value.length && (value[cursor] === 1 || value[cursor] === 2)) {
    const length = value.readUInt32BE(cursor + 4);
    if (cursor + 8 + length > value.length) return value.toString("utf8");
    chunks.push(value.subarray(cursor + 8, cursor + 8 + length));
    cursor += 8 + length;
  }
  return cursor === value.length && chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : value.toString("utf8");
}

async function waitForContainer(container: Docker.Container, timeoutMs: number): Promise<{ exitCode: number; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([container.wait(), timeout]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") {
    await container.stop({ t: 1 }).catch(async () => container.kill().catch(() => undefined));
    return { exitCode: 124, timedOut: true };
  }
  return { exitCode: result.StatusCode, timedOut: false };
}

async function followBuild(docker: Docker, stream: NodeJS.ReadableStream, timeoutMs: number): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      reject(new BrokerError(504, "PREVIEW_BUILD_TIMEOUT", "Preview image build timed out"));
    }, timeoutMs);
    docker.modem.followProgress(stream, (error, output) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output ?? []);
    });
  });
}

function buildOutputText(output: unknown[]): string {
  return output.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    const value = entry as { stream?: unknown; status?: unknown; error?: unknown };
    return [value.stream, value.status, value.error].filter((part): part is string => typeof part === "string").join(" ");
  }).join("");
}

async function verifyFixedDockerfile(worktree: string): Promise<void> {
  const dockerfile = path.join(worktree, "Dockerfile");
  let metadata;
  let content;
  try {
    metadata = await lstat(dockerfile);
    content = await readFile(dockerfile, "utf8");
  } catch {
    throw new BrokerError(400, "INVALID_DOCKERFILE", "The fixed project Dockerfile is missing");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || content.replace(/\r\n/gu, "\n") !== TARGET_DOCKERFILE) {
    throw new BrokerError(400, "INVALID_DOCKERFILE", "Project Dockerfile does not match the fixed template");
  }
}

async function waitForHealthy(container: Docker.Container, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspection = await container.inspect();
    const status = inspection.State.Health?.Status;
    if (status === "healthy") return;
    if (!inspection.State.Running || status === "unhealthy") {
      throw new BrokerError(422, "PREVIEW_UNHEALTHY", "Preview container failed its health check");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new BrokerError(504, "PREVIEW_TIMEOUT", "Preview health check timed out");
}

export function createBroker(options: BrokerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
  const docker = options.docker ?? new Docker({ socketPath: "/var/run/docker.sock" });
  const token = loadToken(options);
  const workspaceRoot = options.workspaceRoot ?? env("WORKSPACE_ROOT", "/workspaces");
  const hostWorkspaceRoot = options.hostWorkspaceRoot ?? env("HOST_WORKSPACE_ROOT");
  const runnerImage = options.runnerImage ?? env("RUNNER_IMAGE", "mcr.microsoft.com/devcontainers/javascript-node:24-bookworm");
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const previewTimeoutMs = options.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BrokerError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: "Request body is invalid" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "BROKER_FAILURE", message: "Runner broker operation failed" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (!authorized(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "A valid broker token is required" });
    }
  });

  app.post("/run", async (request): Promise<BrokerRunResult> => {
    const input = runRequestSchema.parse(request.body) as BrokerRunRequest;
    const worktree = await resolveWorktree(workspaceRoot, input.relativeWorktree);
    const startedAt = Date.now();
    const container = await docker.createContainer({
      Image: runnerImage,
      Cmd: [...COMMANDS[input.commandId]],
      User: "node",
      WorkingDir: CONTAINER_WORKSPACE,
      Env: ["HOME=/tmp", "NPM_CONFIG_CACHE=/tmp/npm-cache", "CI=1"],
      AttachStdout: true,
      AttachStderr: true,
      Labels: {
        "forgeos.managed": "true",
        "forgeos.kind": "runner",
        "forgeos.run-id": input.runId,
      },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Binds: [`${hostPath(hostWorkspaceRoot, worktree.segments)}:${CONTAINER_WORKSPACE}:rw`],
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 512 * MEBIBYTE,
        NanoCpus: 1_000_000_000,
        PidsLimit: 64,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m,uid=1000,gid=1000" },
        RestartPolicy: { Name: "no" },
      },
    });

    let result = { exitCode: 125, timedOut: false };
    let rawLog: Buffer | string = "";
    try {
      await container.start();
      result = await waitForContainer(container, runTimeoutMs);
      rawLog = await container.logs({ stdout: true, stderr: true });
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
    const output = truncateLog(decodeDockerLog(rawLog), maxLogBytes);
    return {
      ...input,
      containerId: container.id,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      log: output.log,
      logTruncated: output.truncated,
      timedOut: result.timedOut,
      imageRef: runnerImage,
    };
  });

  app.post("/preview", async (request): Promise<BrokerPreviewResult> => {
    const input = previewRequestSchema.parse(request.body) as BrokerPreviewRequest;
    const worktree = await resolveWorktree(workspaceRoot, input.relativeWorktree);
    await verifyFixedDockerfile(worktree.local);
    const imageRef = `forgeos-preview:${input.runId.toLowerCase()}`;
    const context = tar.pack(worktree.local, {
      ignore: (name: string) => {
        const relative = path.relative(worktree.local, name).replaceAll("\\", "/");
        return relative === ".git" || relative.startsWith(".git/") || relative === ".forgeos" || relative.startsWith(".forgeos/");
      },
    });
    const buildStream = await docker.buildImage(context, {
      t: imageRef,
      dockerfile: "Dockerfile",
      labels: {
        "forgeos.managed": "true",
        "forgeos.kind": "preview-image",
        "forgeos.run-id": input.runId,
      },
    });
    const buildOutput = await followBuild(docker, buildStream, previewTimeoutMs);
    const buildLog = truncateLog(buildOutputText(buildOutput), maxLogBytes);
    const container = await docker.createContainer({
      Image: imageRef,
      User: "node",
      Labels: {
        "forgeos.managed": "true",
        "forgeos.kind": "preview",
        "forgeos.run-id": input.runId,
      },
      ExposedPorts: { [PREVIEW_PORT]: {} },
      HostConfig: {
        NetworkMode: "bridge",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 256 * MEBIBYTE,
        NanoCpus: 500_000_000,
        PidsLimit: 64,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=32m,uid=1000,gid=1000" },
        PortBindings: { [PREVIEW_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
        RestartPolicy: { Name: "no" },
      },
    });
    try {
      await container.start();
      await waitForHealthy(container, previewTimeoutMs);
      const inspection = await container.inspect();
      const binding = inspection.NetworkSettings.Ports[PREVIEW_PORT]?.[0];
      if (!binding?.HostPort) throw new BrokerError(500, "PREVIEW_PORT_MISSING", "Docker did not publish a preview port");
      return {
        runId: input.runId,
        imageRef,
        containerId: container.id,
        url: `http://127.0.0.1:${binding.HostPort}`,
        buildLog: buildLog.log,
        logTruncated: buildLog.truncated,
      };
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      throw error;
    }
  });

  return app;
}

export async function startBroker(): Promise<void> {
  const app = createBroker();
  await app.listen({
    host: process.env.BROKER_HOST ?? "127.0.0.1",
    port: Number(process.env.BROKER_PORT ?? 4001),
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await startBroker();
}
