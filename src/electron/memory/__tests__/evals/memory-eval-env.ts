/**
 * Offline environment for the memory evals (audit §8.5, docs/harness-eval-battery.md):
 * a fresh profile database with the real schema in a temporary directory, the real memory
 * services over it (MemoryService archive capture and search, the conversation index, the
 * knowledge graph, MemoryWriter, MemoryRecall with its production lane wiring) and no
 * network, model or desktop dependencies. Everything is deterministic: ids are mapped
 * from fixture keys and the writer's clock is a counter.
 *
 * Callers (the eval test) must mock `electron` and route the memory statement port to the
 * host (`database/async/runtime.getDatabaseClient` → null) before importing this module.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { DatabaseManager } from "../../../database/schema";
import { WorkspaceStore } from "../../../database/repositories";
import type { Workspace } from "../../../../shared/types";
import { MemoryFeaturesManager } from "../../../settings/memory-features-manager";
import { KnowledgeGraphService } from "../../../knowledge-graph/KnowledgeGraphService";
import { DurableContextService } from "../../DurableContextService";
import { MemoryService } from "../../MemoryService";
import { MemoryItemsRepository } from "../../MemoryItemsRepository";
import { MemoryWriter, type MemoryCandidate, type MemoryWriteResult } from "../../MemoryWriter";
import { MemoryRecallService, defaultMemoryRecallDeps } from "../../MemoryRecall";
import type { MemoryItemKind, MemoryItemScope, MemoryItemSource } from "../../memory-items-types";

export interface EvalWorkspaceSpec {
  key: string;
  name: string;
}

/** A memory item to seed, written through MemoryWriter (salience, redaction, dedupe). */
export interface EvalItemSpec {
  key: string;
  workspace?: string | null;
  scope?: MemoryItemScope;
  scopeRef?: string | null;
  kind: MemoryItemKind;
  source?: MemoryItemSource;
  subject?: string;
  content: string;
  pinned?: boolean;
  privacy?: "normal" | "private";
  /** Write, then forget (`deleted`) the item. */
  forgotten?: boolean;
  /** Already expired by this many ms when written. */
  expiredByMs?: number;
  /** The message the fact came from (checked for `<no-memory>`). */
  originText?: string;
}

/** An archive row, captured through MemoryService.capture. */
export interface EvalArchiveSpec {
  key: string;
  workspace: string;
  type: "observation" | "decision" | "error" | "insight" | "summary";
  content: string;
  private?: boolean;
  /** Inspector action after capture: deleted (suppressed) or redacted. */
  state?: "suppressed" | "redacted";
  /** Stored as an import of another workspace (`[Imported from …]`, origin import). */
  imported?: boolean;
}

/** One indexed conversation event of an earlier task. */
export interface EvalConversationSpec {
  key: string;
  workspace: string;
  task: string;
  type: string;
  payload: unknown;
}

export interface EvalEntitySpec {
  key: string;
  workspace: string;
  type: string;
  name: string;
  description: string;
  /** Observations attached to the entity (not in the entity FTS index). */
  observations?: string[];
}

export interface MemoryEvalEnv {
  dir: string;
  db: Database.Database;
  manager: DatabaseManager;
  writer: MemoryWriter;
  repository: MemoryItemsRepository;
  recall: MemoryRecallService;
  workspaces: Map<string, Workspace>;
  /** Fixture key → recall ref (`memory:<id>`, `archive:<id>`, `event:<id>`, `kg:<id>`). */
  refs: Map<string, string>;
  /** Recall ref → fixture key. */
  keysByRef: Map<string, string>;
  workspaceId(key: string | null | undefined): string | null;
  ensureTask(workspaceKey: string, taskKey: string, title?: string, prompt?: string): string;
  taskId(taskKey: string): string;
  close(): Promise<void>;
}

const PERMISSIONS = {
  read: true,
  write: true,
  delete: false,
  network: false,
  shell: false,
};

