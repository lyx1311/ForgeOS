import { describe, expect, it } from "vitest";
import {
  assertAcyclicEdge,
  assertEvidenceGate,
  assertTaskTransition,
  findTasksInvalidatedByFactRevision,
  resolveSafeWorkspacePath,
} from "../src/domain.js";
import type { EvidenceRef, TaskNode } from "../src/types.js";

const time = "2026-07-19T00:00:00.000Z";
const task = (id: string, dependsOnFacts: TaskNode["dependsOnFacts"] = []): TaskNode => ({
  id,
  projectId: "p",
  kind: "implementation",
  title: id,
  status: "succeeded",
  parentId: null,
  attempt: 1,
  baseCommit: null,
  candidateCommit: null,
  dependsOnFacts,
  input: {},
  output: null,
  error: null,
  createdAt: time,
  updatedAt: time,
});

describe("task domain", () => {
  it("enforces state transitions", () => {
    expect(() => assertTaskTransition("running", "succeeded")).not.toThrow();
    expect(() => assertTaskTransition("succeeded", "running")).toThrow(/Invalid task transition/);
  });

  it("rejects a DAG edge that closes a cycle", () => {
    const tasks = [task("a"), task("b"), task("c")];
    const edges = [
      { projectId: "p", fromTaskId: "a", toTaskId: "b" },
      { projectId: "p", fromTaskId: "b", toTaskId: "c" },
    ];
    expect(() => assertAcyclicEdge(tasks, edges, { fromTaskId: "c", toTaskId: "a" })).toThrow(/cycle/);
    expect(() => assertAcyclicEdge(tasks, edges, { fromTaskId: "a", toTaskId: "c" })).not.toThrow();
  });

  it("invalidates only direct old-revision consumers and downstream tasks", () => {
    const tasks = [task("affected", [{ factId: "requirement-a", revision: 1 }]), task("child"), task("unrelated", [{ factId: "requirement-b", revision: 1 }])];
    const stale = findTasksInvalidatedByFactRevision(
      tasks,
      [{ fromTaskId: "affected", toTaskId: "child" }],
      { factId: "requirement-a", revision: 2 },
    );
    expect([...stale].sort()).toEqual(["affected", "child"]);
  });
});

describe("security gates", () => {
  it("accepts safe relative paths and rejects escape/absolute/ADS paths", () => {
    const root = "C:\\forge\\worktree";
    expect(resolveSafeWorkspacePath(root, "src/index.ts")).toMatch(/src[\\/]index\.ts$/);
    expect(() => resolveSafeWorkspacePath(root, "../secret")).toThrow();
    expect(() => resolveSafeWorkspacePath(root, "src/../secret")).toThrow();
    expect(() => resolveSafeWorkspacePath(root, "C:\\Windows\\system.ini")).toThrow();
    expect(() => resolveSafeWorkspacePath(root, "file.txt:stream")).toThrow();
  });

  it("requires passing evidence bound to the exact candidate SHA", () => {
    const evidence: EvidenceRef[] = [{
      id: "e", projectId: "p", taskId: "t", kind: "test", status: "passed",
      commitSha: "aaaaaaaa", commandId: "npm-test", imageRef: null, exitCode: 0,
      durationMs: 1, logHash: "hash", details: {}, createdAt: time,
    }];
    expect(() => assertEvidenceGate("aaaaaaaa", evidence, [{ kind: "test", commandId: "npm-test" }])).not.toThrow();
    expect(() => assertEvidenceGate("bbbbbbbb", evidence, [{ kind: "test" }])).toThrow(/Missing passing/);
  });
});
