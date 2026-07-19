import path from "node:path";
import type {
  EvidenceGateRequirement,
  EvidenceRef,
  FactDependency,
  TaskEdge,
  TaskNode,
  TaskStatus,
} from "./types.js";

const transitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["ready", "running", "waiting_user", "cancelled", "stale"]),
  ready: new Set(["running", "waiting_user", "cancelled", "stale"]),
  running: new Set(["succeeded", "failed", "waiting_user", "cancelled", "stale"]),
  waiting_user: new Set(["ready", "running", "cancelled", "stale"]),
  succeeded: new Set(["stale"]),
  failed: new Set(["ready", "running", "cancelled", "stale"]),
  stale: new Set(["ready", "cancelled"]),
  cancelled: new Set(),
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!transitions[from].has(to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function assertAcyclicEdge(
  tasks: readonly Pick<TaskNode, "id">[],
  edges: readonly TaskEdge[],
  proposed: Pick<TaskEdge, "fromTaskId" | "toTaskId">,
): void {
  const ids = new Set(tasks.map((task) => task.id));
  if (!ids.has(proposed.fromTaskId) || !ids.has(proposed.toTaskId)) {
    throw new Error("Both edge endpoints must exist");
  }
  if (proposed.fromTaskId === proposed.toTaskId) throw new Error("Task graph cannot contain a self-edge");

  const outgoing = new Map<string, string[]>();
  for (const edge of [...edges, proposed as TaskEdge]) {
    const list = outgoing.get(edge.fromTaskId) ?? [];
    list.push(edge.toTaskId);
    outgoing.set(edge.fromTaskId, list);
  }
  const stack = [proposed.toTaskId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === proposed.fromTaskId) throw new Error("Task edge would create a cycle");
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(outgoing.get(id) ?? []));
  }
}

export function findTasksInvalidatedByFactRevision(
  tasks: readonly Pick<TaskNode, "id" | "dependsOnFacts">[],
  edges: readonly Pick<TaskEdge, "fromTaskId" | "toTaskId">[],
  changed: FactDependency,
): Set<string> {
  const stale = new Set(
    tasks
      .filter((task) =>
        task.dependsOnFacts.some(
          (dependency) => dependency.factId === changed.factId && dependency.revision !== changed.revision,
        ),
      )
      .map((task) => task.id),
  );
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.fromTaskId) ?? [];
    list.push(edge.toTaskId);
    outgoing.set(edge.fromTaskId, list);
  }
  const queue = [...stale];
  while (queue.length) {
    for (const downstream of outgoing.get(queue.shift()!) ?? []) {
      const downstreamTask = tasks.find((task) => task.id === downstream);
      const crossesIndependentFactBoundary = downstreamTask?.dependsOnFacts.length
        && !downstreamTask.dependsOnFacts.some(
          (dependency) => dependency.factId === changed.factId && dependency.revision !== changed.revision,
        );
      if (crossesIndependentFactBoundary) continue;
      if (!stale.has(downstream)) {
        stale.add(downstream);
        queue.push(downstream);
      }
    }
  }
  return stale;
}

const windowsAbsolute = /^[a-zA-Z]:[\\/]/;
const windowsUnc = /^(?:\\\\|\/\/)/;
const alternateDataStream = /(^|[\\/])[^\\/:]+:[^\\/]+/;

export function resolveSafeWorkspacePath(root: string, candidate: string): string {
  if (!candidate || path.isAbsolute(candidate) || windowsAbsolute.test(candidate) || windowsUnc.test(candidate)) {
    throw new Error("Workspace path must be relative");
  }
  if (candidate.includes("\0") || alternateDataStream.test(candidate)) {
    throw new Error("Workspace path contains an unsafe component");
  }
  if (candidate.split(/[\\/]+/).includes("..")) {
    throw new Error("Workspace path cannot contain parent traversal");
  }
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, candidate);
  const relative = path.relative(rootPath, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workspace path escapes its root");
  }
  return resolved;
}

export function assertEvidenceGate(
  candidateCommit: string,
  evidence: readonly EvidenceRef[],
  requirements: readonly EvidenceGateRequirement[],
): void {
  if (!/^[0-9a-f]{7,64}$/i.test(candidateCommit)) throw new Error("Candidate commit SHA is invalid");
  for (const requirement of requirements) {
    const match = evidence.find(
      (item) =>
        item.kind === requirement.kind &&
        (!requirement.commandId || item.commandId === requirement.commandId) &&
        item.status === "passed" &&
        item.commitSha === candidateCommit,
    );
    if (!match) throw new Error(`Missing passing ${requirement.kind} evidence for candidate commit`);
  }
}