/** Create a fresh profile with the given workspaces and the memory services over it. */
export async function createMemoryEvalEnv(
  workspaceSpecs: EvalWorkspaceSpec[],
): Promise<MemoryEvalEnv> {
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-evals-"));
  process.env.COWORK_USER_DATA_DIR = dir;
  const manager = new DatabaseManager();
  const db = manager.getDatabase();

  const workspaces = new Map<string, Workspace>();
  const store = new WorkspaceStore(db);
  for (const spec of workspaceSpecs) {
    const root = path.join(dir, "workspaces", spec.key);
    fs.mkdirSync(root, { recursive: true });
    workspaces.set(spec.key, store.create(spec.name, root, PERMISSIONS));
  }

  MemoryFeaturesManager.initialize();
  MemoryService.initialize(manager);
  DurableContextService.setDatabaseForTests(db);
  KnowledgeGraphService.initialize(db);

  let clock = 1_700_000_000_000;
  const repository = new MemoryItemsRepository(db);
  const writer = new MemoryWriter({
    repository,
    getWorkspacePolicy: (workspaceId) => MemoryService.getSettings(workspaceId),
    now: () => (clock += 1_000),
  });
  MemoryWriter.setInstance(writer);
  // The lane migration has nothing to copy in a fresh profile; record it so prompt
  // building reads memory_items rather than the legacy stores.
  await repository.recordLaneMigration({}, clock);
  const recall = new MemoryRecallService(defaultMemoryRecallDeps());
  MemoryRecallService.setDefault(recall);

  const tasks = new Map<string, string>();
  const env: MemoryEvalEnv = {
    dir,
    db,
    manager,
    writer,
    repository,
    recall,
    workspaces,
    refs: new Map(),
    keysByRef: new Map(),
    workspaceId(key) {
      if (!key) return null;
      const workspace = workspaces.get(key);
      if (!workspace) throw new Error(`unknown fixture workspace: ${key}`);
      return workspace.id;
    },
    ensureTask(workspaceKey, taskKey, title = taskKey, prompt = title) {
      const existing = tasks.get(taskKey);
      if (existing) return existing;
      const id = `task-${taskKey}`;
      const now = Date.now();
      db.prepare(
        `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at)
         VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
      ).run(id, title, prompt, env.workspaceId(workspaceKey), now, now);
      tasks.set(taskKey, id);
      return id;
    },
    taskId(taskKey) {
      const id = tasks.get(taskKey);
      if (!id) throw new Error(`unknown fixture task: ${taskKey}`);
      return id;
    },
    async close() {
      await writer.flush();
      await DurableContextService.flushIndexQueue();
      MemoryRecallService.setDefault(null);
      MemoryWriter.setInstance(null);
      DurableContextService.setDatabaseForTests(null);
      MemoryService.shutdown();
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
      if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
      else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    },
  };
  return env;
}

function remember(env: MemoryEvalEnv, key: string, ref: string): void {
  env.refs.set(key, ref);
  env.keysByRef.set(ref, key);
}

/** Write one fixture item through MemoryWriter; returns the writer's result. */
export async function seedItem(env: MemoryEvalEnv, spec: EvalItemSpec): Promise<MemoryWriteResult> {
  const scope: MemoryItemScope = spec.scope ?? (spec.workspace ? "workspace" : "global");
  const workspaceId = env.workspaceId(spec.workspace ?? null);
  const candidate: MemoryCandidate = {
    content: spec.content,
    kind: spec.kind,
    scope,
    workspaceId,
    scopeRef:
      scope === "task" && spec.scopeRef
        ? env.ensureTask(spec.workspace as string, spec.scopeRef)
        : (spec.scopeRef ?? null),
    source: spec.source ?? "user_stated",
    sourceRef: { store: "eval_fixture", id: spec.key },
    ...(spec.subject ? { subjectKey: spec.subject } : {}),
    ...(spec.pinned ? { pinned: true } : {}),
    ...(spec.privacy ? { privacy: spec.privacy } : {}),
    ...(spec.expiredByMs ? { expiresAt: Date.now() - spec.expiredByMs } : {}),
    ...(spec.originText ? { originText: spec.originText } : {}),
  };
  const result = await env.writer.ingest(candidate);
  if (result.status === "written") {
    remember(env, spec.key, `memory:${result.item.id}`);
    if (spec.forgotten) await env.writer.setStatus(result.item.id, "deleted");
  }
  return result;
}

/** Capture one archive row through MemoryService.capture (redaction, privacy, dedupe). */
export async function seedArchive(env: MemoryEvalEnv, spec: EvalArchiveSpec): Promise<string> {
  const workspaceId = env.workspaceId(spec.workspace) as string;
  const content = spec.imported ? `[Imported from ChatGPT — eval]\n${spec.content}` : spec.content;
  const memory = await MemoryService.capture(
    workspaceId,
    undefined,
    spec.type,
    content,
    spec.private === true,
    {
      forceCapture: true,
      ...(spec.imported ? { origin: "import" as const } : {}),
    },
  );
  if (!memory) throw new Error(`archive fixture ${spec.key} was not captured`);
  if (spec.state === "suppressed") {
    const { MemoryObservationService } = await import("../../MemoryObservationService");
    await MemoryObservationService.delete(workspaceId, memory.id);
  } else if (spec.state === "redacted") {
    const { MemoryObservationService } = await import("../../MemoryObservationService");
    await MemoryObservationService.redact(workspaceId, memory.id);
  }
  remember(env, spec.key, `archive:${memory.id}`);
  return memory.id;
}

let eventCounter = 0;

/** Index one conversation event of an earlier task (the conversation index lane). */
export function seedConversation(env: MemoryEvalEnv, spec: EvalConversationSpec): void {
  const workspaceId = env.workspaceId(spec.workspace) as string;
  const taskId = env.ensureTask(spec.workspace, spec.task);
  eventCounter += 1;
  DurableContextService.indexEvent({
    workspaceId,
    taskId,
    type: spec.type,
    payload: spec.payload,
    timestamp: 1_700_000_000_000 + eventCounter,
    eventId: `eval-${spec.key}`,
  });
}

/** Conversation hits carry index ids, not event ids: map them back after flushing. */
export async function resolveConversationRefs(
  env: MemoryEvalEnv,
  specs: EvalConversationSpec[],
): Promise<void> {
  await DurableContextService.flushIndexQueue();
  const rows = env.db
    .prepare("SELECT id, event_id FROM durable_context_events WHERE event_id LIKE 'eval-%'")
    .all() as Array<{ id: number; event_id: string }>;
  const byEventId = new Map(rows.map((row) => [row.event_id, row.id]));
  for (const spec of specs) {
    const id = byEventId.get(`eval-${spec.key}`);
    if (id === undefined) throw new Error(`conversation fixture ${spec.key} was not indexed`);
    remember(env, spec.key, `event:dce_${id}`);
  }
}

export async function seedEntity(env: MemoryEvalEnv, spec: EvalEntitySpec): Promise<void> {
  const workspaceId = env.workspaceId(spec.workspace) as string;
  const entity = await KnowledgeGraphService.createEntity(
    workspaceId,
    { entityType: spec.type, name: spec.name, description: spec.description },
    "manual",
  );
  for (const content of spec.observations ?? []) {
    await KnowledgeGraphService.addObservation(
      workspaceId,
      { entityId: entity.id, content },
      "manual",
    );
  }
  remember(env, spec.key, `kg:${entity.id}`);
}
