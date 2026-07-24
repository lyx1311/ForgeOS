import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerClient, BrokerClientError } from "../src/broker-client.js";
import { createBroker, TARGET_DOCKERFILE } from "../src/broker.js";

const TOKEN = "test-broker-token-123456789";
const RUN_ID = "8c781d1c-9f7e-4d69-a7a0-89f45ef37f4c";
const PROJECT_ID = "abf59fd1-cd04-46e5-9247-03210ab5cf7f";
const TASK_ID = "745d6d99-4cf6-4b17-89ea-148369a17fd0";
const temporaryRoots: string[] = [];

interface MockContainer {
  id: string;
  start: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  logs: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
}

interface MockDocker {
  createContainer: ReturnType<typeof vi.fn>;
  getContainer: ReturnType<typeof vi.fn>;
  buildImage: ReturnType<typeof vi.fn>;
  modem: { followProgress: ReturnType<typeof vi.fn> };
  specifications: Array<Record<string, unknown>>;
}

function mockContainer(overrides: Partial<MockContainer> = {}): MockContainer {
  return {
    id: "container-123",
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    logs: vi.fn().mockResolvedValue(Buffer.from("all good\n")),
    stop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      State: { Running: true, Health: { Status: "healthy" } },
      Config: { Image: `forgeos-preview:${RUN_ID}`, Labels: { "forgeos.managed": "true", "forgeos.kind": "preview", "forgeos.run-id": RUN_ID } },
      NetworkSettings: { Ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49123" }] } },
    }),
    ...overrides,
  };
}

function mockDocker(containers: MockContainer[]): MockDocker {
  const specifications: Array<Record<string, unknown>> = [];
  const available = [...containers];
  return {
    specifications,
    createContainer: vi.fn(async (specification: Record<string, unknown>) => {
      specifications.push(specification);
      const container = containers.shift();
      if (!container) throw new Error("No mock container queued");
      return container;
    }),
    getContainer: vi.fn((id: string) => {
      const container = available.find((item) => item.id === id);
      if (!container) throw new Error("Mock container not found");
      return container;
    }),
    buildImage: vi.fn(async (context: Readable) => {
      context.resume();
      return Readable.from([]);
    }),
    modem: {
      followProgress: vi.fn((_stream: Readable, callback: (error: Error | null, output?: unknown[]) => void) => {
        callback(null, [{ stream: "built\n" }]);
      }),
    },
  };
}

