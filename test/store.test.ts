import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeStore } from "../src/store.js";
import { replayDatabase } from "../src/replay.js";
import type { TaskNode } from "../src/types.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const makeStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "forgeos-store-"));
  cleanup.push(directory);
  return { directory, filename: join(directory, "state.sqlite"), store: new ForgeStore(join(directory, "state.sqlite")) };
};

const timestamp = "2026-07-19T00:00:00.000Z";
const makeTask = (id: string, projectId: string, overrides: Partial<TaskNode> = {}): TaskNode => ({
  id,
  projectId,
  kind: "implementation",
  title: id,
  status: "pending",
  parentId: null,
  attempt: 1,
  baseCommit: null,
  candidateCommit: null,
  dependsOnFacts: [],
  input: {},
  output: null,
  error: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

describe("ForgeStore", () => {
  it("persists events and every projection, and provides snapshots", () => {
    const { store } = makeStore();
    const project = store.createProject({ id: "p", name: "Example", createdAt: timestamp });
    const fact = store.reviseFact({ projectId: project.id, factId: "r1", kind: "requirement", value: { text: "hello" }, createdAt: timestamp });
    const task = makeTask("t", project.id, { dependsOnFacts: [{ factId: "r1", revision: fact.revision }] });
    store.upsertTask(task);
    store.upsertQuestion({ id: "q", projectId: project.id, taskId: task.id, prompt: "Approve?", status: "open", answer: null, createdAt: timestamp, answeredAt: null });
    store.answerQuestion(project.id, "q", "yes");
    store.recordEvidence({ id: "e", projectId: project.id, taskId: task.id, kind: "test", status: "passed", commitSha: "aaaaaaaa", commandId: "test", imageRef: null, exitCode: 0, durationMs: 10, logHash: "h", details: {}, createdAt: timestamp });
    store.recordModelCall({ id: "m", projectId: project.id, taskId: task.id, provider: "siliconflow", model: "qwen", purpose: "plan", promptTokens: 2, completionTokens: 3, totalTokens: 5, estimatedCostCny: 0.01, latencyMs: 20, status: "succeeded", createdAt: timestamp });
    store.upsertChangeset({ id: "c", projectId: project.id, taskId: task.id, baseCommit: "a", candidateCommit: "b", branch: "forge/task/t/1", worktreePath: "worktrees/t", status: "validated", createdAt: timestamp, updatedAt: timestamp });
    store.upsertDeployment({ id: "d", projectId: project.id, commitSha: "b", imageRef: "image:b", containerId: "container", previewUrl: "http://127.0.0.1:1", status: "healthy", createdAt: timestamp, updatedAt: timestamp });

    const snapshot = store.getSnapshot(project.id);
    expect(snapshot.project.name).toBe("Example");
    expect(snapshot.facts).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.questions[0]?.answer).toBe("yes");
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.modelCalls[0]?.totalTokens).toBe(5);
    expect(snapshot.changesets).toHaveLength(1);
    expect(snapshot.deployments).toHaveLength(1);
    expect(store.getEvents(project.id)).toHaveLength(9);
    store.close();
  });

  it("emits committed events to subscribers", () => {
    const { store } = makeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe("p", listener);
    store.createProject({ id: "p", name: "Events" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].seq).toBe(1);
    unsubscribe();
    store.updateProject({ ...store.getSnapshot("p").project, name: "Updated", updatedAt: new Date().toISOString() });
    expect(listener).toHaveBeenCalledOnce();
    store.close();
  });

  it("makes the event log append-only at the database boundary", () => {
    const { store } = makeStore();
    store.createProject({ id: "p", name: "Immutable" });
    expect(() => store.db.prepare("UPDATE events SET type = 'tampered'").run()).toThrow(/events are immutable/);
    expect(() => store.db.prepare("DELETE FROM events").run()).toThrow(/events are immutable/);
    store.close();
  });

  it("resumes a task after its blocking question is answered", () => {
    const { store } = makeStore();
    store.createProject({ id: "p", name: "Questions" });
    store.upsertTask(makeTask("t", "p", { status: "waiting_user" }));
    store.upsertQuestion({ id: "q", projectId: "p", taskId: "t", prompt: "Choose", status: "open", answer: null, createdAt: timestamp, answeredAt: null });
    store.answerQuestion("p", "q", "A");
    expect(store.getTask("t")?.status).toBe("ready");
    store.close();
  });

  it("invalidates stored evidence when a task candidate commit changes", () => {
    const { store } = makeStore();
    store.createProject({ id: "p", name: "Evidence" });
    store.upsertTask(makeTask("t", "p", { status: "running", candidateCommit: "aaaaaaaa" }));
    store.recordEvidence({ id: "e", projectId: "p", taskId: "t", kind: "test", status: "passed", commitSha: "aaaaaaaa", commandId: "test", imageRef: null, exitCode: 0, durationMs: 1, logHash: "h", details: {}, createdAt: timestamp });
    store.upsertTask(makeTask("t", "p", { status: "running", candidateCommit: "bbbbbbbb" }));
    expect(store.getSnapshot("p").evidence[0]?.status).toBe("invalidated");
    store.close();
  });

  it("rejects cyclic edges and invalid task transitions", () => {
    const { store } = makeStore();
    store.createProject({ id: "p", name: "DAG" });
    store.upsertTask(makeTask("a", "p"));
    store.upsertTask(makeTask("b", "p"));
    store.addTaskEdge({ projectId: "p", fromTaskId: "a", toTaskId: "b" });
    expect(() => store.addTaskEdge({ projectId: "p", fromTaskId: "b", toTaskId: "a" })).toThrow(/cycle/);
    store.upsertTask(makeTask("a", "p", { status: "running" }));
    store.upsertTask(makeTask("a", "p", { status: "succeeded" }));
    expect(() => store.upsertTask(makeTask("a", "p", { status: "running" }))).toThrow(/Invalid task transition/);
    store.close();
  });

  it("marks only old revision consumers and their downstream nodes stale", () => {
    const { store } = makeStore();
    store.createProject({ id: "p", name: "Invalidation" });
    const first = store.reviseFact({ projectId: "p", factId: "r1", kind: "requirement", value: "one" });
    store.upsertTask(makeTask("affected", "p", { status: "succeeded", dependsOnFacts: [{ factId: "r1", revision: first.revision }] }));
    store.upsertTask(makeTask("child", "p", { status: "succeeded" }));
    store.upsertTask(makeTask("safe", "p", { status: "succeeded" }));
    store.addTaskEdge({ projectId: "p", fromTaskId: "affected", toTaskId: "child" });
    store.reviseFact({ projectId: "p", factId: "r1", kind: "requirement", value: "two" });
    const statuses = Object.fromEntries(store.getSnapshot("p").tasks.map((task) => [task.id, task.status]));
    expect(statuses).toEqual({ affected: "stale", child: "stale", safe: "succeeded" });
    store.close();
  });

  it("does not cross from a shared planning node into an independent fact branch", () => {
    const { store } = makeStore();
    store.createProject({ id: "p", name: "Branched invalidation" });
    const r1 = store.reviseFact({ projectId: "p", factId: "r1", kind: "requirement", value: "one" });
    const r2 = store.reviseFact({ projectId: "p", factId: "r2", kind: "requirement", value: "two" });
    store.upsertTask(makeTask("plan", "p", { status: "succeeded", dependsOnFacts: [
      { factId: "r1", revision: r1.revision }, { factId: "r2", revision: r2.revision },
    ] }));
    store.upsertTask(makeTask("r1-work", "p", { status: "succeeded", dependsOnFacts: [{ factId: "r1", revision: r1.revision }] }));
    store.upsertTask(makeTask("r2-work", "p", { status: "succeeded", dependsOnFacts: [{ factId: "r2", revision: r2.revision }] }));
    store.addTaskEdge({ projectId: "p", fromTaskId: "plan", toTaskId: "r1-work" });
    store.addTaskEdge({ projectId: "p", fromTaskId: "plan", toTaskId: "r2-work" });
    store.reviseFact({ projectId: "p", factId: "r2", kind: "requirement", value: "two revised" });
    const statuses = Object.fromEntries(store.getSnapshot("p").tasks.map((task) => [task.id, task.status]));
    expect(statuses).toEqual({ plan: "stale", "r1-work": "succeeded", "r2-work": "stale" });
    store.close();
  });

  it("rebuilds disposable projections from the immutable event log", () => {
    const { filename, store } = makeStore();
    store.createProject({ id: "p", name: "Replay" });
    store.reviseFact({ projectId: "p", factId: "r", kind: "requirement", value: "persist" });
    store.db.exec("PRAGMA foreign_keys=OFF; DELETE FROM facts; DELETE FROM projects; PRAGMA foreign_keys=ON;");
    store.close();

    expect(replayDatabase(filename)).toEqual({ projects: 1, events: 2 });
    const reopened = new ForgeStore(filename);
    expect(reopened.getSnapshot("p").facts[0]?.value).toBe("persist");
    reopened.close();
  });
});
