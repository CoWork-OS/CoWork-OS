/**
 * The agent's memory tools (audit §8.3, docs/memory-engine.md):
 *
 *  - `memory_recall`   one recall over facts, the archive, earlier conversations, notes,
 *                      the knowledge graph and (when allowed) Supermemory (MemoryRecall);
 *  - `memory_remember` durable facts through MemoryWriter (`memory_items`); episodic
 *                      kinds (`outcome`, `error`, `note`) go to the archive;
 *  - `memory_forget`   a real delete of a memory item (and the legacy record it mirrors)
 *                      or of an archive row of this workspace;
 *  - `context_recall`  the active task's earlier conversation after compaction.
 *
 * The 16 tools these replace stay executable as hidden aliases for one release
 * (`executeLegacyAlias`, LEGACY_MEMORY_TOOL_ALIASES), so saved prompts and skills keep
 * working, but they are no longer offered to the model.
 */
import { randomUUID } from "crypto";
import * as path from "path";
import type { LLMTool } from "../llm/types";
import {
  LEGACY_MEMORY_TOOL_ALIASES,
  type CuratedMemoryKind,
  type Workspace,
} from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import { MemoryService } from "../../memory/MemoryService";
import { CuratedMemoryService } from "../../memory/CuratedMemoryService";
import { MemoryWriteGate } from "../../memory/MemoryWriteGate";
import { MemoryWriter, type MemoryWriteResult } from "../../memory/MemoryWriter";
import { MemoryItemsHubService } from "../../memory/MemoryItemsHubService";
import { createLegacyMemoryMirror } from "../../memory/memory-items-legacy-mirror";
import { DurableContextService } from "../../memory/DurableContextService";
import { SupermemoryService } from "../../memory/SupermemoryService";
import {
  DEFAULT_MEMORY_RECALL_SCOPES,
  MEMORY_RECALL_DEFAULT_LIMIT,
  MEMORY_RECALL_MAX_LIMIT,
  MEMORY_RECALL_SCOPES,
  MemoryRecallService,
  lanesForScopes,
  parseRecallRef,
  type MemoryRecallResult,
  type MemoryRecallScope,
} from "../../memory/MemoryRecall";
import type { MemoryRecallHit } from "../../memory/memory-engine-contracts";
import {
  MEMORY_ITEM_KINDS,
  type MemoryItemKind,
  type MemoryItemScope,
} from "../../memory/memory-items-types";
import {
  CONTEXT_RECALL_TOOL,
  MEMORY_FORGET_TOOL,
  MEMORY_RECALL_TOOL,
  MEMORY_REMEMBER_TOOL,
} from "../../memory/memory-tool-routing";
import { termCoverage } from "../../database/fts-query";
import type { MemoryType } from "../../database/repositories";
import { evaluateWorkspaceFilesystemAccess } from "../../security/access-profile-paths";
import {
  containsNoMemoryDirective,
  taskDisablesMemoryCapture,
} from "../../memory/no-memory-directive";

export const NO_MEMORY_WRITE_ERROR =
  "Memory writes are disabled for this task (<no-memory>). Nothing was saved.";

/**
 * Whether a task's `<no-memory>` directive (or one in the content itself) blocks explicit
 * memory writes. `<no-memory>` covers every memory write of the task, not only automatic
 * capture.
 */
export function explicitMemoryWriteBlocked(
  daemon: Pick<AgentDaemon, "getTask"> | undefined,
  taskId: string,
  content?: unknown,
): boolean {
  if (containsNoMemoryDirective(content)) return true;
  try {
    return taskDisablesMemoryCapture(daemon?.getTask?.(taskId));
  } catch {
    return false;
  }
}

/** Kinds `memory_remember` accepts: fact kinds plus the archive's episodic kinds. */
export const MEMORY_REMEMBER_KINDS = [
  "preference",
  "identity",
  "rule",
  "project_fact",
  "decision",
  "commitment",
  "correction",
  "insight",
  "outcome",
  "error",
  "note",
] as const;
export type MemoryRememberKind = (typeof MEMORY_REMEMBER_KINDS)[number];

/** Episodic kinds stay in the archive in Phase 2 (docs/memory-engine.md §6). */
const ARCHIVE_KINDS: Readonly<Partial<Record<MemoryRememberKind, MemoryType>>> = {
  outcome: "summary",
  error: "error",
  note: "observation",
};

/** Archive type for a fact when the fact store is not running (headless daemon). */
const ARCHIVE_FALLBACK_TYPES: Readonly<Record<MemoryItemKind, MemoryType>> = {
  preference: "preference",
  identity: "observation",
  rule: "constraint",
  project_fact: "observation",
  decision: "decision",
  commitment: "observation",
  correction: "correction_rule",
  insight: "insight",
  outcome: "summary",
};

/** Facts about the user hold everywhere by default; the rest belongs to the workspace. */
const GLOBAL_BY_DEFAULT: ReadonlySet<string> = new Set(["identity", "preference", "correction"]);