async function workspace(withDockerfile = false): Promise<{ root: string; relative: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "forgeos-broker-"));
  temporaryRoots.push(root);
  const relative = `${PROJECT_ID}/${TASK_ID}`;
  const directory = path.join(root, PROJECT_ID, TASK_ID);
  await mkdir(directory, { recursive: true });
  if (withDockerfile) {
    await writeFile(path.join(directory, "Dockerfile"), TARGET_DOCKERFILE);
    await writeFile(path.join(directory, "package.json"), "{}\n");
    await writeFile(path.join(directory, "server.mjs"), "export {};\n");
  }
  return { root, relative };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("runner broker", () => {
  it("keeps health public and protects runner operations with a bearer token", async () => {
    const worktree = await workspace();
    const docker = mockDocker([]);
    const app = createBroker({
      docker: docker as unknown as Docker,
      token: TOKEN,
      workspaceRoot: worktree.root,
      hostWorkspaceRoot: "/host/workspaces",
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/run",
      payload: { commandId: "test", runId: RUN_ID, relativeWorktree: worktree.relative },
    });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(unauthorized.statusCode).toBe(401);
    expect(docker.createContainer).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps command IDs to fixed argv and creates a tightly restricted runner", async () => {
    const worktree = await workspace();
    const container = mockContainer({ logs: vi.fn().mockResolvedValue(Buffer.from("x".repeat(128))) });
    const docker = mockDocker([container]);
    const app = createBroker({
      docker: docker as unknown as Docker,
      token: TOKEN,
      workspaceRoot: worktree.root,
      hostWorkspaceRoot: "/host/workspaces",
      runnerImage: "node:test-runner",
      maxLogBytes: 16,
    });

    const response = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { commandId: "test", runId: RUN_ID, relativeWorktree: worktree.relative },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ exitCode: 0, commandId: "test", timedOut: false, logTruncated: true });
    const specification = docker.specifications[0] as {
      Cmd: string[];
      User: string;
      WorkingDir: string;
      HostConfig: Record<string, unknown>;
    };
    expect(specification.Cmd).toEqual(["npm", "test"]);
    expect(specification.User).toBe("node");
    expect(specification.WorkingDir).toBe("/workspace");
    expect(specification.HostConfig).toMatchObject({
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 64,
    });
    expect(specification.HostConfig.Binds).toEqual([`/host/workspaces/${PROJECT_ID}/${TASK_ID}:/workspace:ro`]);
    expect(specification.HostConfig.Tmpfs).toMatchObject({ "/tmp": expect.stringContaining("rw") });
    expect(container.remove).toHaveBeenCalledWith({ force: true });
    await app.close();
  });

  it("rejects traversal, unknown commands, and malformed IDs before Docker", async () => {
    const worktree = await workspace();
    const docker = mockDocker([]);
    const app = createBroker({
      docker: docker as unknown as Docker,
      token: TOKEN,
      workspaceRoot: worktree.root,
      hostWorkspaceRoot: "/host/workspaces",
    });
    const request = (body: object) => app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: body,
    });

    expect((await request({ commandId: "test", runId: RUN_ID, relativeWorktree: "../outside" })).statusCode).toBe(400);
    expect((await request({ commandId: "shell", runId: RUN_ID, relativeWorktree: worktree.relative })).statusCode).toBe(400);
    expect((await request({ commandId: "test", runId: "not-a-uuid", relativeWorktree: worktree.relative })).statusCode).toBe(400);
    expect(docker.createContainer).not.toHaveBeenCalled();
    await app.close();
  });

  it("stops and removes a runner that exceeds its deadline", async () => {
    const worktree = await workspace();
    const container = mockContainer({ wait: vi.fn(() => new Promise(() => undefined)) });
    const docker = mockDocker([container]);
    const app = createBroker({
      docker: docker as unknown as Docker,
      token: TOKEN,
      workspaceRoot: worktree.root,
      hostWorkspaceRoot: "/host/workspaces",
      runTimeoutMs: 5,
    });

    const response = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { commandId: "build", runId: RUN_ID, relativeWorktree: worktree.relative },
    });

    expect(response.json()).toMatchObject({ exitCode: 124, timedOut: true, commandId: "build" });
    expect(container.stop).toHaveBeenCalledWith({ t: 1 });
    expect(container.remove).toHaveBeenCalledWith({ force: true });
    await app.close();
  });

  it("builds only the fixed Dockerfile and starts a restricted healthy preview", async () => {
    const worktree = await workspace(true);
    const preview = mockContainer();
    const docker = mockDocker([preview]);
    const app = createBroker({
      docker: docker as unknown as Docker,
      token: TOKEN,
      workspaceRoot: worktree.root,
      hostWorkspaceRoot: "/host/workspaces",
    });

    const response = await app.inject({
      method: "POST",
      url: "/preview",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { runId: RUN_ID, relativeWorktree: worktree.relative },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      imageRef: `forgeos-preview:${RUN_ID}`,
      containerId: preview.id,
      url: "http://127.0.0.1:49123",
    });
    expect(docker.buildImage).toHaveBeenCalledOnce();
    const specification = docker.specifications[0] as { HostConfig: Record<string, unknown>; Labels: Record<string, string> };
    expect(specification.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
      RestartPolicy: { Name: "unless-stopped" },
    });
    expect(specification.HostConfig).not.toHaveProperty("Binds");
    expect(specification.Labels["forgeos.run-id"]).toBe(RUN_ID);
    await app.close();
  });

  it("refuses a project-controlled Dockerfile", async () => {
    const worktree = await workspace(true);
    await writeFile(path.join(worktree.root, worktree.relative, "Dockerfile"), "FROM alpine\nRUN malicious-command\n");
    const docker = mockDocker([]);
    const app = createBroker({
      docker: docker as unknown as Docker,
      token: TOKEN,
      workspaceRoot: worktree.root,
      hostWorkspaceRoot: "/host/workspaces",
    });

    const response = await app.inject({
      method: "POST",
      url: "/preview",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { runId: RUN_ID, relativeWorktree: worktree.relative },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_DOCKERFILE");
    expect(docker.buildImage).not.toHaveBeenCalled();
    await app.close();
  });

  it("recovers only the labelled preview and returns its current port", async () => {
    const containerId = "a".repeat(64);
    const preview = mockContainer({ id: containerId });
    const docker = mockDocker([preview]);
    const app = createBroker({ docker: docker as unknown as Docker, token: TOKEN, workspaceRoot: ".", hostWorkspaceRoot: "/host/workspaces" });
    const response = await app.inject({ method: "POST", url: "/recover-preview",
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { runId: RUN_ID, containerId } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runId: RUN_ID, imageRef: `forgeos-preview:${RUN_ID}`, containerId, url: "http://127.0.0.1:49123" });
    expect(docker.getContainer).toHaveBeenCalledWith(containerId);
    await app.close();
  });

  it("refuses to recover a container without matching ForgeOS labels", async () => {
    const containerId = "b".repeat(64);
    const preview = mockContainer({ id: containerId, inspect: vi.fn().mockResolvedValue({
      State: { Running: true }, Config: { Image: "foreign", Labels: {} }, NetworkSettings: { Ports: {} },
    }) });
    const app = createBroker({ docker: mockDocker([preview]) as unknown as Docker, token: TOKEN, workspaceRoot: ".", hostWorkspaceRoot: "/host/workspaces" });
    const response = await app.inject({ method: "POST", url: "/recover-preview",
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { runId: RUN_ID, containerId } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("PREVIEW_NOT_FOUND");
    await app.close();
  });
});

describe("BrokerClient", () => {
  it("adds the token and decodes a successful response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ exitCode: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new BrokerClient({ baseUrl: "http://broker/", token: TOKEN, fetch: fetchMock });

    await client.run({ commandId: "build", runId: RUN_ID, relativeWorktree: `${PROJECT_ID}/${TASK_ID}` });

    expect(fetchMock).toHaveBeenCalledWith("http://broker/run", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
    }));
  });

  it("raises a typed error without exposing the token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: "PREVIEW_UNHEALTHY",
      message: "Preview failed",
    }), { status: 422 }));
    const client = new BrokerClient({ token: TOKEN, fetch: fetchMock });

    const error = await client.preview({ runId: RUN_ID, relativeWorktree: `${PROJECT_ID}/${TASK_ID}` }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrokerClientError);
    expect(error).toMatchObject({ status: 422, code: "PREVIEW_UNHEALTHY", message: "Preview failed" });
    expect(String(error)).not.toContain(TOKEN);
  });
});
