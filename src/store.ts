import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { assertAcyclicEdge, assertTaskTransition, findTasksInvalidatedByFactRevision } from "./domain.js";
import type {
  Actor,
  AppendEventInput,
  Changeset,
  Deployment,
  EventEnvelope,
  EvidenceRef,
  FactRevision,
  JsonValue,
  ModelCallUsage,
  Project,
  ProjectSnapshot,
  Question,
  TaskEdge,
  TaskNode,
} from "./types.js";

export const EVENT_TYPES = {
  projectCreated: "project.created",
  projectUpdated: "project.updated",
  factRevised: "fact.revised",
  taskUpserted: "task.upserted",
  taskEdgeAdded: "task.edge_added",
  questionUpserted: "question.upserted",
  evidenceRecorded: "evidence.recorded",
  modelCallRecorded: "model_call.recorded",
  changesetUpserted: "changeset.upserted",
  deploymentUpserted: "deployment.upserted",
} as const;

const projectionTables = [
  "task_edges",
  "evidence",
  "questions",
  "model_calls",
  "changesets",
  "deployments",
  "tasks",
  "facts",
  "projects",
] as const;

function stringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function now(): string {
  return new Date().toISOString();
}

export interface MutationContext {
  actor?: Actor;
  correlationId?: string;
  causationId?: string | null;
}

export class ForgeStore {
  readonly db: Database.Database;
  private readonly emitter = new EventEmitter();

