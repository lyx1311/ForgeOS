export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Actor = "user" | "system" | "model" | "worker";
export type ProjectStatus = "active" | "waiting_user" | "failed" | "completed" | "archived";
export type TaskKind =
  | "analysis"
  | "planning"
  | "implementation"
  | "test"
  | "review"
  | "merge"
  | "deploy"
  | "repair"
  | (string & {});
export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "stale"
  | "cancelled";
export type QuestionStatus = "open" | "answered" | "cancelled";
export type EvidenceKind = "diff_check" | "test" | "build" | "review" | (string & {});
export type EvidenceStatus = "passed" | "failed" | "invalidated";

export interface EventEnvelope<T = JsonValue> {
  id: string;
  projectId: string;
  seq: number;
  type: string;
  actor: Actor;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  payload: T;
  occurredAt: string;
}

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  headCommit: string | null;
}

export interface FactRevision {
  projectId: string;
  factId: string;
  revision: number;
  kind: string;
  value: JsonValue;
  sourceEventId: string;
  createdAt: string;
}

export interface FactDependency {
  factId: string;
  revision: number;
}

export interface TaskNode {
  id: string;
  projectId: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  parentId: string | null;
  attempt: number;
  baseCommit: string | null;
  candidateCommit: string | null;
  dependsOnFacts: FactDependency[];
  input: JsonValue;
  output: JsonValue | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEdge {
  projectId: string;
  fromTaskId: string;
  toTaskId: string;
}

export interface Question {
  id: string;
  projectId: string;
  taskId: string | null;
  prompt: string;
  status: QuestionStatus;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface EvidenceRef {
  id: string;
  projectId: string;
  taskId: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  commitSha: string;
  commandId: string;
  imageRef: string | null;
  exitCode: number | null;
  durationMs: number;
  logHash: string;
  details: JsonValue;
  createdAt: string;
}

export interface ModelCallUsage {
  id: string;
  projectId: string;
  taskId: string | null;
  provider: string;
  model: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCny: number | null;
  latencyMs: number;
  status: "succeeded" | "failed";
  createdAt: string;
}

export interface Changeset {
  id: string;
  projectId: string;
  taskId: string;
  baseCommit: string;
  candidateCommit: string | null;
  branch: string;
  worktreePath: string;
  status: "open" | "validated" | "merged" | "abandoned";
  createdAt: string;
  updatedAt: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  commitSha: string;
  imageRef: string;
  containerId: string | null;
  previewUrl: string | null;
  status: "pending" | "building" | "healthy" | "failed" | "stopped";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSnapshot {
  project: Project;
  facts: FactRevision[];
  tasks: TaskNode[];
  edges: TaskEdge[];
  questions: Question[];
  evidence: EvidenceRef[];
  modelCalls: ModelCallUsage[];
  changesets: Changeset[];
  deployments: Deployment[];
  lastSeq: number;
}

export interface AppendEventInput<T = JsonValue> {
  id?: string;
  projectId: string;
  type: string;
  actor: Actor;
  aggregateType: string;
  aggregateId: string;
  correlationId?: string;
  causationId?: string | null;
  payload: T;
  occurredAt?: string;
}

export interface EvidenceGateRequirement {
  kind: EvidenceKind;
  commandId?: string;
}
