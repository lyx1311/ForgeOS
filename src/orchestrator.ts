import { createHash, randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { z } from "zod";
import type { BrokerPreviewResult, BrokerRecoverPreviewResult, BrokerRunResult } from "./broker.js";
import type { BrokerClient } from "./broker-client.js";
import type { FileChange, GitManager, WorktreeRef } from "./git.js";
import type { SiliconFlowGateway, ModelCallContext, ModelMessage, ModelRoute, ModelUsage } from "./model.js";
import { assertEvidenceGate } from "./domain.js";
import { ForgeStore } from "./store.js";
import type { Changeset, EvidenceKind, JsonValue, ProjectSnapshot, TaskKind, TaskNode } from "./types.js";

const DEFAULT_ACCEPTANCE_CRITERIA = [
  "The service starts successfully",
  "The page is reachable in a browser",
  "The requested behavior can be verified",
];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(source: Record<string, unknown> | null, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  if (typeof value === "string") return value.split(/\r?\n|[；;]/u).map((item) => item.trim()).filter(Boolean);
  return [];
}

function safeRequirementId(value: unknown, index: number, used: Set<string>): string {
  const raw = typeof value === "string" ? value : "";
  const base = raw.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64)
    || `requirement-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function normalizeProjectSpecCandidate(value: unknown): unknown {
  const source = record(value);
  if (!source) return value;
  const rawRequirements = source.requirements ?? source.features ?? source.items ?? source.userStories;
  if (!Array.isArray(rawRequirements)) return value;
  const used = new Set<string>();
  return {
    name: firstString(source, ["name", "projectName", "project_name", "title"]) ?? "ForgeOS project",
    requirements: rawRequirements.slice(0, 8).map((raw, index) => {
      const item = record(raw);
      const description = typeof raw === "string" ? raw.trim() : firstString(item, ["description", "details", "content", "summary", "title", "name"]);
      const criteria = stringList(item?.acceptanceCriteria ?? item?.acceptance_criteria ?? item?.criteria ?? item?.acceptance);
      return {
        id: safeRequirementId(item?.id ?? item?.requirementId ?? item?.key, index, used),
        title: firstString(item, ["title", "name", "summary"]) ?? description?.slice(0, 160) ?? `Requirement ${index + 1}`,
        description: description ?? `Implement requirement ${index + 1}`,
        acceptanceCriteria: criteria.length ? criteria : DEFAULT_ACCEPTANCE_CRITERIA,
      };
    }),
  };
}

const projectSpecSchema = z.preprocess(normalizeProjectSpecCandidate, z.object({
  name: z.string().min(1).max(80),
  requirements: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    title: z.string().min(1).max(160),
    description: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
  })).min(1).max(8),
}));
const planSchema = z.object({ summary: z.string().min(1), implementationNotes: z.array(z.string()).default([]) });
function normalizeChangesCandidate(value: unknown): unknown {
  const source = record(value);
  const rawChanges = Array.isArray(value) ? value : source?.changes ?? source?.files ?? source?.edits;
  if (!Array.isArray(rawChanges)) return value;
  return { changes: rawChanges.map((raw) => {
    const item = record(raw);
    if (!item) return raw;
    const action = firstString(item, ["action", "operation"]);
    return {
      path: firstString(item, ["path", "file", "filename", "name"]),
      content: firstString(item, ["content", "code", "text"]),
      delete: item.delete === true || action === "delete" || action === "remove" ? true : undefined,
    };
  }) };
}

const changesSchema = z.preprocess(normalizeChangesCandidate, z.object({ changes: z.array(z.object({
  path: z.string().min(1), content: z.string().max(200_000).optional(), delete: z.boolean().optional(),
}).refine((item) => item.delete === true ? item.content === undefined : typeof item.content === "string", "Invalid file operation")).min(1).max(20) }));
function normalizeReviewCandidate(value: unknown): unknown {
  const source = record(value);
  if (!source) return value;
  const issues = stringList(source.issues ?? source.problems ?? source.findings ?? source.concerns);
  const verdict = firstString(source, ["verdict", "result", "status"]);
  let approved = typeof source.approved === "boolean" ? source.approved
    : typeof source.passed === "boolean" ? source.passed
      : typeof source.ok === "boolean" ? source.ok
        : undefined;
  if (approved === undefined && verdict) {
    if (/^(?:approved|approve|pass|passed|ok|accept|accepted)$/iu.test(verdict)) approved = true;
    if (/^(?:rejected|reject|fail|failed|deny|denied)$/iu.test(verdict)) approved = false;
  }
  const summary = firstString(source, ["summary", "review", "reason", "message"]);
  if (approved === undefined && summary && issues.length === 0) approved = true;
  return { approved, summary: summary ?? (approved ? "No blocking issues found" : "Review found blocking issues"), issues };
}

const reviewSchema = z.preprocess(normalizeReviewCandidate, z.object({ approved: z.boolean(), summary: z.string(), issues: z.array(z.string()).default([]) }));
const changeIntentSchema = z.object({ requirementId: z.string(), replacement: z.object({
  title: z.string().min(1), description: z.string().min(1), acceptanceCriteria: z.array(z.string().min(1)).min(1),
}) });

export type ProjectSpec = z.infer<typeof projectSpecSchema>;

export interface ModelPort {
  callJson<T>(route: ModelRoute, messages: ModelMessage[], schema: z.ZodType<T>, context?: ModelCallContext): Promise<T>;
}
export interface BrokerPort {
  health?(): Promise<{ status: string }>;
  run(input: { commandId: "test" | "build"; runId: string; relativeWorktree: string }): Promise<BrokerRunResult>;
  preview(input: { runId: string; relativeWorktree: string }): Promise<BrokerPreviewResult>;
  recoverPreview?(input: { runId: string; containerId: string }): Promise<BrokerRecoverPreviewResult>;
}
export interface GitPort {
  scaffold(repository: string): Promise<string>;
  createWorktree(repository: string, root: string, nodeId: string, attempt: number, base: string): Promise<WorktreeRef>;
  applyChanges(worktree: string, changes: FileChange[]): Promise<void>;
  commit(worktree: string, message: string): Promise<string>;
  assertWorktreeAtCommit(worktree: string, expectedCommit: string): Promise<void>;
  diffCheck(repository: string, base?: string): Promise<string>;
  diff(repository: string, base: string, head?: string): Promise<string>;
  fastForwardMerge(repository: string, candidate: string, expectedBase: string, evidence: string[]): Promise<string>;
  removeWorktree(repository: string, worktree: string): Promise<void>;
}

export interface OrchestratorOptions {
  store: ForgeStore;
  model: SiliconFlowGateway | ModelPort;
  git: GitManager | GitPort;
  broker: BrokerClient | BrokerPort;
  workspaceRoot?: string;
  now?: () => string;
}

function safeLogHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function taskId(requirementId: string, kind: TaskKind): string { return `${requirementId}-${kind}-${randomUUID()}`; }
function isApproval(text: string): boolean { return /^(?:批准|同意|确认|继续|approve|approved|yes|ok)[。.!！\s]*$/iu.test(text.trim()); }
function isRejection(text: string): boolean { return /^(?:否决|拒绝|不同意|reject|rejected|no)[。.!！\s]*$/iu.test(text.trim()); }

function fallbackProjectSpec(message: string): ProjectSpec {
  const marker = /(?:需求|功能)\s*(?:[一二三四五六七八九十\d]+)\s*[：:]/gu;
  const matches = [...message.matchAll(marker)];
  let segments: string[] = [];
  if (matches.length) {
    segments = matches.map((match, index) => message.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? message.length));
  } else {
    segments = message.split(/(?:^|\r?\n)\s*(?:[-*]|\d+[.)、])\s*/u);
  }
  segments = segments.map((item) => item.trim().replace(/^[；;。\s]+|[；;。\s]+$/gu, "")).filter(Boolean).slice(0, 8);
  if (!segments.length) segments = [message.trim() || "Create a small Node web application"];
  const namePrefix = matches[0]?.index ? message.slice(0, matches[0].index).trim().replace(/[。；;：:\s]+$/gu, "") : message.trim();
  const used = new Set<string>();
  return {
    name: (namePrefix || "ForgeOS project").slice(0, 80),
    requirements: segments.map((description, index) => ({
      id: safeRequirementId(undefined, index, used),
      title: description.slice(0, 160),
      description,
      acceptanceCriteria: [...DEFAULT_ACCEPTANCE_CRITERIA],
    })),
  };
}

function fallbackPlan(spec: ProjectSpec, feedback?: string): z.infer<typeof planSchema> {
  return {
    summary: `Implement ${spec.requirements.length} independent requirement${spec.requirements.length === 1 ? "" : "s"} in the fixed zero-dependency Node web template, validate each change, review it, merge it, and deploy a local preview.`,
    implementationNotes: [
      ...spec.requirements.map((requirement) => `${requirement.id}: ${requirement.title}`),
      ...(feedback ? [`User feedback: ${feedback}`] : []),
    ],
  };
}

export class Orchestrator {
  private readonly workspaceRoot: string;
  private readonly now: () => string;
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly options: OrchestratorOptions) {
    this.workspaceRoot = options.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? ".forgeos/workspaces";
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createProject(message: string): Promise<ProjectSnapshot> {
    const project = this.options.store.createProject({ name: message.trim().slice(0, 80) || "Untitled project" });
    try {
      let spec: ProjectSpec;
      try {
        spec = await this.callModel(project.id, null, "requirements", "fast", [
          { role: "system", content: "Extract a small Node web project. Return JSON with name and independent requirements (id, title, description, acceptanceCriteria)." },
          { role: "user", content: message },
        ], projectSpecSchema);
      } catch (error) {
        spec = fallbackProjectSpec(message);
        this.recordFallback(project.id, null, "requirements", error);
      }
      const deterministicSpec = fallbackProjectSpec(message);
      if (deterministicSpec.requirements.length > spec.requirements.length) {
        spec = { name: spec.name, requirements: deterministicSpec.requirements };
        this.recordFallback(project.id, null, "requirements-completeness", new Error("Model merged explicitly separated requirements"));
      }
      const repository = this.repository(project.id);
      const head = await this.options.git.scaffold(repository);
      this.options.store.updateProject({ ...project, name: spec.name, headCommit: head, updatedAt: this.now() });
      const facts = spec.requirements.map((requirement) => this.options.store.reviseFact({
        projectId: project.id, factId: requirement.id, kind: "requirement", value: requirement,
      }));
      const analysis = this.newTask(project.id, "analysis", "分析用户需求", "succeeded", null, [], { message }, { requirementCount: facts.length });
      this.options.store.upsertTask(analysis);
      const planning = this.newTask(project.id, "planning", "制定实施方案", "running", null,
        facts.map((fact) => ({ factId: fact.factId, revision: fact.revision })), { requirements: spec.requirements }, null);
      this.options.store.upsertTask(planning);
      this.options.store.addTaskEdge({ projectId: project.id, fromTaskId: analysis.id, toTaskId: planning.id });
      let plan: z.infer<typeof planSchema>;
      try {
        plan = await this.callModel(project.id, planning.id, "planning", "code", [
          { role: "system", content: "Produce a concise implementation plan for a zero-dependency Node web application. Return JSON summary and implementationNotes." },
          { role: "user", content: JSON.stringify(spec) },
        ], planSchema);
      } catch (error) {
        plan = fallbackPlan(spec);
        this.recordFallback(project.id, planning.id, "planning", error);
      }
      this.options.store.upsertTask({ ...planning, status: "waiting_user", output: plan, updatedAt: this.now() });
      const questionId = randomUUID();
      this.options.store.upsertQuestion({
        id: questionId, projectId: project.id, taskId: planning.id,
        prompt: `方案：${plan.summary}\n批准后将自动实现、验证、合并并部署。是否批准？`,
        status: "open", answer: null, createdAt: this.now(), answeredAt: null,
      });
      this.options.store.updateProject({ ...this.options.store.getSnapshot(project.id).project, status: "waiting_user", updatedAt: this.now() });
      this.createDeliveryGraph(project.id, planning.id, facts.map((fact) => ({ factId: fact.factId, revision: fact.revision })));
      return this.options.store.getSnapshot(project.id);
    } catch (error) {
      return this.failInitialization(project.id, error);
    }
  }

  recoverIncompleteProjects(): number {
    let recovered = 0;
    for (const project of this.options.store.listProjects()) {
      const snapshot = this.options.store.getSnapshot(project.id);
      if (!snapshot.tasks.some((task) => task.kind === "deploy" && task.status === "running")) {
        for (const deployment of snapshot.deployments.filter((item) => item.status === "pending" || item.status === "building")) {
          this.options.store.upsertDeployment({ ...deployment, status: "failed", updatedAt: this.now() });
          recovered += 1;
        }
      }
      if (project.headCommit !== null || snapshot.tasks.length > 0 || project.status !== "active") continue;
      this.options.store.appendEvent({
        projectId: project.id, type: "project.initialization_abandoned", actor: "system",
        aggregateType: "project", aggregateId: project.id, correlationId: project.id,
        payload: { reason: "Process ended before initialization completed" }, occurredAt: this.now(),
      });
      this.options.store.updateProject({ ...project, status: "failed", updatedAt: this.now() });
      recovered += 1;
    }
    return recovered;
  }

  async recoverDeployments(): Promise<number> {
    if (!this.options.broker.recoverPreview) return 0;
    let recovered = 0;
    for (const project of this.options.store.listProjects()) {
      const deployments = this.options.store.getSnapshot(project.id).deployments
        .filter((deployment) => deployment.status === "healthy" && deployment.containerId !== null);
      for (const deployment of deployments) {
        let preview: BrokerRecoverPreviewResult | undefined;
        for (let attempt = 0; attempt < 5 && !preview; attempt += 1) {
          try {
            preview = await this.options.broker.recoverPreview({ runId: deployment.id, containerId: deployment.containerId! });
          } catch {
            if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        if (!preview || (preview.url === deployment.previewUrl && preview.imageRef === deployment.imageRef
          && preview.containerId === deployment.containerId)) continue;
        this.options.store.upsertDeployment({ ...deployment, imageRef: preview.imageRef,
          containerId: preview.containerId, previewUrl: preview.url, updatedAt: this.now() });
        recovered += 1;
      }
    }
    return recovered;
  }

  async handleMessage(projectId: string, text: string, contextQuestionId?: string): Promise<ProjectSnapshot> {
    const snapshot = this.options.store.getSnapshot(projectId);
    const openQuestion = contextQuestionId
      ? snapshot.questions.find((question) => question.id === contextQuestionId && question.status === "open")
      : [...snapshot.questions].reverse().find((question) => question.status === "open");
    if (openQuestion) {
      const questionedTask = snapshot.tasks.find((task) => task.id === openQuestion.taskId);
      if (questionedTask?.kind === "planning" && isApproval(text)) {
        this.options.store.answerQuestion(projectId, openQuestion.id, text);
        this.options.store.reviseFact({ projectId, factId: `decision-${openQuestion.id}`, kind: "decision", value: { approved: true, answer: text } });
        const plan = this.options.store.getSnapshot(projectId).tasks.find((task) => task.id === openQuestion.taskId);
        if (plan?.status === "waiting_user" || plan?.status === "ready") {
          this.options.store.upsertTask({ ...plan, status: "running", updatedAt: this.now() });
          this.options.store.upsertTask({ ...plan, status: "succeeded", updatedAt: this.now() });
        }
        const current = this.options.store.getSnapshot(projectId).project;
        this.options.store.updateProject({ ...current, status: "active", updatedAt: this.now() });
        this.enqueue(projectId);
        return this.options.store.getSnapshot(projectId);
      }
      if (questionedTask?.kind === "planning" && isRejection(text)) {
        this.options.store.answerQuestion(projectId, openQuestion.id, text);
        const plan = snapshot.tasks.find((task) => task.id === openQuestion.taskId);
        if (plan?.status === "waiting_user") this.options.store.upsertTask({ ...plan, status: "cancelled", updatedAt: this.now() });
        this.options.store.reviseFact({ projectId, factId: `decision-${openQuestion.id}`, kind: "decision", value: { approved: false, answer: text } });
        this.options.store.updateProject({ ...snapshot.project, status: "active", updatedAt: this.now() });
        return this.options.store.getSnapshot(projectId);
      }
      const retryImplementation = questionedTask?.kind === "implementation"
        ? questionedTask
        : questionedTask?.kind === "repair" && questionedTask.parentId
          ? snapshot.tasks.find((task) => task.id === questionedTask.parentId && task.kind === "implementation")
          : questionedTask
            ? snapshot.tasks.find((task) => task.kind === "implementation" && task.status === "failed"
              && task.dependsOnFacts[0]?.factId === questionedTask.dependsOnFacts[0]?.factId)
            : undefined;
      if (questionedTask?.kind === "deploy" && questionedTask.status === "failed") {
        this.options.store.answerQuestion(projectId, openQuestion.id, text);
        this.options.store.reviseFact({ projectId, factId: `deploy-decision-${openQuestion.id}`, kind: "decision", value: { answer: text } });
        const continueWithNext = /(?:继续|下一|跳过|修复|continue|next|skip)/iu.test(text);
        this.options.store.upsertTask({ ...questionedTask, status: continueWithNext ? "cancelled" : "ready", error: null, updatedAt: this.now() });
        this.options.store.updateProject({ ...snapshot.project, status: "active", updatedAt: this.now() });
        this.enqueue(projectId);
        return this.options.store.getSnapshot(projectId);
      }
      if (retryImplementation?.status === "failed") {
        this.options.store.answerQuestion(projectId, openQuestion.id, text);
        this.options.store.reviseFact({ projectId, factId: `retry-${openQuestion.id}`, kind: "decision", value: { retry: true, answer: text } });
        this.prepareImplementationRetry(snapshot, retryImplementation);
        this.options.store.upsertTask({ ...retryImplementation, status: "ready", error: null, updatedAt: this.now() });
        const current = this.options.store.getSnapshot(projectId).project;
        this.options.store.updateProject({ ...current, status: "active", updatedAt: this.now() });
        this.enqueue(projectId);
        return this.options.store.getSnapshot(projectId);
      }
      this.options.store.answerQuestion(projectId, openQuestion.id, text);
      this.options.store.reviseFact({ projectId, factId: `answer-${openQuestion.id}`, kind: "answer", value: { answer: text } });
      if (questionedTask?.kind === "planning") {
        const ready = this.options.store.getTask(questionedTask.id)!;
        this.options.store.upsertTask({ ...ready, status: "running", updatedAt: this.now() });
        const requirements = this.options.store.getSnapshot(projectId).facts.filter((fact) => fact.kind === "requirement");
        let plan: z.infer<typeof planSchema>;
        try {
          plan = await this.callModel(projectId, questionedTask.id, "plan-revision", "code", [
            { role: "system", content: "Revise the zero-dependency Node web implementation plan using the user's feedback. Return summary and implementationNotes." },
            { role: "user", content: JSON.stringify({ feedback: text, requirements, previousPlan: questionedTask.output }) },
          ], planSchema);
        } catch (error) {
          plan = fallbackPlan(this.specFromSnapshot(projectId), text);
          this.recordFallback(projectId, questionedTask.id, "plan-revision", error);
        }
        const runningPlan = this.options.store.getTask(questionedTask.id)!;
        this.options.store.upsertTask({ ...runningPlan, status: "waiting_user", output: plan, updatedAt: this.now() });
        this.options.store.upsertQuestion({ id: randomUUID(), projectId, taskId: questionedTask.id,
          prompt: `修订方案：${plan.summary}\n是否批准？`, status: "open", answer: null, createdAt: this.now(), answeredAt: null });
      }
      return this.options.store.getSnapshot(projectId);
    }

    const failedImplementation = snapshot.tasks.find((task) => task.kind === "implementation" && task.status === "failed");
    if (snapshot.project.status === "waiting_user" && failedImplementation && /(?:重试|继续|retry|resume)/iu.test(text)) {
      const decisionId = randomUUID();
      this.options.store.reviseFact({ projectId, factId: `retry-${decisionId}`, kind: "decision", value: { retry: true, answer: text } });
      this.prepareImplementationRetry(snapshot, failedImplementation);
      this.options.store.upsertTask({ ...failedImplementation, status: "ready", error: null, updatedAt: this.now() });
      this.options.store.updateProject({ ...snapshot.project, status: "active", updatedAt: this.now() });
      this.enqueue(projectId);
      return this.options.store.getSnapshot(projectId);
    }

    const requirements = snapshot.facts.filter((fact) => fact.kind === "requirement");
    let intent: z.infer<typeof changeIntentSchema>;
    try {
      intent = await this.callModel(projectId, null, "change-intent", "fast", [
        { role: "system", content: "Map the requested change to exactly one existing requirement. Return requirementId and its complete replacement title, description, acceptanceCriteria." },
        { role: "user", content: JSON.stringify({ text, requirements }) },
      ], changeIntentSchema);
    } catch (error) {
      intent = this.fallbackChangeIntent(projectId, text);
      this.recordFallback(projectId, null, "change-intent", error);
    }
    if (!requirements.some((fact) => fact.factId === intent.requirementId)) throw new Error("The change did not identify an existing requirement");
    const revised = this.options.store.reviseFact({ projectId, factId: intent.requirementId, kind: "requirement", value: { id: intent.requirementId, ...intent.replacement } });
    const planning = this.newTask(projectId, "planning", `协调需求变更：${intent.replacement.title}`, "succeeded", null,
      [{ factId: revised.factId, revision: revised.revision }], { message: text }, { reconciled: true });
    this.options.store.upsertTask(planning);
    this.createDeliveryGraph(projectId, planning.id, [{ factId: revised.factId, revision: revised.revision }]);
    this.options.store.updateProject({ ...this.options.store.getSnapshot(projectId).project, status: "active", updatedAt: this.now() });
    this.enqueue(projectId);
    return this.options.store.getSnapshot(projectId);
  }

  async waitForIdle(projectId: string): Promise<void> { await this.running.get(projectId); }

  private createDeliveryGraph(projectId: string, planningId: string, dependencies: TaskNode["dependsOnFacts"]): void {
    for (const dependency of dependencies) {
      let previous = planningId;
      for (const kind of ["implementation", "test", "review", "merge", "deploy"] as const) {
        const task = this.newTask(projectId, kind, `${dependency.factId}: ${kind}`, "pending", null, [dependency], {}, null);
        this.options.store.upsertTask(task);
        this.options.store.addTaskEdge({ projectId, fromTaskId: previous, toTaskId: task.id });
        previous = task.id;
      }
    }
  }

  private enqueue(projectId: string): void {
    if (this.running.has(projectId)) return;
    const job = this.runProject(projectId).finally(() => this.running.delete(projectId));
    this.running.set(projectId, job);
  }

  private async runProject(projectId: string): Promise<void> {
    try {
      for (;;) {
        const snapshot = this.options.store.getSnapshot(projectId);
        const deployment = snapshot.tasks.find((task) => task.kind === "deploy" && task.status === "ready");
        if (deployment) {
          const commit = snapshot.project.headCommit;
          if (!commit) throw new Error("Project repository has no HEAD for deployment retry");
          await this.deployProject(projectId, deployment, commit);
          continue;
        }
        const implementation = snapshot.tasks.find((task) => task.kind === "implementation"
          && (task.status === "pending" || task.status === "ready")
          && snapshot.edges.some((edge) => edge.toTaskId === task.id
            && snapshot.tasks.some((upstream) => upstream.id === edge.fromTaskId && upstream.kind === "planning" && upstream.status === "succeeded")));
        if (!implementation) break;
        await this.runRequirement(projectId, implementation);
      }
      const snapshot = this.options.store.getSnapshot(projectId);
      if (!snapshot.tasks.some((task) => ["pending", "ready", "running", "waiting_user"].includes(task.status))) {
        this.options.store.updateProject({ ...snapshot.project, status: "completed", updatedAt: this.now() });
      }
    } catch (error) {
      const snapshot = this.options.store.getSnapshot(projectId);
      const runningTasks = snapshot.tasks.filter((task) => task.status === "running");
      for (const task of runningTasks) this.options.store.upsertTask({ ...task, status: "failed", error: this.errorText(error), updatedAt: this.now() });
      this.options.store.upsertQuestion({ id: randomUUID(), projectId, taskId: runningTasks.at(-1)?.id ?? null,
        prompt: `自动执行已停止：${this.errorText(error)}。请提供处理意见。`, status: "open", answer: null,
        createdAt: this.now(), answeredAt: null });
      this.options.store.updateProject({ ...snapshot.project, status: "waiting_user", updatedAt: this.now() });
    }
  }

  private async runRequirement(projectId: string, implementation: TaskNode): Promise<void> {
    const repository = this.repository(projectId);
    const snapshot = this.options.store.getSnapshot(projectId);
    const base = snapshot.project.headCommit;
    if (!base) throw new Error("Project repository has no HEAD");
    const chain = this.downstreamChain(snapshot, implementation.id);
    const testTask = chain.find((task) => task.kind === "test")!;
    const reviewTask = chain.find((task) => task.kind === "review")!;
    const mergeTask = chain.find((task) => task.kind === "merge")!;
    const deployTask = chain.find((task) => task.kind === "deploy")!;
    const firstAttempt = implementation.attempt + 1;
    const worktree = await this.options.git.createWorktree(repository, join(this.workspaceRoot, projectId, "tasks"), implementation.id, firstAttempt, base);
    const changeset = this.changeset(projectId, implementation.id, base, worktree);
    this.options.store.upsertChangeset(changeset);
    this.options.store.upsertTask({ ...implementation, status: "running", attempt: firstAttempt, baseCommit: base, updatedAt: this.now() });
    let candidate = "";
    try {
      const requirement = this.currentRequirement(projectId, implementation.dependsOnFacts[0]!.factId);
      let failure = "";
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        const kind = attempt === 0 ? "implementation" : "repair";
        let repair: TaskNode | undefined;
        if (attempt > 0) {
          this.prepareTaskForRerun(testTask.id);
          this.prepareTaskForRerun(reviewTask.id);
          repair = this.newTask(projectId, "repair", `${requirement.factId}: repair ${firstAttempt + attempt}`, "running", implementation.id,
            implementation.dependsOnFacts, { failure }, null);
          this.options.store.upsertTask(repair);
          this.options.store.addTaskEdge({ projectId, fromTaskId: testTask.id, toTaskId: repair.id });
        }
        let proposal: z.infer<typeof changesSchema>;
        try {
          proposal = await this.callModel(projectId, repair?.id ?? implementation.id, attempt === 0 ? "implementation" : "repair", attempt < 2 ? "code" : "reasoning", [
            { role: "system", content: "Modify the fixed zero-dependency Node web template using only Node built-ins and browser APIs. Return exactly one JSON object shaped as {\"changes\":[{\"path\":\"server.mjs\",\"content\":\"complete file content\"}]}. Use complete file contents, no markdown, no third-party imports. Allowed paths: server.mjs, src/, public/, test/, README.md. Never modify package.json, package-lock.json, Dockerfile, or .gitignore." },
            { role: "user", content: JSON.stringify({ requirement, attempt, previousFailure: failure }) },
          ], changesSchema);
        } catch (error) {
          failure = `Model did not produce valid changes (${error instanceof z.ZodError ? "schema" : "request"})`;
          if (attempt === 2) throw new Error("Implementation model failed after two repairs");
          continue;
        }
        try {
          await this.options.git.applyChanges(worktree.path, proposal.changes);
        } catch (error) {
          failure = `Candidate policy rejected changes: ${this.errorText(error)}`;
          if (attempt === 2) throw new Error(`Implementation policy failed after two repairs: ${failure}`);
          continue;
        }
        candidate = await this.options.git.commit(worktree.path, `${kind}: ${requirement.factId} attempt ${firstAttempt + attempt}`);
        await this.options.git.assertWorktreeAtCommit(worktree.path, candidate);
        if (repair) this.options.store.upsertTask({ ...repair, status: "succeeded", candidateCommit: candidate, updatedAt: this.now() });
        this.options.store.upsertTask({ ...implementation, status: "running", attempt: firstAttempt + attempt, baseCommit: base, candidateCommit: candidate, updatedAt: this.now() });

        const diffStarted = Date.now();
        try {
          const output = await this.options.git.diffCheck(worktree.path, base);
          this.evidence(projectId, implementation.id, "diff_check", candidate, "git-diff-check", 0, Date.now() - diffStarted, output, null);
        } catch (error) {
          failure = this.errorText(error);
          this.evidence(projectId, implementation.id, "diff_check", candidate, "git-diff-check", 1, Date.now() - diffStarted, failure, null);
          if (attempt === 2) throw new Error(`Validation failed after two repairs: ${failure}`);
          continue;
        }

        const currentTestTask = this.options.store.getTask(testTask.id)!;
        this.options.store.upsertTask({ ...currentTestTask, status: "running", baseCommit: base, candidateCommit: candidate, attempt: firstAttempt + attempt, updatedAt: this.now() });
        await this.options.git.assertWorktreeAtCommit(worktree.path, candidate);
        const test = await this.options.broker.run({ commandId: "test", runId: randomUUID(), relativeWorktree: this.brokerPath(worktree.path) });
        await this.options.git.assertWorktreeAtCommit(worktree.path, candidate);
        this.brokerEvidence(projectId, testTask.id, "test", candidate, test);
        if (test.exitCode !== 0 || test.timedOut) {
          failure = `Tests failed (${test.exitCode}): ${test.log}`;
          if (attempt === 2) throw new Error(`Validation failed after two repairs: ${failure}`);
          continue;
        }
        await this.options.git.assertWorktreeAtCommit(worktree.path, candidate);
        const build = await this.options.broker.run({ commandId: "build", runId: randomUUID(), relativeWorktree: this.brokerPath(worktree.path) });
        await this.options.git.assertWorktreeAtCommit(worktree.path, candidate);
        this.brokerEvidence(projectId, testTask.id, "build", candidate, build);
        if (build.exitCode !== 0 || build.timedOut) {
          failure = `Build failed (${build.exitCode}): ${build.log}`;
          if (attempt === 2) throw new Error(`Validation failed after two repairs: ${failure}`);
          continue;
        }
        this.options.store.upsertTask({ ...this.options.store.getTask(testTask.id)!, status: "succeeded", candidateCommit: candidate, output: { test: test.exitCode, build: build.exitCode }, updatedAt: this.now() });
        this.options.store.upsertTask({ ...this.options.store.getTask(reviewTask.id)!, status: "running", baseCommit: base, candidateCommit: candidate, updatedAt: this.now() });
        const diff = await this.options.git.diff(worktree.path, base, candidate);
        let review: z.infer<typeof reviewSchema>;
        try {
          review = await this.callModel(projectId, reviewTask.id, "review", "code", [
            { role: "system", content: "Review this diff read-only for correctness, safety, zero-third-party-dependency compliance, and the acceptance criteria. Return exactly one JSON object shaped as {\"approved\":true,\"summary\":\"concise assessment\",\"issues\":[]}. Set approved=false when any blocking issue exists. Return no markdown." },
            { role: "user", content: JSON.stringify({ requirement, diff }) },
          ], reviewSchema);
        } catch (error) {
          failure = `Review model did not return a valid decision (${error instanceof z.ZodError ? "schema" : "request"})`;
          if (attempt === 2) throw new Error("Review model failed after two repairs");
          continue;
        }
        this.evidence(projectId, reviewTask.id, "review", candidate, "model-review", review.approved ? 0 : 1, 0,
          JSON.stringify({ summary: review.summary, issues: review.issues }), null);
        if (!review.approved) {
          failure = `Review rejected: ${review.issues.join("; ")}`;
          if (attempt === 2) throw new Error(`Review failed after two repairs: ${failure}`);
          continue;
        }
        this.options.store.upsertTask({ ...this.options.store.getTask(reviewTask.id)!, status: "succeeded", baseCommit: base, candidateCommit: candidate, output: review, updatedAt: this.now() });
        break;
      }
      this.options.store.upsertTask({ ...implementation, status: "succeeded", candidateCommit: candidate, updatedAt: this.now() });
      const evidenceCommits = this.options.store.getSnapshot(projectId).evidence
        .filter((item) => item.commitSha === candidate && item.status === "passed").map((item) => item.commitSha);
      const gateEvidence = this.options.store.getSnapshot(projectId).evidence;
      assertEvidenceGate(candidate, gateEvidence, [
        { kind: "diff_check", commandId: "git-diff-check" }, { kind: "test", commandId: "test" },
        { kind: "build", commandId: "build" }, { kind: "review", commandId: "model-review" },
      ]);
      await this.options.git.assertWorktreeAtCommit(worktree.path, candidate);
      this.options.store.upsertChangeset({ ...changeset, candidateCommit: candidate, status: "validated", updatedAt: this.now() });
      this.options.store.upsertTask({ ...mergeTask, status: "running", baseCommit: base, candidateCommit: candidate, updatedAt: this.now() });
      const merged = await this.options.git.fastForwardMerge(repository, candidate, base, evidenceCommits);
      this.options.store.upsertTask({ ...mergeTask, status: "succeeded", output: { commit: merged }, updatedAt: this.now() });
      this.options.store.upsertChangeset({ ...changeset, candidateCommit: candidate, status: "merged", updatedAt: this.now() });
      const current = this.options.store.getSnapshot(projectId).project;
      this.options.store.updateProject({ ...current, headCommit: merged, updatedAt: this.now() });
      await this.deployProject(projectId, deployTask, merged);
    } finally {
      await this.options.git.removeWorktree(repository, worktree.path).catch(() => undefined);
    }
  }

  private currentRequirement(projectId: string, factId: string) {
    const facts = this.options.store.getSnapshot(projectId).facts.filter((fact) => fact.factId === factId);
    const result = facts.sort((a, b) => b.revision - a.revision)[0];
    if (!result) throw new Error(`Requirement not found: ${factId}`);
    return result;
  }

  private async deployProject(projectId: string, deployTask: TaskNode, commit: string): Promise<void> {
    const repository = this.repository(projectId);
    this.options.store.upsertTask({ ...this.options.store.getTask(deployTask.id)!, status: "running", candidateCommit: commit, updatedAt: this.now() });
    const deploymentId = randomUUID();
    const deployment = { id: deploymentId, projectId, commitSha: commit, imageRef: "pending", containerId: null,
      previewUrl: null, status: "building" as const, createdAt: this.now(), updatedAt: this.now() };
    this.options.store.upsertDeployment(deployment);
    try {
      const preview = await this.options.broker.preview({ runId: deploymentId, relativeWorktree: this.brokerPath(repository) });
      this.options.store.upsertDeployment({ ...deployment, imageRef: preview.imageRef,
        containerId: preview.containerId, previewUrl: preview.url, status: "healthy", updatedAt: this.now() });
      this.options.store.upsertTask({ ...this.options.store.getTask(deployTask.id)!, status: "succeeded", output: { url: preview.url }, updatedAt: this.now() });
    } catch (error) {
      this.options.store.upsertDeployment({ ...deployment, status: "failed", updatedAt: this.now() });
      throw error;
    }
  }

  private specFromSnapshot(projectId: string): ProjectSpec {
    const snapshot = this.options.store.getSnapshot(projectId);
    return projectSpecSchema.parse({
      name: snapshot.project.name,
      requirements: snapshot.facts
        .filter((fact) => fact.kind === "requirement")
        .sort((a, b) => a.factId.localeCompare(b.factId) || b.revision - a.revision)
        .filter((fact, index, facts) => index === 0 || facts[index - 1]?.factId !== fact.factId)
        .map((fact) => fact.value),
    });
  }

  private fallbackChangeIntent(projectId: string, text: string): z.infer<typeof changeIntentSchema> {
    const spec = this.specFromSnapshot(projectId);
    const normalizedText = text.toLocaleLowerCase();
    const ranked = spec.requirements.map((requirement, index) => {
      const candidates = [requirement.id, requirement.title, requirement.description].filter((item) => item.length >= 2);
      const direct = candidates.some((item) => normalizedText.includes(item.toLocaleLowerCase())) ? 100 : 0;
      const characters = [...new Set(requirement.title.replace(/\s/gu, ""))].filter((character) => normalizedText.includes(character)).length;
      return { requirement, score: direct + characters, index };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = ranked[0]?.requirement;
    if (!selected) throw new Error("No requirement is available for reconciliation");
    return {
      requirementId: selected.id,
      replacement: {
        title: selected.title,
        description: text.trim(),
        acceptanceCriteria: selected.acceptanceCriteria.length ? selected.acceptanceCriteria : [...DEFAULT_ACCEPTANCE_CRITERIA],
      },
    };
  }

  private recordFallback(projectId: string, taskIdValue: string | null, purpose: string, error: unknown): void {
    const category = error instanceof z.ZodError ? "schema" : error instanceof Error ? error.name : "unknown";
    this.options.store.appendEvent({
      projectId, type: "model_fallback.used", actor: "system", aggregateType: taskIdValue ? "task" : "project",
      aggregateId: taskIdValue ?? projectId, correlationId: projectId,
      payload: { purpose, category, errorHash: safeLogHash(this.errorText(error)) }, occurredAt: this.now(),
    });
  }

  private failInitialization(projectId: string, error: unknown): ProjectSnapshot {
    const snapshot = this.options.store.getSnapshot(projectId);
    let task = snapshot.tasks.find((item) => item.status === "running");
    if (task) {
      this.options.store.upsertTask({ ...task, status: "failed", error: "Project initialization failed", updatedAt: this.now() });
    } else {
      task = this.newTask(projectId, "analysis", "初始化项目", "failed", null, [], {}, null);
      this.options.store.upsertTask({ ...task, error: "Project initialization failed" });
    }
    this.options.store.appendEvent({
      projectId, type: "project.initialization_failed", actor: "system", aggregateType: "project", aggregateId: projectId,
      correlationId: projectId, payload: { errorHash: safeLogHash(this.errorText(error)) }, occurredAt: this.now(),
    });
    this.options.store.upsertQuestion({
      id: randomUUID(), projectId, taskId: task.id,
      prompt: "项目初始化未能完成。请稍后重试或提供更明确的需求描述。", status: "open", answer: null,
      createdAt: this.now(), answeredAt: null,
    });
    const current = this.options.store.getSnapshot(projectId).project;
    this.options.store.updateProject({ ...current, status: "waiting_user", updatedAt: this.now() });
    return this.options.store.getSnapshot(projectId);
  }

  private downstreamChain(snapshot: ProjectSnapshot, start: string): TaskNode[] {
    const output: TaskNode[] = [];
    let current = start;
    for (const expectedKind of ["test", "review", "merge", "deploy"] as const) {
      const next = snapshot.edges
        .filter((edge) => edge.fromTaskId === current)
        .map((edge) => snapshot.tasks.find((task) => task.id === edge.toTaskId))
        .find((task) => task?.kind === expectedKind);
      if (!next) throw new Error(`Delivery graph is missing ${expectedKind} after ${current}`);
      output.push(next);
      current = next.id;
    }
    return output;
  }

  private prepareImplementationRetry(snapshot: ProjectSnapshot, implementation: TaskNode): void {
    for (const task of this.downstreamChain(snapshot, implementation.id)) {
      if (task.status === "pending" || task.status === "ready") continue;
      let current = task;
      if (task.status === "succeeded" || task.status === "running") {
        current = { ...task, status: "stale", updatedAt: this.now() };
        this.options.store.upsertTask(current);
      }
      if (current.status === "stale" || current.status === "failed" || current.status === "waiting_user") {
        this.options.store.upsertTask({ ...current, status: "ready", error: null, updatedAt: this.now() });
      }
    }
  }

  private prepareTaskForRerun(taskIdValue: string): void {
    let task = this.options.store.getTask(taskIdValue);
    if (!task || task.status === "pending" || task.status === "ready") return;
    if (task.status === "succeeded" || task.status === "running") {
      task = { ...task, status: "stale", updatedAt: this.now() };
      this.options.store.upsertTask(task);
    }
    if (task.status === "stale" || task.status === "failed" || task.status === "waiting_user") {
      this.options.store.upsertTask({ ...task, status: "ready", error: null, updatedAt: this.now() });
    }
  }

  private evidence(projectId: string, taskId: string, kind: EvidenceKind, commitSha: string, commandId: string,
    exitCode: number, durationMs: number, log: string, imageRef: string | null): void {
    this.options.store.recordEvidence({ id: randomUUID(), projectId, taskId, kind, status: exitCode === 0 ? "passed" : "failed",
      commitSha, commandId, imageRef, exitCode, durationMs, logHash: safeLogHash(log), details: { logTruncated: false }, createdAt: this.now() });
  }

  private brokerEvidence(projectId: string, taskId: string, kind: "test" | "build", commit: string, result: BrokerRunResult): void {
    this.options.store.recordEvidence({ id: randomUUID(), projectId, taskId, kind,
      status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed", commitSha: commit,
      commandId: result.commandId, imageRef: result.imageRef, exitCode: result.exitCode, durationMs: result.durationMs,
      logHash: safeLogHash(result.log), details: { logTruncated: result.logTruncated, timedOut: result.timedOut }, createdAt: this.now() });
  }

  private newTask(projectId: string, kind: TaskKind, title: string, status: TaskNode["status"], parentId: string | null,
    dependsOnFacts: TaskNode["dependsOnFacts"], input: JsonValue, output: JsonValue | null): TaskNode {
    const timestamp = this.now();
    return { id: taskId(dependsOnFacts[0]?.factId ?? "project", kind), projectId, kind, title, status, parentId,
      attempt: 0, baseCommit: null, candidateCommit: null, dependsOnFacts, input, output, error: null,
      createdAt: timestamp, updatedAt: timestamp };
  }

  private changeset(projectId: string, taskIdValue: string, baseCommit: string, worktree: WorktreeRef): Changeset {
    const timestamp = this.now();
    return { id: randomUUID(), projectId, taskId: taskIdValue, baseCommit, candidateCommit: null,
      branch: worktree.branch, worktreePath: worktree.path, status: "open", createdAt: timestamp, updatedAt: timestamp };
  }
  private repository(projectId: string): string { return join(this.workspaceRoot, projectId, "repository"); }
  private brokerPath(path: string): string { return relative(this.workspaceRoot, path).replaceAll("\\", "/"); }
  private errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }

  private async callModel<T>(projectId: string, taskIdValue: string | null, purpose: string, route: ModelRoute,
    messages: ModelMessage[], schema: z.ZodType<T>): Promise<T> {
    return await this.options.model.callJson(route, messages, schema, {
      correlationId: projectId,
      onUsage: (usage: ModelUsage) => {
        this.options.store.recordModelCall({
          id: randomUUID(), projectId, taskId: taskIdValue, provider: "siliconflow", model: usage.model, purpose,
          promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
          estimatedCostCny: null, latencyMs: usage.latencyMs, status: usage.succeeded ? "succeeded" : "failed", createdAt: this.now(),
        });
      },
    });
  }
}