/** Curated lane used when an approval-gated fact write is replayed after approval. */
const CURATED_REPLAY_KIND: Readonly<Record<MemoryItemKind, CuratedMemoryKind>> = {
  preference: "preference",
  identity: "identity",
  rule: "constraint",
  project_fact: "project_fact",
  decision: "project_fact",
  commitment: "active_commitment",
  correction: "constraint",
  insight: "project_fact",
  outcome: "project_fact",
};

const CURATED_TO_ITEM_KINDS: Readonly<Record<string, MemoryItemKind[]>> = {
  identity: ["identity"],
  preference: ["preference"],
  constraint: ["rule"],
  workflow_rule: ["rule"],
  project_fact: ["project_fact"],
  active_commitment: ["commitment"],
};

/**
 * An explicit request to remember, in the user's own message. `user_asked` from the model
 * is only honoured with one of these, so a page or file the agent read cannot make an
 * inference look user-stated (trust 1.0 outranks everything else).
 */
const EXPLICIT_REMEMBER_REQUEST =
  /\b(?:remember|memori[sz]e|don'?t forget|do not forget|keep in mind|make a note|note (?:that|this|down)|save (?:this|that|it)|from now on|going forward|always|never|call me|my name is|i prefer|i'?m called|merk(?:e)? dir|vergiss nicht|ab jetzt|immer|niemals|souviens[- ]toi|retiens|n'oublie pas|à partir de maintenant|recuerda|no olvides|a partir de ahora|siempre|nunca)\b|hatırla|unutma|aklında tut|bundan sonra|her zaman|asla|adım\b/iu;

export function isExplicitRememberRequest(text: string | null | undefined): boolean {
  return EXPLICIT_REMEMBER_REQUEST.test(String(text || ""));
}

const MAX_QUERY_CHARS = 2000;
const MAX_CONTENT_CHARS = 4000;
const MAX_IDS = MEMORY_RECALL_MAX_LIMIT;

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asStringList(value: unknown, maxItems: number, maxChars = 300): string[] {
  if (!Array.isArray(value)) return typeof value === "string" && value.trim() ? [value.trim()] : [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function pickEnum<T extends string>(values: unknown, allowed: readonly T[]): T[] {
  const list = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
  return [...new Set(list.filter((value): value is T => allowed.includes(value as T)))];
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function recallFailureMessage(tool: string, detail: string): string {
  return `${tool} failed: ${detail.slice(0, 300)}. Recall did not run; do not treat this as "no results".`;
}

function isoDate(value: number): string | undefined {
  return value > 0 && Number.isFinite(value)
    ? new Date(value).toISOString().slice(0, 10)
    : undefined;
}

function skipMessage(result: Extract<MemoryWriteResult, { status: "skipped" }>): string {
  switch (result.reason) {
    case "empty":
    case "low_salience":
      return "Nothing worth remembering: the text is empty, too short or raw tool output.";
    case "secret_only":
      return "The text is a secret; secrets are never stored in memory.";
    case "no_memory":
      return NO_MEMORY_WRITE_ERROR;
    case "memory_disabled":
      return "Memory is turned off for this workspace, so inferred memories are not saved.";
    case "outranked":
      return "A memory the user stated or confirmed already holds this subject; it was kept.";
    case "invalid_scope":
      return "Invalid scope for this memory.";
    default:
      return "The memory was not saved.";
  }
}

export interface MemoryRecallToolInput {
  query?: string;
  scopes?: string[];
  kinds?: string[];
  detail?: "index" | "full";
  ids?: string[];
  limit?: number;
}

export interface MemoryRememberToolInput {
  content?: string;
  kind?: string;
  scope?: string;
  subject?: string;
  pin?: boolean;
  user_asked?: boolean;
}

export interface MemoryForgetToolInput {
  id?: string;
  match?: string;
  reason?: string;
}

export interface ContextRecallToolInput {
  query?: string;
  id?: string;
  limit?: number;
  /** Alias-only (context_grep / context_describe): inspect another task on request. */
  taskId?: string;
  explicitUserRequest?: boolean;
  sourceLimit?: number;
}

interface RecallRouting {
  /** Tool name for logging (a deprecated alias logs under its own name). */
  tool?: string;
  /** Restrict the conversation lane to one task (search_sessions / search_quotes). */
  conversationTaskId?: string;
  /** Include the active task in the conversation lane. */
  includeActiveTask?: boolean;
}

export class MemoryTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: MEMORY_RECALL_TOOL,
        description:
          "Search what CoWork remembers: saved facts, preferences, rules and decisions, earlier tasks' conversations, workspace notes and the knowledge graph. " +
          "Use it when the task depends on past context or the user refers to something from before. " +
          'Returns a ranked index; call again with ids and detail "full" to read items.',
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keywords, names, files or a question. Omit to list saved facts.",
            },
            scopes: {
              type: "array",
              items: { type: "string", enum: [...MEMORY_RECALL_SCOPES] },
              description:
                "Default memory, conversations, knowledge. external = Supermemory, when connected.",
            },
            kinds: {
              type: "array",
              items: { type: "string", enum: [...MEMORY_ITEM_KINDS] },
              description: "Only saved facts of these kinds.",
            },
            detail: {
              type: "string",
              enum: ["index", "full"],
              description: "full returns complete text; use it with ids.",
            },
            ids: {
              type: "array",
              items: { type: "string" },
              description: "Result ids to read in full.",
            },
            limit: { type: "number", description: "Max results (default 10, max 30)." },
          },
          required: [],
        },
      },
      {
        name: MEMORY_REMEMBER_TOOL,
        description:
          "Save a durable memory for later tasks: a user preference or identity detail, a rule, project fact, decision, commitment, correction or lesson. " +
          "Use it when the user asks you to remember something or you learn something stable that later tasks need. " +
          "Not for notes about the current task (use scratchpad_write).",
        input_schema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "One self-contained fact, e.g. 'Deploys go to staging first'.",
            },
            kind: {
              type: "string",
              enum: [...MEMORY_REMEMBER_KINDS],
              description: "outcome, error and note are kept as history; the rest as facts.",
            },
            scope: {
              type: "string",
              enum: ["workspace", "global", "task"],
              description:
                "global: about the user everywhere (default for identity, preference, correction); workspace: this project (default otherwise); task: this task only.",
            },
            subject: {
              type: "string",
              description:
                "Key of a single-valued fact (e.g. preferred_name, timezone): a new value replaces the old.",
            },
            pin: { type: "boolean", description: "Keep it in every prompt." },
            user_asked: {
              type: "boolean",
              description: "true only if the user explicitly asked you to remember this.",
            },
          },
          required: ["content", "kind"],
        },
      },
      {
        name: MEMORY_FORGET_TOOL,
        description:
          "Delete a saved memory so it is no longer recalled or injected. " +
          "Use it when the user asks you to forget something or a memory is wrong or outdated. " +
          "Pass an id from memory_recall, or match text that identifies exactly one memory.",
        input_schema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Id from memory_recall (memory:, archive:, external:).",
            },
            match: { type: "string", description: "Text of the memory, when you have no id." },
            reason: { type: "string", description: "Why it should be forgotten." },
          },
          required: [],
        },
      },
      {
        name: CONTEXT_RECALL_TOOL,
        description:
          "Search this task's earlier conversation, including parts no longer visible after context compaction, or expand one result by id. " +
          "Use it when you need exact earlier details of the current task.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords or a phrase to find." },
            id: { type: "string", description: "Result id to expand." },
            limit: { type: "number", description: "Max results (default 10, max 50)." },
          },
          required: [],
        },
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // memory_recall
  // ---------------------------------------------------------------------------

  async recall(
    input: MemoryRecallToolInput,
    routing: RecallRouting = {},
  ): Promise<Record<string, unknown>> {
    const tool = routing.tool ?? MEMORY_RECALL_TOOL;
    const query = asString(input?.query, MAX_QUERY_CHARS);
    const ids = asStringList(input?.ids, MAX_IDS);
    const requestedScopes = pickEnum(input?.scopes, MEMORY_RECALL_SCOPES);
    const scopes: MemoryRecallScope[] =
      requestedScopes.length > 0 ? requestedScopes : [...DEFAULT_MEMORY_RECALL_SCOPES];
    const kinds = pickEnum(input?.kinds, MEMORY_ITEM_KINDS);
    const full = input?.detail === "full" || ids.length > 0;
    const limit = clampLimit(input?.limit, MEMORY_RECALL_DEFAULT_LIMIT, MEMORY_RECALL_MAX_LIMIT);
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool,
      query,
      scopes,
      detail: full ? "full" : "index",
      idCount: ids.length,
    });

    if (!query && ids.length === 0 && !scopes.includes("memory")) {
      return this.recallError(tool, "Provide a query (or ids to expand).");
    }
    const externalRequested = scopes.includes("external");
    const externalAllowed = externalRequested && this.externalAllowed();

    let result: MemoryRecallResult;
    try {
      result = await MemoryRecallService.getDefault().recall({
        text: query,
        workspaceId: this.workspace.id,
        taskId: this.taskId,
        lanes: lanesForScopes(scopes),
        ...(kinds.length > 0 ? { kinds } : {}),
        surface: "tool",
        detail: full ? "full" : "index",
        ...(ids.length > 0 ? { ids } : {}),
        limit,
        policy: {
          workspacePath: this.workspace.path,
          readGuard: (candidatePath) => this.canReadWorkspacePath(candidatePath),
          allowExternal: externalAllowed,
          workspaceName: this.workspace.name,
          excludeActiveTaskConversation: routing.includeActiveTask !== true,
          ...(routing.conversationTaskId ? { conversationTaskId: routing.conversationTaskId } : {}),
        },
      });
    } catch (error) {
      return this.recallError(tool, error instanceof Error ? error.message : String(error));
    }

    const failedLanes = Object.keys(result.laneErrors);
    if (result.lanes.length > 0 && failedLanes.length === result.lanes.length) {
      return this.recallError(tool, Object.values(result.laneErrors).join("; "));
    }
    if (full && result.hits.length > 0) {
      // Reading an item in full is a use (retention, tier promotion); a listing is not.
      await MemoryRecallService.getDefault().markUsed(result.hits.map((hit) => hit.ref));
    }

    const unavailable: Record<string, string> = { ...result.laneErrors };
    if (externalRequested && !externalAllowed) {
      unavailable.external = "Supermemory is not connected or network access is off.";
    }
    const results = result.hits.map((hit) => this.formatHit(hit, full));
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool,
      success: true,
      resultCount: results.length,
      lanes: result.lanes,
      ...(failedLanes.length > 0 ? { failedLanes } : {}),
    });
    return {
      results,
      totalFound: results.length,
      ...(result.missing.length > 0 ? { notFound: result.missing } : {}),
      ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
      ...(!full && results.length > 0
        ? { next: 'Call memory_recall with ids and detail "full" to read complete items.' }
        : {}),
    };
  }

  private formatHit(hit: MemoryRecallHit, full: boolean): Record<string, unknown> {
    const snippet = hit.snippet ?? "";
    const titleIsRedundant = !hit.title || snippet.startsWith(hit.title.replace(/…$/, ""));
    const provenance = Object.fromEntries(
      Object.entries(hit.provenance ?? {}).filter(([, value]) => value !== undefined),
    );
    return {
      id: hit.ref,
      lane: hit.lane,
      ...(hit.kind ? { kind: hit.kind } : {}),
      ...(titleIsRedundant ? {} : { title: hit.title }),
      ...(full ? { content: hit.content ?? snippet } : { snippet }),
      source: hit.source,
      ...(isoDate(hit.createdAt) ? { date: isoDate(hit.createdAt) } : {}),
      ...(full ? {} : { relevance: hit.relevance, tokens: hit.tokenEstimate }),
      ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
    };
  }

  private recallError(tool: string, detail: string): Record<string, unknown> {
    this.daemon.logEvent(this.taskId, "tool_result", { tool, success: false, error: detail });
    return {
      success: false,
      error: recallFailureMessage(tool, detail),
      results: [],
      totalFound: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // memory_remember
  // ---------------------------------------------------------------------------

  async remember(
    input: MemoryRememberToolInput,
    routing: { tool?: string } = {},
  ): Promise<Record<string, unknown>> {
    const tool = routing.tool ?? MEMORY_REMEMBER_TOOL;
    const content = asString(input?.content, MAX_CONTENT_CHARS);
    const kind = MEMORY_REMEMBER_KINDS.includes(input?.kind as MemoryRememberKind)
      ? (input.kind as MemoryRememberKind)
      : null;
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool,
      kind: input?.kind,
      scope: input?.scope,
      contentLength: content.length,
    });
    const fail = (error: string, extra: Record<string, unknown> = {}) => {
      this.daemon.logEvent(this.taskId, "tool_result", { tool, success: false, error, ...extra });
      return { success: false, error, ...extra };
    };
    if (!content) return fail("content is required.");
    if (!kind) return fail(`kind must be one of: ${MEMORY_REMEMBER_KINDS.join(", ")}.`);
    if (explicitMemoryWriteBlocked(this.daemon, this.taskId, content)) {
      return fail(NO_MEMORY_WRITE_ERROR, { blocked: true, reason: "no_memory_directive" });
    }

    const archiveType = ARCHIVE_KINDS[kind];
    if (archiveType) return this.saveToArchive(tool, content, archiveType);

    const itemKind = kind as MemoryItemKind;
    const writer = MemoryWriter.get();
    if (!writer) {
      // The fact store runs in the desktop app; elsewhere keep the memory in the archive.
      return this.saveToArchive(tool, content, ARCHIVE_FALLBACK_TYPES[itemKind]);
    }

    const scope: MemoryItemScope =
      input?.scope === "global" || input?.scope === "workspace" || input?.scope === "task"
        ? input.scope
        : GLOBAL_BY_DEFAULT.has(itemKind)
          ? "global"
          : "workspace";
    const userText = this.latestUserText();
    const source =
      input?.user_asked === true && isExplicitRememberRequest(userText)
        ? "user_stated"
        : "inferred";
    const pin = input?.pin === true;

    try {
      const gate = await MemoryWriteGate.evaluate({
        workspaceId: this.workspace.id,
        taskId: this.taskId,
        target: "curated",
        action: "add",
        origin: "agent_tool",
        summary: `Remember ${itemKind}`,
        payload: {
          action: "add",
          target: itemKind === "identity" || itemKind === "preference" ? "user" : "workspace",
          kind: CURATED_REPLAY_KIND[itemKind],
          content,
        },
        proposedValue: content,
      });
      if (!gate.allowed) {
        if ("blocked" in gate) return fail(gate.error, { blocked: true });
        this.daemon.logEvent(this.taskId, "tool_result", {
          tool,
          success: true,
          staged: true,
          pendingId: gate.pendingId,
        });
        return {
          success: true,
          staged: true,
          pendingId: gate.pendingId,
          message: "Memory write is pending user approval.",
        };
      }

      const result = await writer.ingest({
        content,
        kind: itemKind,
        scope,
        workspaceId: scope === "global" ? null : this.workspace.id,
        scopeRef: scope === "task" ? this.taskId : null,
        ...(asString(input?.subject, 120) ? { subjectKey: asString(input?.subject, 120) } : {}),
        source,
        sourceRef: { store: "agent_tool", id: randomUUID(), taskId: this.taskId },
        confidence: source === "user_stated" ? 1 : 0.7,
        pinned: pin,
        taskId: this.taskId,
        originWorkspaceId: this.workspace.id,
        originText: userText,
      });
      if (result.status === "skipped") {
        return fail(skipMessage(result), { reason: result.reason });
      }
      if (result.item.scope === "workspace" && result.item.workspaceId) {
        await this.syncKitFiles(result.item.workspaceId);
      }
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool,
        success: true,
        memoryId: result.item.id,
        action: result.action,
        source,
      });
      return {
        success: true,
        id: `memory:${result.item.id}`,
        action: result.action,
        kind: result.item.kind,
        scope: result.item.scope,
        source,
        ...(result.item.pinned ? { pinned: true } : {}),
        ...(result.supersededIds.length > 0
          ? { replaced: result.supersededIds.map((id) => `memory:${id}`) }
          : {}),
        ...(result.redactions > 0 ? { redactions: result.redactions } : {}),
      };
    } catch (error) {
      return fail(String(error instanceof Error ? error.message : error));
    }
  }

  private async saveToArchive(
    tool: string,
    content: string,
    type: MemoryType,
  ): Promise<Record<string, unknown>> {
    try {
      const gate = await MemoryWriteGate.evaluate({
        workspaceId: this.workspace.id,
        taskId: this.taskId,
        target: "archive",
        action: "add",
        origin: "agent_tool",
        summary: `Save ${type} memory`,
        payload: {
          type,
          content,
          // Replayed on approval: still an explicit save, not auto-capture.
          options: { origin: "tool", forceCapture: true },
        },
        proposedValue: content,
      });
      if (!gate.allowed) {
        if ("blocked" in gate) {
          this.daemon.logEvent(this.taskId, "tool_result", { tool, success: false, blocked: true });
          return { success: false, error: gate.error };
        }
        this.daemon.logEvent(this.taskId, "tool_result", {
          tool,
          success: true,
          staged: true,
          pendingId: gate.pendingId,
        });
        return {
          success: true,
          staged: true,
          pendingId: gate.pendingId,
          message: "Memory write is pending user approval.",
        };
      }
      const memory = await MemoryService.capture(
        this.workspace.id,
        this.taskId,
        type,
        content,
        false,
        {
          origin: "tool",
          skipMemoryWriteGate: true,
          // An explicit save is not auto-capture: the autoCapture setting does not block it.
          forceCapture: true,
          allowExternalMirror: this.externalMirrorAllowed(),
        },
      );
      if (!memory) {
        const error =
          "Memory capture is disabled for this workspace or the content was filtered. " +
          "The user can enable it in Settings > Memory.";
        this.daemon.logEvent(this.taskId, "tool_result", { tool, success: false, error });
        return { success: false, error };
      }
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool,
        success: true,
        memoryId: memory.id,
      });
      return { success: true, id: `archive:${memory.id}`, stored: "archive", type };
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool,
        success: false,
        error: String(error),
      });
      return { success: false, error: String(error instanceof Error ? error.message : error) };
    }
  }

  // ---------------------------------------------------------------------------
  // memory_forget
  // ---------------------------------------------------------------------------

  async forget(
    input: MemoryForgetToolInput,
    routing: { tool?: string } = {},
  ): Promise<Record<string, unknown>> {
    const tool = routing.tool ?? MEMORY_FORGET_TOOL;
    const id = asString(input?.id, 600);
    const match = asString(input?.match, 1000);
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool,
      hasId: Boolean(id),
      hasMatch: Boolean(match),
    });
    const fail = (error: string, extra: Record<string, unknown> = {}) => {
      this.daemon.logEvent(this.taskId, "tool_result", { tool, success: false, error });
      return { success: false, error, ...extra };
    };
    const done = (ref: string) => {
      this.daemon.logEvent(this.taskId, "tool_result", { tool, success: true, forgotten: ref });
      return { success: true, forgotten: ref };
    };
    if (!id && !match)
      return fail("Provide the id of the memory (from memory_recall) or match text.");

    try {
      if (id) {
        const parsed = parseRecallRef(id);
        if (!parsed) return fail(`Unknown memory id "${id}".`);
        switch (parsed.kind) {
          case "item":
          case "uuid": {
            if (await this.forgetItem(parsed.id)) return done(`memory:${parsed.id}`);
            if (parsed.kind === "uuid" && (await this.forgetArchiveRow(parsed.id))) {
              return done(`archive:${parsed.id}`);
            }
            return fail(`No memory "${id}" in this workspace.`);
          }
          case "archive":
            return (await this.forgetArchiveRow(parsed.id))
              ? done(`archive:${parsed.id}`)
              : fail(`No memory "${id}" in this workspace.`);
          case "external": {
            if (!this.externalAllowed() || !SupermemoryService.isConfigured()) {
              return fail("Supermemory is not connected or network access is off.");
            }
            const result = await SupermemoryService.forget({
              workspace: { id: this.workspace.id, name: this.workspace.name },
              memoryId: parsed.id,
              ...(input?.reason ? { reason: asString(input.reason, 300) } : {}),
            });
            return result.forgotten
              ? done(`external:${parsed.id}`)
              : fail(`Supermemory did not forget "${parsed.id}".`);
          }
          case "kg":
            return fail("Knowledge-graph entities are removed with kg_delete_entity.");
          default:
            return fail("Conversation history and files cannot be forgotten with memory_forget.");
        }
      }

      const candidates = await this.forgetCandidates(match);
      if (candidates.length === 0) return fail(`No saved memory matches "${match}".`);
      if (candidates.length > 1) {
        return fail("More than one memory matches; pass the id of the one to forget.", {
          candidates: candidates.slice(0, 5).map((hit) => ({ id: hit.ref, snippet: hit.snippet })),
        });
      }
      const target = parseRecallRef(candidates[0].ref);
      if (target?.lane === "memory" && (await this.forgetItem(target.id))) {
        return done(candidates[0].ref);
      }
      if (target?.lane === "archive" && (await this.forgetArchiveRow(target.id))) {
        return done(candidates[0].ref);
      }
      return fail(`Could not forget "${candidates[0].ref}".`);
    } catch (error) {
      return fail(String(error instanceof Error ? error.message : error));
    }
  }

  /** Memory items and own archive rows containing every term of `match`. */
  private async forgetCandidates(match: string): Promise<MemoryRecallHit[]> {
    const result = await MemoryRecallService.getDefault().recall({
      text: match,
      workspaceId: this.workspace.id,
      taskId: this.taskId,
      lanes: ["memory", "archive"],
      minSource: "third_party",
      surface: "tool",
      detail: "full",
      limit: 10,
      policy: { includePrivate: true },
    });
    const visible: MemoryRecallHit[] = [];
    for (const hit of result.hits) {
      if (termCoverage(hit.content ?? hit.snippet ?? "", match) < 1) continue;
      // Imported rows of other workspaces are readable here but not this task's to delete.
      if (hit.lane === "archive" && hit.provenance?.imported === true) continue;
      visible.push(hit);
    }
    return visible;
  }

  /** Delete a memory item this workspace may see (and the legacy record it mirrors). */
  private async forgetItem(id: string): Promise<boolean> {
    const writer = MemoryWriter.get();
    if (!writer) return false;
    // Same visibility as recall: this workspace, global scope, this task; private included.
    const { hits } = await MemoryRecallService.getDefault().recall({
      text: "",
      workspaceId: this.workspace.id,
      taskId: this.taskId,
      lanes: ["memory"],
      ids: [`memory:${id}`],
      minSource: "third_party",
      surface: "tool",
      policy: { includePrivate: true },
    });
    if (!hits[0]?.item) return false;
    const hub = new MemoryItemsHubService({
      getWriter: () => MemoryWriter.get(),
      legacy: createLegacyMemoryMirror(),
      syncKitFiles: (workspaceId) => this.syncKitFiles(workspaceId),
    });
    await hub.delete({ workspaceId: this.workspace.id, id });
    return true;
  }

  /** Delete an archive row owned by this workspace (never another workspace's import). */
  private async forgetArchiveRow(id: string): Promise<boolean> {
    const [memory] = await MemoryService.getFullDetails([id]);
    if (!memory || memory.workspaceId !== this.workspace.id) return false;
    return (await MemoryService.deleteEntries(this.workspace.id, [id])) > 0;
  }

  // ---------------------------------------------------------------------------
  // context_recall
  // ---------------------------------------------------------------------------

  async contextRecall(
    input: ContextRecallToolInput,
    routing: { tool?: string } = {},
  ): Promise<Record<string, unknown>> {
    const tool = routing.tool ?? CONTEXT_RECALL_TOOL;
    const query = asString(input?.query, MAX_QUERY_CHARS);
    const id = asString(input?.id, 300);
    // Another task only when the user explicitly asked (deprecated context_grep contract).
    const taskId =
      input?.taskId && input?.explicitUserRequest === true ? String(input.taskId) : this.taskId;
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool,
      query,
      id,
      effectiveTaskId: taskId,
    });
    const fail = (error: string) => {
      this.daemon.logEvent(this.taskId, "tool_result", { tool, success: false, error });
      return { success: false, error };
    };
    if (!query && !id) return fail("Provide a query, or the id of a result to expand.");

    try {
      if (id) {
        const description = DurableContextService.isEnabled()
          ? await DurableContextService.describe({
              workspaceId: this.workspace.id,
              taskId,
              id,
              sourceLimit: input?.sourceLimit,
            })
          : await DurableContextService.describeConversationHit({
              workspaceId: this.workspace.id,
              taskId,
              id,
            });
        this.daemon.logEvent(this.taskId, "tool_result", {
          tool,
          success: true,
          found: Boolean(description),
        });
        if (!description) return { result: null };
        return {
          result: {
            id: description.id,
            kind: description.kind,
            taskId: description.taskId,
            timestamp: new Date(description.timestamp).toISOString(),
            text: description.text,
            ...(description.sourceMessages
              ? {
                  sourceMessages: description.sourceMessages.map((message) => ({
                    id: message.id,
                    role: message.role,
                    timestamp: new Date(message.timestamp).toISOString(),
                    text: message.text,
                  })),
                }
              : {}),
          },
        };
      }

      const limit = clampLimit(input?.limit, 10, 50);
      const results: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      if (DurableContextService.isEnabled()) {
        for (const hit of await DurableContextService.search({
          workspaceId: this.workspace.id,
          taskId,
          query,
          limit,
        })) {
          seen.add(hit.id);
          results.push({
            id: hit.id,
            kind: hit.kind,
            timestamp: new Date(hit.timestamp).toISOString(),
            snippet: hit.snippet,
          });
        }
      }
      if (results.length < limit) {
        // The conversation index covers every task, whatever the durable-context setting.
        for (const hit of await DurableContextService.searchConversation({
          workspaceId: this.workspace.id,
          taskId,
          query,
          limit,
          mode: "auto",
        })) {
          if (seen.has(hit.id) || results.length >= limit) continue;
          seen.add(hit.id);
          results.push({
            id: hit.id,
            kind: hit.kind === "summary" ? "summary" : "message",
            role: hit.role,
            timestamp: new Date(hit.timestamp).toISOString(),
            snippet: hit.snippet,
          });
        }
      }
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool,
        success: true,
        resultCount: results.length,
      });
      return { results, totalFound: results.length };
    } catch (error) {
      return fail(
        recallFailureMessage(tool, String(error instanceof Error ? error.message : error)),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Deprecated aliases
  // ---------------------------------------------------------------------------

  /**
   * Run a deprecated memory tool name through the tool that replaced it. Supermemory
   * writes and `memory_curate` keep their own implementation (`legacy`), since they reach
   * stores the new tools do not write.
   */
  async executeLegacyAlias(
    name: string,
    input: Record<string, Any>,
    legacy: {
      supermemoryRemember?: (input: Any) => Promise<unknown>;
      supermemoryForget?: (input: Any) => Promise<unknown>;
    } = {},
  ): Promise<unknown> {
    const notice = {
      deprecated: `${name} is deprecated; use ${LEGACY_MEMORY_TOOL_ALIASES[name] ?? MEMORY_RECALL_TOOL}.`,
    };
    const withNotice = (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>), ...notice }
        : value;
    const routing = { tool: name };
    const query = typeof input?.query === "string" ? input.query : "";
    switch (name) {
      case "search_memories": {
        const lane = input?.lane;
        const scopes: MemoryRecallScope[] =
          lane === "kit"
            ? ["knowledge"]
            : lane === "archive"
              ? ["memory"]
              : ["memory", "knowledge"];
        return withNotice(
          await this.recall({ query, limit: input?.limit, scopes, kinds: input?.types }, routing),
        );
      }
      case "memory_search_index":
        return withNotice(
          await this.recall({ query, limit: input?.limit, scopes: ["memory"] }, routing),
        );
      case "memory_timeline":
        return withNotice(
          typeof input?.memoryId === "string" && input.memoryId.trim()
            ? await this.recall({ ids: [input.memoryId], scopes: ["memory"] }, routing)
            : await this.recall({ query, scopes: ["memory"] }, routing),
        );
      case "memory_details":
        return withNotice(
          await this.recall({ ids: input?.ids, detail: "full", scopes: ["memory"] }, routing),
        );
      case "search_quotes":
      case "search_sessions":
        return withNotice(
          await this.recall(
            {
              query,
              limit: input?.limit,
              scopes:
                name === "search_sessions"
                  ? ["conversations"]
                  : ["conversations", "memory", "knowledge"],
            },
            {
              ...routing,
              ...(typeof input?.taskId === "string" && input.taskId.trim()
                ? { conversationTaskId: input.taskId.trim(), includeActiveTask: true }
                : {}),
            },
          ),
        );
      case "memory_topics_load":
        return withNotice(
          await this.recall({ query, limit: input?.limit, scopes: ["knowledge"] }, routing),
        );
      case "memory_curated_read":
        return withNotice(
          await this.recall(
            {
              limit: input?.limit ?? 20,
              scopes: ["memory"],
              kinds:
                typeof input?.kind === "string" ? CURATED_TO_ITEM_KINDS[input.kind] : undefined,
            },
            routing,
          ),
        );
      case "supermemory_profile":
      case "supermemory_search":
        return withNotice(
          await this.recall({ query, limit: input?.limit, scopes: ["external"] }, routing),
        );
      case "memory_save": {
        const type = String(input?.type || "");
        const kind: MemoryRememberKind =
          type === "decision" || type === "insight" || type === "error"
            ? (type as MemoryRememberKind)
            : "note";
        return withNotice(await this.remember({ content: input?.content, kind }, routing));
      }
      case "memory_curate":
        if (this.workspace.permissions?.write === false) {
          return withNotice({
            success: false,
            error: "memory_curate writes .cowork kit files, and this workspace is read-only.",
          });
        }
        return withNotice(await this.curate(input as Parameters<MemoryTools["curate"]>[0]));
      case "supermemory_remember":
        if (!legacy.supermemoryRemember) {
          return withNotice({ success: false, error: "Supermemory is not connected." });
        }
        return withNotice(await legacy.supermemoryRemember(input));
      case "supermemory_forget":
        if (typeof input?.memoryId === "string" && input.memoryId.trim()) {
          return withNotice(
            await this.forget(
              { id: `external:${input.memoryId.trim()}`, reason: input?.reason },
              routing,
            ),
          );
        }
        if (!legacy.supermemoryForget) {
          return withNotice({ success: false, error: "Supermemory is not connected." });
        }
        return withNotice(await legacy.supermemoryForget(input));
      case "context_grep":
        return withNotice(
          await this.contextRecall(
            {
              query,
              limit: input?.limit,
              taskId: input?.taskId,
              explicitUserRequest: input?.explicitUserRequest,
            },
            routing,
          ),
        );
      case "context_describe":
        return withNotice(
          await this.contextRecall(
            {
              id: input?.id,
              taskId: input?.taskId,
              explicitUserRequest: input?.explicitUserRequest,
              sourceLimit: input?.sourceLimit,
            },
            routing,
          ),
        );
      default:
        throw new Error(`Unknown memory tool: ${name}`);
    }
  }

  /**
   * Curated hot-memory edit (deprecated `memory_curate`): the curated table is still a
   * system of record for prompts, and every change is mirrored into `memory_items`.
   */
  async curate(input: {
    action: "add" | "replace" | "remove";
    target: "user" | "workspace";
    id?: string;
    kind?: CuratedMemoryKind;
    content?: string;
    match?: string;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "memory_curate",
      action: input?.action,
      target: input?.target,
      kind: input?.kind,
    });
    // `<no-memory>` blocks adding or rewriting curated memory; removal stays allowed.
    if (
      input?.action !== "remove" &&
      explicitMemoryWriteBlocked(this.daemon, this.taskId, input?.content)
    ) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_curate",
        success: false,
        blocked: true,
        reason: "no_memory_directive",
      });
      return { success: false, error: NO_MEMORY_WRITE_ERROR };
    }
    try {
      const result = await CuratedMemoryService.curate({
        workspaceId: this.workspace.id,
        taskId: this.taskId,
        origin: "agent_tool",
        ...input,
        filesystemReadGuard: (candidatePath) => this.canReadWorkspacePath(candidatePath),
        filesystemWriteGuard: (candidatePath) => this.canWriteWorkspacePath(candidatePath),
      });
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_curate",
        success: result.success,
        entryId: result.entry?.id,
        staged: result.staged,
        error: result.error,
      });
      return {
        success: result.success,
        ...(result.entry?.id ? { entryId: result.entry.id } : {}),
        ...(result.updatedFile ? { updatedFile: result.updatedFile } : {}),
        ...(result.staged
          ? { staged: true, message: "Memory write is pending user approval." }
          : {}),
        ...(result.pendingId ? { pendingId: result.pendingId } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_curate",
        success: false,
        error: String(error),
      });
      return { success: false, error: String(error) };
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** The user's latest message (or the task prompt), for `<no-memory>` and `user_asked`. */
  private latestUserText(): string {
    try {
      const events = this.daemon.getTaskEvents?.(this.taskId, {
        types: ["user_message"],
        limit: 3,
      });
      const latest = [...(events ?? [])].sort(
        (a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0),
      )[0];
      const message = (latest?.payload as { message?: unknown } | undefined)?.message;
      if (typeof message === "string" && message.trim()) return message.slice(0, 8000);
    } catch {
      // Fall back to the task prompt.
    }
    try {
      const task = this.daemon.getTask?.(this.taskId);
      return String(task?.rawPrompt || task?.prompt || "").slice(0, 8000);
    } catch {
      return "";
    }
  }

  /** Re-render `.cowork/USER.md` / `MEMORY.md` after a change (best effort, guarded). */
  private async syncKitFiles(workspaceId: string): Promise<void> {
    if (workspaceId !== this.workspace.id || this.workspace.permissions?.write === false) return;
    try {
      await CuratedMemoryService.syncWorkspaceFiles(workspaceId, {
        readGuard: (candidatePath) => this.canReadWorkspacePath(candidatePath),
        writeGuard: (candidatePath) => this.canWriteWorkspacePath(candidatePath),
      });
    } catch {
      // The database change is committed; the files catch up on the next sync.
    }
  }

  private canReadWorkspacePath(candidatePath: string): boolean {
    try {
      return (
        evaluateWorkspaceFilesystemAccess(this.workspace, candidatePath, "read").decision ===
        "allow"
      );
    } catch {
      return false;
    }
  }

  private canWriteWorkspacePath(candidatePath: string): boolean {
    try {
      return (
        evaluateWorkspaceFilesystemAccess(this.workspace, path.resolve(candidatePath), "write")
          .decision === "allow"
      );
    } catch {
      return false;
    }
  }

  /** Supermemory may be queried: the workspace allows network access at all. */
  private externalAllowed(): boolean {
    const permissions = this.workspace.permissions;
    return permissions?.network === true && permissions.accessNetworkMode !== "disabled";
  }

  /** Background mirroring of a save to Supermemory needs automatic network access. */
  private externalMirrorAllowed(): boolean {
    const permissions = this.workspace.permissions;
    return (
      permissions?.network === true &&
      permissions.accessNetworkMode !== "disabled" &&
      permissions.accessNetworkMode !== "on-request"
    );
  }
}