  constructor(filename = ":memory:") {
    this.db = new Database(filename);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE(project_id, seq)
      );
      CREATE INDEX IF NOT EXISTS events_project_seq ON events(project_id, seq);
      CREATE TRIGGER IF NOT EXISTS events_are_immutable_update
      BEFORE UPDATE ON events BEGIN
        SELECT RAISE(ABORT, 'events are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS events_are_immutable_delete
      BEFORE DELETE ON events BEGIN
        SELECT RAISE(ABORT, 'events are immutable');
      END;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        head_commit TEXT
      );
      CREATE TABLE IF NOT EXISTS facts (
        project_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, fact_id, revision),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_id TEXT,
        attempt INTEGER NOT NULL,
        base_commit TEXT,
        candidate_commit TEXT,
        depends_on_facts_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
      CREATE TABLE IF NOT EXISTS task_edges (
        project_id TEXT NOT NULL,
        from_task_id TEXT NOT NULL,
        to_task_id TEXT NOT NULL,
        PRIMARY KEY(project_id, from_task_id, to_task_id),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(from_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(to_task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        answer TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        command_id TEXT NOT NULL,
        image_ref TEXT,
        exit_code INTEGER,
        duration_ms INTEGER NOT NULL,
        log_hash TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS model_calls (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        purpose TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        estimated_cost_cny REAL,
        latency_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS changesets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        candidate_commit TEXT,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        image_ref TEXT NOT NULL,
        container_id TEXT,
        preview_url TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
    `);
  }

  appendEvent<T>(input: AppendEventInput<T>): EventEnvelope<T> {
    const event = this.db.transaction(() => {
      const seqRow = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE project_id = ?")
        .get(input.projectId) as { seq: number };
      const event: EventEnvelope<T> = {
        id: input.id ?? randomUUID(),
        projectId: input.projectId,
        seq: seqRow.seq,
        type: input.type,
        actor: input.actor,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        correlationId: input.correlationId ?? randomUUID(),
        causationId: input.causationId ?? null,
        payload: input.payload,
        occurredAt: input.occurredAt ?? now(),
      };
      this.db
        .prepare(`INSERT INTO events
          (id, project_id, seq, type, actor, aggregate_type, aggregate_id, correlation_id, causation_id, payload_json, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          event.id,
          event.projectId,
          event.seq,
          event.type,
          event.actor,
          event.aggregateType,
          event.aggregateId,
          event.correlationId,
          event.causationId,
          stringify(event.payload),
          event.occurredAt,
        );
      this.applyEvent(event as EventEnvelope);
      return event;
    })();
    this.emitter.emit(input.projectId, event);
    return event;
  }

  createProject(input: { id?: string; name: string; createdAt?: string }, context: MutationContext = {}): Project {
    const timestamp = input.createdAt ?? now();
    const project: Project = {
      id: input.id ?? randomUUID(),
      name: input.name,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      headCommit: null,
    };
    this.appendEvent({
      projectId: project.id,
      type: EVENT_TYPES.projectCreated,
      actor: context.actor ?? "user",
      aggregateType: "project",
      aggregateId: project.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: project,
    });
    return project;
  }

  updateProject(project: Project, context: MutationContext = {}): Project {
    this.requireProject(project.id);
    this.appendEvent({
      projectId: project.id,
      type: EVENT_TYPES.projectUpdated,
      actor: context.actor ?? "system",
      aggregateType: "project",
      aggregateId: project.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: project,
    });
    return project;
  }

  reviseFact(
    input: Omit<FactRevision, "revision" | "sourceEventId" | "createdAt"> & { createdAt?: string },
    context: MutationContext = {},
  ): FactRevision {
    this.requireProject(input.projectId);
    const revisionRow = this.db
      .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM facts WHERE project_id = ? AND fact_id = ?")
      .get(input.projectId, input.factId) as { revision: number };
    const eventId = randomUUID();
    const fact: FactRevision = {
      ...input,
      revision: revisionRow.revision,
      sourceEventId: eventId,
      createdAt: input.createdAt ?? now(),
    };
    const event = this.appendEvent({
      id: eventId,
      projectId: input.projectId,
      type: EVENT_TYPES.factRevised,
      actor: context.actor ?? "user",
      aggregateType: "fact",
      aggregateId: input.factId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: fact,
    });
    const snapshot = this.getSnapshot(input.projectId);
    const invalidated = findTasksInvalidatedByFactRevision(snapshot.tasks, snapshot.edges, {
      factId: fact.factId,
      revision: fact.revision,
    });
    for (const id of invalidated) {
      const task = snapshot.tasks.find((item) => item.id === id)!;
      if (task.status !== "stale" && task.status !== "cancelled") {
        this.upsertTask(
          { ...task, status: "stale", updatedAt: now() },
          { actor: "system", correlationId: event.correlationId, causationId: event.id },
        );
      }
    }
    return fact;
  }

  upsertTask(task: TaskNode, context: MutationContext = {}): TaskNode {
    this.requireProject(task.projectId);
    const previous = this.getTask(task.id);
    if (previous) assertTaskTransition(previous.status, task.status);
    const event = this.appendEvent({
      projectId: task.projectId,
      type: EVENT_TYPES.taskUpserted,
      actor: context.actor ?? "system",
      aggregateType: "task",
      aggregateId: task.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: task,
    });
    if (previous?.candidateCommit && previous.candidateCommit !== task.candidateCommit) {
      const oldEvidence = this.getSnapshot(task.projectId).evidence.filter(
        (item) => item.taskId === task.id && item.status !== "invalidated" && item.commitSha !== task.candidateCommit,
      );
      for (const item of oldEvidence) {
        this.recordEvidence(
          { ...item, status: "invalidated" },
          { actor: "system", correlationId: event.correlationId, causationId: event.id },
        );
      }
    }
    return task;
  }

  addTaskEdge(edge: TaskEdge, context: MutationContext = {}): TaskEdge {
    const snapshot = this.getSnapshot(edge.projectId);
    assertAcyclicEdge(snapshot.tasks, snapshot.edges, edge);
    this.appendEvent({
      projectId: edge.projectId,
      type: EVENT_TYPES.taskEdgeAdded,
      actor: context.actor ?? "system",
      aggregateType: "task_edge",
      aggregateId: `${edge.fromTaskId}:${edge.toTaskId}`,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: edge,
    });
    return edge;
  }

  upsertQuestion(question: Question, context: MutationContext = {}): Question {
    this.requireProject(question.projectId);
    this.appendEvent({
      projectId: question.projectId,
      type: EVENT_TYPES.questionUpserted,
      actor: context.actor ?? "system",
      aggregateType: "question",
      aggregateId: question.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: question,
    });
    return question;
  }

  answerQuestion(projectId: string, questionId: string, answer: string, context: MutationContext = {}): Question {
    const question = this.getQuestion(questionId);
    if (!question || question.projectId !== projectId) throw new Error(`Question not found: ${questionId}`);
    if (question.status !== "open") throw new Error("Question is not open");
    const answered = this.upsertQuestion(
      { ...question, status: "answered", answer, answeredAt: now() },
      { ...context, actor: context.actor ?? "user" },
    );
    if (question.taskId) {
      const task = this.getTask(question.taskId);
      if (task?.status === "waiting_user") {
        this.upsertTask({ ...task, status: "ready", updatedAt: now() }, { actor: "system", ...context });
      }
    }
    return answered;
  }

  recordEvidence(evidence: EvidenceRef, context: MutationContext = {}): EvidenceRef {
    this.requireProject(evidence.projectId);
    this.appendEvent({
      projectId: evidence.projectId,
      type: EVENT_TYPES.evidenceRecorded,
      actor: context.actor ?? "worker",
      aggregateType: "evidence",
      aggregateId: evidence.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: evidence,
    });
    return evidence;
  }

  recordModelCall(call: ModelCallUsage, context: MutationContext = {}): ModelCallUsage {
    this.requireProject(call.projectId);
    this.appendEvent({
      projectId: call.projectId,
      type: EVENT_TYPES.modelCallRecorded,
      actor: context.actor ?? "model",
      aggregateType: "model_call",
      aggregateId: call.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: call,
    });
    return call;
  }

  upsertChangeset(changeset: Changeset, context: MutationContext = {}): Changeset {
    this.requireProject(changeset.projectId);
    this.appendEvent({
      projectId: changeset.projectId,
      type: EVENT_TYPES.changesetUpserted,
      actor: context.actor ?? "worker",
      aggregateType: "changeset",
      aggregateId: changeset.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: changeset,
    });
    return changeset;
  }

  upsertDeployment(deployment: Deployment, context: MutationContext = {}): Deployment {
    this.requireProject(deployment.projectId);
    this.appendEvent({
      projectId: deployment.projectId,
      type: EVENT_TYPES.deploymentUpserted,
      actor: context.actor ?? "worker",
      aggregateType: "deployment",
      aggregateId: deployment.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload: deployment,
    });
    return deployment;
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as ProjectRow[]).map(projectFromRow);
  }

