import { describe, expect, it, vi } from "vitest";
import { ForgeStore } from "../src/store.js";
import { Orchestrator, type BrokerPort, type GitPort, type ModelPort } from "../src/orchestrator.js";

const RUN_ID = "8c781d1c-9f7e-4d69-a7a0-89f45ef37f4c";

function harness(testExitCodes: number[] = [0], reviewFailures = 0) {
  let commit = 0;
  let reviewCalls = 0;
  const model: ModelPort = { callJson: vi.fn(async (_route, messages) => {
    const system = messages[0]?.content ?? "";
    if (system.startsWith("Extract")) return { name: "Demo", requirements: [{ id: "landing", title: "Landing", description: "page", acceptanceCriteria: ["renders"] }] };
    if (system.startsWith("Produce")) return { summary: "Build landing", implementationNotes: [] };
    if (system.startsWith("Review")) {
      if (reviewCalls++ < reviewFailures) throw new Error("review unavailable");
      return { approved: true, summary: "ok", issues: [] };
    }
    if (system.startsWith("Map")) return { requirementId: "landing", replacement: { title: "New landing", description: "changed", acceptanceCriteria: ["new copy"] } };
    return { changes: [{ path: "server.mjs", content: "// generated" }] };
  }) as ModelPort["callJson"] };
  const git: GitPort = {
    scaffold: vi.fn(async () => "a".repeat(40)),
    createWorktree: vi.fn(async (_r, root, node, attempt, base) => ({ path: `${root}/${node}-${attempt}`, branch: `forge/task/${node}/${attempt}`, baseCommit: base })),
    applyChanges: vi.fn(async () => undefined),
    commit: vi.fn(async () => (++commit).toString(16).padStart(40, "b")),
    assertWorktreeAtCommit: vi.fn(async () => undefined),
    diffCheck: vi.fn(async () => ""), diff: vi.fn(async () => "diff"),
    fastForwardMerge: vi.fn(async (_r, candidate) => candidate), removeWorktree: vi.fn(async () => undefined),
  };
  let testIndex = 0;
  const broker: BrokerPort = {
    run: vi.fn(async (input) => {
      const exitCode = input.commandId === "test" ? (testExitCodes[testIndex++] ?? 0) : 0;
      return { ...input, containerId: "runner", exitCode, durationMs: 1, log: exitCode ? "failure" : "ok", logTruncated: false, timedOut: false, imageRef: "runner:test" };
    }),
    preview: vi.fn(async (input) => ({ ...input, imageRef: "preview:test", containerId: "preview", url: "http://127.0.0.1:1234", buildLog: "ok", logTruncated: false })),
    recoverPreview: vi.fn(async (input) => ({ ...input, imageRef: `preview:${input.runId}`, url: "http://127.0.0.1:4321" })),
  };
  const store = new ForgeStore();
  return { store, model, git, broker, orchestrator: new Orchestrator({ store, model, git, broker, workspaceRoot: "workspaces" }) };
}