  getProject(projectId: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  getEvents(projectId: string, afterSeq = 0): EventEnvelope[] {
    return (
      this.db.prepare("SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq").all(projectId, afterSeq) as EventRow[]
    ).map(eventFromRow);
  }

  events(projectId: string, afterSeq = 0): EventEnvelope[] {
    return this.getEvents(projectId, afterSeq);
  }

  getSnapshot(projectId: string): ProjectSnapshot {
    const project = this.requireProject(projectId);
    const facts = (this.db.prepare("SELECT * FROM facts WHERE project_id = ? ORDER BY fact_id, revision").all(projectId) as FactRow[]).map(factFromRow);
    const tasks = (this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id").all(projectId) as TaskRow[]).map(taskFromRow);
    const edges = (this.db.prepare("SELECT * FROM task_edges WHERE project_id = ? ORDER BY from_task_id, to_task_id").all(projectId) as EdgeRow[]).map(edgeFromRow);
    const questions = (this.db.prepare("SELECT * FROM questions WHERE project_id = ? ORDER BY created_at").all(projectId) as QuestionRow[]).map(questionFromRow);
    const evidence = (this.db.prepare("SELECT * FROM evidence WHERE project_id = ? ORDER BY created_at").all(projectId) as EvidenceRow[]).map(evidenceFromRow);
    const modelCalls = (this.db.prepare("SELECT * FROM model_calls WHERE project_id = ? ORDER BY created_at").all(projectId) as ModelCallRow[]).map(modelCallFromRow);
    const changesets = (this.db.prepare("SELECT * FROM changesets WHERE project_id = ? ORDER BY created_at").all(projectId) as ChangesetRow[]).map(changesetFromRow);
    const deployments = (this.db.prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at").all(projectId) as DeploymentRow[]).map(deploymentFromRow);
    const sequence = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project_id = ?").get(projectId) as { seq: number };
    return { project, facts, tasks, edges, questions, evidence, modelCalls, changesets, deployments, lastSeq: sequence.seq };
  }

  snapshot(projectId: string): ProjectSnapshot {
    return this.getSnapshot(projectId);
  }

  subscribe(projectId: string, listener: (event: EventEnvelope) => void): () => void {
    this.emitter.on(projectId, listener);
    return () => this.emitter.off(projectId, listener);
  }

  rebuildProjections(): void {
    this.db.transaction(() => {
      this.db.pragma("defer_foreign_keys = ON");
      for (const table of projectionTables) this.db.prepare(`DELETE FROM ${table}`).run();
      const rows = this.db.prepare("SELECT * FROM events ORDER BY project_id, seq").all() as EventRow[];
      for (const row of rows) this.applyEvent(eventFromRow(row));
    })();
  }

  private requireProject(projectId: string): Project {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  getTask(taskId: string): TaskNode | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  getQuestion(questionId: string): Question | undefined {
    const row = this.db.prepare("SELECT * FROM questions WHERE id = ?").get(questionId) as QuestionRow | undefined;
    return row ? questionFromRow(row) : undefined;
  }

  private applyEvent(event: EventEnvelope): void {
    switch (event.type) {
      case EVENT_TYPES.projectCreated:
      case EVENT_TYPES.projectUpdated: {
        const p = event.payload as unknown as Project;
        this.db.prepare(`INSERT INTO projects(id,name,status,created_at,updated_at,head_commit) VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,updated_at=excluded.updated_at,head_commit=excluded.head_commit`)
          .run(p.id, p.name, p.status, p.createdAt, p.updatedAt, p.headCommit);
        break;
      }
      case EVENT_TYPES.factRevised: {
        const f = event.payload as unknown as FactRevision;
        this.db.prepare("INSERT OR REPLACE INTO facts VALUES(?,?,?,?,?,?,?)")
          .run(f.projectId, f.factId, f.revision, f.kind, stringify(f.value), f.sourceEventId, f.createdAt);
        break;
      }
      case EVENT_TYPES.taskUpserted: {
        const t = event.payload as unknown as TaskNode;
        this.db.prepare(`INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,status=excluded.status,parent_id=excluded.parent_id,
          attempt=excluded.attempt,base_commit=excluded.base_commit,candidate_commit=excluded.candidate_commit,
          depends_on_facts_json=excluded.depends_on_facts_json,input_json=excluded.input_json,output_json=excluded.output_json,
          error=excluded.error,updated_at=excluded.updated_at`)
          .run(t.id,t.projectId,t.kind,t.title,t.status,t.parentId,t.attempt,t.baseCommit,t.candidateCommit,stringify(t.dependsOnFacts),stringify(t.input),t.output === null ? null : stringify(t.output),t.error,t.createdAt,t.updatedAt);
        break;
      }
      case EVENT_TYPES.taskEdgeAdded: {
        const e = event.payload as unknown as TaskEdge;
        this.db.prepare("INSERT OR IGNORE INTO task_edges VALUES(?,?,?)").run(e.projectId,e.fromTaskId,e.toTaskId);
        break;
      }
      case EVENT_TYPES.questionUpserted: {
        const q = event.payload as unknown as Question;
        this.db.prepare(`INSERT INTO questions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          task_id=excluded.task_id,prompt=excluded.prompt,status=excluded.status,answer=excluded.answer,answered_at=excluded.answered_at`)
          .run(q.id,q.projectId,q.taskId,q.prompt,q.status,q.answer,q.createdAt,q.answeredAt);
        break;
      }
      case EVENT_TYPES.evidenceRecorded: {
        const e = event.payload as unknown as EvidenceRef;
        this.db.prepare("INSERT OR REPLACE INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(e.id,e.projectId,e.taskId,e.kind,e.status,e.commitSha,e.commandId,e.imageRef,e.exitCode,e.durationMs,e.logHash,stringify(e.details),e.createdAt);
        break;
      }
      case EVENT_TYPES.modelCallRecorded: {
        const c = event.payload as unknown as ModelCallUsage;
        this.db.prepare("INSERT OR REPLACE INTO model_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(c.id,c.projectId,c.taskId,c.provider,c.model,c.purpose,c.promptTokens,c.completionTokens,c.totalTokens,c.estimatedCostCny,c.latencyMs,c.status,c.createdAt);
        break;
      }
      case EVENT_TYPES.changesetUpserted: {
        const c = event.payload as unknown as Changeset;
        this.db.prepare(`INSERT INTO changesets VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          candidate_commit=excluded.candidate_commit,branch=excluded.branch,worktree_path=excluded.worktree_path,status=excluded.status,updated_at=excluded.updated_at`)
          .run(c.id,c.projectId,c.taskId,c.baseCommit,c.candidateCommit,c.branch,c.worktreePath,c.status,c.createdAt,c.updatedAt);
        break;
      }
      case EVENT_TYPES.deploymentUpserted: {
        const d = event.payload as unknown as Deployment;
        this.db.prepare(`INSERT INTO deployments VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          commit_sha=excluded.commit_sha,image_ref=excluded.image_ref,container_id=excluded.container_id,preview_url=excluded.preview_url,status=excluded.status,updated_at=excluded.updated_at`)
          .run(d.id,d.projectId,d.commitSha,d.imageRef,d.containerId,d.previewUrl,d.status,d.createdAt,d.updatedAt);
        break;
      }
    }
  }
}

type ProjectRow = { id:string; name:string; status:Project["status"]; created_at:string; updated_at:string; head_commit:string|null };
type EventRow = { id:string; project_id:string; seq:number; type:string; actor:Actor; aggregate_type:string; aggregate_id:string; correlation_id:string; causation_id:string|null; payload_json:string; occurred_at:string };
type FactRow = { project_id:string; fact_id:string; revision:number; kind:string; value_json:string; source_event_id:string; created_at:string };
type TaskRow = { id:string; project_id:string; kind:TaskNode["kind"]; title:string; status:TaskNode["status"]; parent_id:string|null; attempt:number; base_commit:string|null; candidate_commit:string|null; depends_on_facts_json:string; input_json:string; output_json:string|null; error:string|null; created_at:string; updated_at:string };
type EdgeRow = { project_id:string; from_task_id:string; to_task_id:string };
type QuestionRow = { id:string; project_id:string; task_id:string|null; prompt:string; status:Question["status"]; answer:string|null; created_at:string; answered_at:string|null };
type EvidenceRow = { id:string; project_id:string; task_id:string; kind:EvidenceRef["kind"]; status:EvidenceRef["status"]; commit_sha:string; command_id:string; image_ref:string|null; exit_code:number|null; duration_ms:number; log_hash:string; details_json:string; created_at:string };
type ModelCallRow = { id:string; project_id:string; task_id:string|null; provider:string; model:string; purpose:string; prompt_tokens:number; completion_tokens:number; total_tokens:number; estimated_cost_cny:number|null; latency_ms:number; status:ModelCallUsage["status"]; created_at:string };
type ChangesetRow = { id:string; project_id:string; task_id:string; base_commit:string; candidate_commit:string|null; branch:string; worktree_path:string; status:Changeset["status"]; created_at:string; updated_at:string };
type DeploymentRow = { id:string; project_id:string; commit_sha:string; image_ref:string; container_id:string|null; preview_url:string|null; status:Deployment["status"]; created_at:string; updated_at:string };

const projectFromRow = (r:ProjectRow):Project => ({ id:r.id,name:r.name,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,headCommit:r.head_commit });
const eventFromRow = (r:EventRow):EventEnvelope => ({ id:r.id,projectId:r.project_id,seq:r.seq,type:r.type,actor:r.actor,aggregateType:r.aggregate_type,aggregateId:r.aggregate_id,correlationId:r.correlation_id,causationId:r.causation_id,payload:parse<JsonValue>(r.payload_json),occurredAt:r.occurred_at });
const factFromRow = (r:FactRow):FactRevision => ({ projectId:r.project_id,factId:r.fact_id,revision:r.revision,kind:r.kind,value:parse<JsonValue>(r.value_json),sourceEventId:r.source_event_id,createdAt:r.created_at });
const taskFromRow = (r:TaskRow):TaskNode => ({ id:r.id,projectId:r.project_id,kind:r.kind,title:r.title,status:r.status,parentId:r.parent_id,attempt:r.attempt,baseCommit:r.base_commit,candidateCommit:r.candidate_commit,dependsOnFacts:parse(r.depends_on_facts_json),input:parse(r.input_json),output:r.output_json===null?null:parse(r.output_json),error:r.error,createdAt:r.created_at,updatedAt:r.updated_at });
const edgeFromRow = (r:EdgeRow):TaskEdge => ({ projectId:r.project_id,fromTaskId:r.from_task_id,toTaskId:r.to_task_id });
const questionFromRow = (r:QuestionRow):Question => ({ id:r.id,projectId:r.project_id,taskId:r.task_id,prompt:r.prompt,status:r.status,answer:r.answer,createdAt:r.created_at,answeredAt:r.answered_at });
const evidenceFromRow = (r:EvidenceRow):EvidenceRef => ({ id:r.id,projectId:r.project_id,taskId:r.task_id,kind:r.kind,status:r.status,commitSha:r.commit_sha,commandId:r.command_id,imageRef:r.image_ref,exitCode:r.exit_code,durationMs:r.duration_ms,logHash:r.log_hash,details:parse(r.details_json),createdAt:r.created_at });
const modelCallFromRow = (r:ModelCallRow):ModelCallUsage => ({ id:r.id,projectId:r.project_id,taskId:r.task_id,provider:r.provider,model:r.model,purpose:r.purpose,promptTokens:r.prompt_tokens,completionTokens:r.completion_tokens,totalTokens:r.total_tokens,estimatedCostCny:r.estimated_cost_cny,latencyMs:r.latency_ms,status:r.status,createdAt:r.created_at });
const changesetFromRow = (r:ChangesetRow):Changeset => ({ id:r.id,projectId:r.project_id,taskId:r.task_id,baseCommit:r.base_commit,candidateCommit:r.candidate_commit,branch:r.branch,worktreePath:r.worktree_path,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at });
const deploymentFromRow = (r:DeploymentRow):Deployment => ({ id:r.id,projectId:r.project_id,commitSha:r.commit_sha,imageRef:r.image_ref,containerId:r.container_id,previewUrl:r.preview_url,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at });

export { type ProjectSnapshot } from "./types.js";