describe("Orchestrator", () => {
  it("normalizes aliases and missing acceptance criteria before planning", async () => {
    const h = harness();
    vi.mocked(h.model.callJson).mockImplementation(async (_route, messages, schema) => {
      const system = messages[0]?.content ?? "";
      if (system.startsWith("Extract")) return schema.parse({
        project_name: "Alias project",
        features: [
          { requirementId: "中文 标识", name: "First feature", details: "first behavior" },
          { key: "duplicate", title: "Second feature", description: "second behavior", acceptance_criteria: "works; is visible" },
        ],
      });
      if (system.startsWith("Produce")) return schema.parse({ summary: "Plan", implementationNotes: [] });
      throw new Error("Unexpected model call");
    });
    const created = await h.orchestrator.createProject("build two features");
    const requirements = created.facts.filter((fact) => fact.kind === "requirement");
    expect(created.project.name).toBe("Alias project");
    expect(requirements).toHaveLength(2);
    expect(requirements[0]?.factId).toMatch(/^[a-zA-Z0-9_-]+$/u);
    const firstFeature = requirements.find((fact) => (fact.value as { title: string }).title === "First feature");
    expect((firstFeature?.value as { acceptanceCriteria: string[] }).acceptanceCriteria).toHaveLength(3);
  });

  it("falls back deterministically when extraction and planning fail", async () => {
    const h = harness();
    vi.mocked(h.model.callJson).mockRejectedValue(new Error("model timeout"));
    const created = await h.orchestrator.createProject("做一个习惯追踪器。需求一：记录每日打卡；需求二：展示连续天数。 ");
    expect(created.project.status).toBe("waiting_user");
    expect(created.facts.filter((fact) => fact.kind === "requirement")).toHaveLength(2);
    expect(created.questions).toHaveLength(1);
    expect(h.store.getEvents(created.project.id).filter((event) => event.type === "model_fallback.used")).toHaveLength(2);
  });

  it("does not let a model merge explicitly separated requirements", async () => {
    const h = harness();
    const created = await h.orchestrator.createProject("做应用。需求一：记录打卡；需求二：展示连续天数。");
    expect(created.facts.filter((fact) => fact.kind === "requirement")).toHaveLength(2);
    expect(h.store.getEvents(created.project.id).some((event) =>
      event.type === "model_fallback.used" && (event.payload as { purpose: string }).purpose === "requirements-completeness"))
      .toBe(true);
  });

  it("normalizes common file-edit aliases from implementation models", async () => {
    const h = harness();
    vi.mocked(h.model.callJson).mockImplementation(async (_route, messages, schema) => {
      const system = messages[0]?.content ?? "";
      if (system.startsWith("Extract")) return schema.parse({ name: "Demo", requirements: [{ id: "landing", title: "Landing", description: "page", acceptanceCriteria: ["renders"] }] });
      if (system.startsWith("Produce")) return schema.parse({ summary: "Plan", implementationNotes: [] });
      if (system.startsWith("Modify")) return schema.parse({ files: [{ filename: "server.mjs", code: "// generated" }] });
      if (system.startsWith("Review")) return schema.parse({ verdict: "pass", review: "looks good" });
      throw new Error("Unexpected call");
    });
    const created = await h.orchestrator.createProject("build a landing page");
    await h.orchestrator.handleMessage(created.project.id, "approve", created.questions[0]!.id);
    await h.orchestrator.waitForIdle(created.project.id);
    expect(h.git.applyChanges).toHaveBeenCalledWith(expect.any(String), [{ path: "server.mjs", content: "// generated" }]);
  });

  it("returns an actionable state when repository initialization fails", async () => {
    const h = harness();
    vi.mocked(h.git.scaffold).mockRejectedValue(new Error("disk unavailable"));
    const created = await h.orchestrator.createProject("build a landing page");
    expect(created.project.status).toBe("waiting_user");
    expect(created.tasks.some((task) => task.status === "failed")).toBe(true);
    expect(created.questions[0]?.status).toBe("open");
    expect(h.store.getEvents(created.project.id).some((event) => event.type === "project.initialization_failed")).toBe(true);
  });

  it("marks an abandoned project as failed without deleting its history", () => {
    const h = harness();
    const project = h.store.createProject({ name: "Interrupted" });
    expect(h.orchestrator.recoverIncompleteProjects()).toBe(1);
    expect(h.store.getSnapshot(project.id).project.status).toBe("failed");
    expect(h.store.getEvents(project.id).some((event) => event.type === "project.initialization_abandoned")).toBe(true);
  });

  it("persists approval question then completes implementation through preview", async () => {
    const h = harness();
    const created = await h.orchestrator.createProject("build a landing page");
    expect(created.project.status).toBe("waiting_user");
    expect(created.tasks.map((task) => task.kind)).toEqual(expect.arrayContaining(["analysis", "planning", "implementation", "test", "review", "merge", "deploy"]));
    const question = created.questions[0]!;
    await h.orchestrator.handleMessage(created.project.id, "批准", question.id);
    await h.orchestrator.waitForIdle(created.project.id);
    const done = h.store.getSnapshot(created.project.id);
    expect(done.project.status).toBe("completed");
    expect(done.project.headCommit).not.toBe("a".repeat(40));
    expect(done.evidence.filter((item) => item.status === "passed").map((item) => item.kind))
      .toEqual(expect.arrayContaining(["diff_check", "test", "build", "review"]));
    expect(done.deployments[0]?.status).toBe("healthy");
  });

  it("refreshes a healthy deployment URL after Docker assigns a new port without duplicating the deployment", async () => {
    const h = harness();
    const project = h.store.createProject({ name: "Recovered preview" });
    const timestamp = new Date().toISOString();
    h.store.upsertDeployment({ id: RUN_ID, projectId: project.id, commitSha: "a".repeat(40), imageRef: `preview:${RUN_ID}`,
      containerId: "c".repeat(64), previewUrl: "http://127.0.0.1:1111", status: "healthy", createdAt: timestamp, updatedAt: timestamp });
    await expect(h.orchestrator.recoverDeployments()).resolves.toBe(1);
    const deployments = h.store.getSnapshot(project.id).deployments;
    expect(deployments).toHaveLength(1);
    expect(deployments[0]?.previewUrl).toBe("http://127.0.0.1:4321");
    await expect(h.orchestrator.recoverDeployments()).resolves.toBe(0);
  });

  it("stops before evidence, merge, and preview when a runner mutates the candidate worktree", async () => {
    const h = harness();
    let integrityChecks = 0;
    vi.mocked(h.git.assertWorktreeAtCommit).mockImplementation(async () => {
      integrityChecks += 1;
      if (integrityChecks === 3) throw new Error("Worktree differs from the candidate commit");
    });
    const created = await h.orchestrator.createProject("build a landing page");
    await h.orchestrator.handleMessage(created.project.id, "approve", created.questions[0]!.id);
    await h.orchestrator.waitForIdle(created.project.id);
    const stopped = h.store.getSnapshot(created.project.id);
    expect(stopped.project.status).toBe("waiting_user");
    expect(stopped.evidence.some((item) => item.kind === "test" && item.status === "passed")).toBe(false);
    expect(h.git.fastForwardMerge).not.toHaveBeenCalled();
    expect(h.broker.preview).not.toHaveBeenCalled();
  });

  it("creates a repair node and retries a failed test", async () => {
    const h = harness([1, 0]);
    const created = await h.orchestrator.createProject("build");
    await h.orchestrator.handleMessage(created.project.id, "approve", created.questions[0]!.id);
    await h.orchestrator.waitForIdle(created.project.id);
    const snapshot = h.store.getSnapshot(created.project.id);
    expect(snapshot.tasks.some((task) => task.kind === "repair" && task.status === "succeeded")).toBe(true);
    expect(snapshot.evidence.some((item) => item.kind === "test" && item.status === "invalidated")).toBe(true);
    expect(snapshot.project.status).toBe("completed");
  });

  it("revalidates test evidence after a review call triggers repair", async () => {
    const h = harness([0, 0], 1);
    const created = await h.orchestrator.createProject("build");
    await h.orchestrator.handleMessage(created.project.id, "approve", created.questions[0]!.id);
    await h.orchestrator.waitForIdle(created.project.id);
    const snapshot = h.store.getSnapshot(created.project.id);
    expect(snapshot.project.status).toBe("completed");
    expect(snapshot.evidence.filter((evidence) => evidence.kind === "test" && evidence.status === "passed")).toHaveLength(1);
    expect(snapshot.evidence.some((evidence) => evidence.kind === "test" && evidence.status === "invalidated")).toBe(true);
  });

  it("retries a failed implementation without following historical repair edges", async () => {
    const h = harness([1, 1, 1, 0]);
    const created = await h.orchestrator.createProject("build");
    await h.orchestrator.handleMessage(created.project.id, "approve", created.questions[0]!.id);
    await h.orchestrator.waitForIdle(created.project.id);
    const failed = h.store.getSnapshot(created.project.id);
    const retryQuestion = failed.questions.find((question) => question.status === "open")!;
    expect(failed.project.status).toBe("waiting_user");
    await h.orchestrator.handleMessage(created.project.id, "retry", retryQuestion.id);
    await h.orchestrator.waitForIdle(created.project.id);
    const retried = h.store.getSnapshot(created.project.id);
    expect(retried.questions.filter((question) => question.status === "open").map((question) => question.prompt)).toEqual([]);
    expect(retried.tasks.filter((task) => ["pending", "ready", "running", "waiting_user"].includes(task.status))
      .map((task) => ({ kind: task.kind, status: task.status, title: task.title }))).toEqual([]);
    expect(retried.project.status).toBe("completed");
  });

  it("invalidates only the changed requirement chain", async () => {
    const h = harness();
    const created = await h.orchestrator.createProject("build");
    const originalImplementation = created.tasks.find((task) => task.kind === "implementation")!;
    await h.orchestrator.handleMessage(created.project.id, "approve", created.questions[0]!.id);
    await h.orchestrator.waitForIdle(created.project.id);
    await h.orchestrator.handleMessage(created.project.id, "change the landing wording");
    const snapshot = h.store.getSnapshot(created.project.id);
    expect(snapshot.tasks.find((task) => task.id === originalImplementation.id)?.status).toBe("stale");
    expect(snapshot.facts.filter((fact) => fact.factId === "landing")).toHaveLength(2);
  });

  it("does not schedule unaffected work from a cancelled shared plan", async () => {
    const h = harness();
    vi.mocked(h.model.callJson).mockImplementation(async (_route, messages, schema) => {
      const system = messages[0]?.content ?? "";
      if (system.startsWith("Extract")) return schema.parse({ name: "Two", requirements: [
        { id: "r1", title: "One", description: "one", acceptanceCriteria: ["one"] },
        { id: "r2", title: "Two", description: "two", acceptanceCriteria: ["two"] },
      ] });
      if (system.startsWith("Produce")) return schema.parse({ summary: "Plan", implementationNotes: [] });
      if (system.startsWith("Map")) return schema.parse({ requirementId: "r2", replacement: { title: "Two revised", description: "two revised", acceptanceCriteria: ["two revised"] } });
      if (system.startsWith("Modify")) return schema.parse({ changes: [{ path: "server.mjs", content: "// /health" }] });
      if (system.startsWith("Review")) return schema.parse({ approved: true, summary: "ok", issues: [] });
      throw new Error("Unexpected model call");
    });
    const created = await h.orchestrator.createProject("two requirements");
    const r1 = created.tasks.find((task) => task.kind === "implementation" && task.dependsOnFacts[0]?.factId === "r1")!;
    const r2 = created.tasks.find((task) => task.kind === "implementation" && task.dependsOnFacts[0]?.factId === "r2")!;
    await h.orchestrator.handleMessage(created.project.id, "reject", created.questions[0]!.id);
    await h.orchestrator.handleMessage(created.project.id, "change requirement two");
    await h.orchestrator.waitForIdle(created.project.id);
    const snapshot = h.store.getSnapshot(created.project.id);
    expect(snapshot.tasks.find((task) => task.id === r1.id)?.status).toBe("pending");
    expect(snapshot.tasks.find((task) => task.id === r2.id)?.status).toBe("stale");
    expect(snapshot.tasks.some((task) => task.kind === "implementation" && task.dependsOnFacts[0]?.factId === "r2"
      && task.dependsOnFacts[0]?.revision === 2 && task.status === "succeeded")).toBe(true);
  });
});
