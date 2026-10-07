/**
 * The agent's memory tools (audit §8.3, docs/memory-engine.md):
 *
 *  - `memory_recall`   one recall over facts, the archive, earlier conversations, notes,
 *                      the knowledge graph and (when allowed) Supermemory (MemoryRecall);
 *  - `memory_remember` durable facts through MemoryWriter (`memory_items`); episodic
 *                      kinds (`outcome`, `error`, `note`) go to the archive; scope
 *                      `external` saves to Supermemory only;
 *  - `memory_forget`   a real delete of a memory item, an archive row of this workspace
 *                      or (scope `external` / `external:` ids) a Supermemory memory;
 *  - `context_recall`  the active task's earlier conversation after compaction.
 *
 * The 16 tools these replaced were hidden aliases for one release and have been retired
 * (RETIRED_MEMORY_TOOL_NAMES); they are no longer registered.
 */
import { PersonalityManager } from "../../settings/personality-manager";
import { sanitizeStoredPreferredName } from "../../utils/preferred-name";
import { normalizeSubjectKey } from "../../memory/memory-items-types";
import { rememberPreferredNameInFolder } from "../../memory/repo/memory-repo-producers";
import { MemoryRepoService, taskSourceLink } from "../../memory/repo/MemoryRepoService";
import { memoryRepoRef, parseMemoryRepoRef } from "../../memory/repo/memory-repo-format";
import { isUntrustedExternalSource } from "../security/export-permission-context";
import { isMemoryRepoReadAllowed } from "../../security/memory-repo-access";
import { randomUUID } from "crypto";
import type { LLMTool } from "../llm/types";
import type { Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import { MemoryService } from "../../memory/MemoryService";
import { MemoryWriteGate } from "../../memory/MemoryWriteGate";
import { MemoryWriter, type MemoryWriteResult } from "../../memory/MemoryWriter";
import { MemoryItemsHubService } from "../../memory/MemoryItemsHubService";
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
  type MemoryItem,
  type MemoryItemKind,
  type MemoryItemScope,
  type MemoryItemSource,
} from "../../memory/memory-items-types";
import { isThirdPartyGatewayTask } from "../../gateway/gateway-sender-identity";
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

export const FORGET_DENIED_ERROR =
  "The user did not approve forgetting this memory. It was kept; do not retry.";

export const TEAM_MEMORY_READ_ONLY_ERROR =
  "Team memory is read-only; edit it in the team's repository.";

/** What memory_forget is about to delete, for the approval prompt. */
interface ForgetTarget {
  ref: string;
  content: string;
  source?: string;
  /** Created by this task's agent, so it may be forgotten without asking. */
  selfCreated: boolean;
}

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
  /** `external`: forget the Supermemory memory whose text is `match`. */
  scope?: string;
  reason?: string;
}

export interface ContextRecallToolInput {
  query?: string;
  id?: string;
  limit?: number;
}

const SUPERMEMORY_UNAVAILABLE = "Supermemory is not connected or network access is off.";

/**
 * Why the workspace's memory settings refuse an external (Supermemory) write, or null when
 * they allow it. Unreadable settings refuse (fail closed).
 */
async function externalMemoryWriteRefusal(workspaceId: string): Promise<string | null> {
  try {
    const settings = await MemoryService.getSettings(workspaceId);
    if (!settings.enabled || settings.privacyMode === "disabled") {
      return "Memory is turned off for this workspace; nothing was saved externally.";
    }
    if (settings.privacyMode === "strict") {
      return "This workspace keeps memories private (strict privacy); external memory is not written.";
    }
    return null;
  } catch {
    return "Workspace memory settings could not be read; nothing was saved externally.";
  }
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
          "Save a durable memory for later tasks. " +
          "Use it when the user asks you to remember something, and on your own as you work when you learn what a later task would need and the user would otherwise repeat: a preference, correction, decision, project fact or hard-won lesson (command, setup step, pitfall). " +
          "One self-contained fact per call; when a saved fact changes, save the new value under the same subject. " +
          "Skip what is cheap to rediscover or only matters now (use scratchpad_write). Never secrets.",
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
              enum: ["workspace", "global", "task", "external"],
              description:
                "global: about the user, everywhere (default: identity, preference, correction); workspace: this project (default); task: this task; external: Supermemory only.",
            },
            subject: {
              type: "string",
              description:
                "Key of a single-valued fact (e.g. preferred_name, timezone): a new value replaces the old.",
            },
            pin: { type: "boolean", description: "Keep it in every prompt; only when the user asks." },
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
            scope: {
              type: "string",
              enum: ["external"],
              description: "external: forget the Supermemory memory with this match text.",
            },
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

  async recall(input: MemoryRecallToolInput): Promise<Record<string, unknown>> {
    const tool = MEMORY_RECALL_TOOL;
    if (!this.ownerMemoryToolsAllowed()) {
      return this.recallError(tool, "Personal memory recall requires an owner conversation.");
    }
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
          excludeActiveTaskConversation: true,
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

  async remember(input: MemoryRememberToolInput): Promise<Record<string, unknown>> {
    const tool = MEMORY_REMEMBER_TOOL;
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
    if (input?.scope === "external") return this.rememberExternal(content, kind);

    const archiveType = ARCHIVE_KINDS[kind];
    if (archiveType) return this.saveToArchive(tool, content, archiveType);

    const itemKind = kind as MemoryItemKind;
    const writer = MemoryWriter.get();
    if (!writer) {
      // The fact store runs in the desktop app; elsewhere keep the memory in the archive.
      return this.saveToArchive(tool, content, ARCHIVE_FALLBACK_TYPES[itemKind]);
    }

    // SEC-16: in a task started over a channel by someone other than the workspace owner,
    // "remember" is about that person: a private contact-scope third-party item, never a
    // fact about the user (MemoryWriter keeps third-party text out of user scopes).
    const thirdPartySender = this.thirdPartyGatewaySender();
    const scope: MemoryItemScope = thirdPartySender
      ? "contact"
      : input?.scope === "global" || input?.scope === "workspace" || input?.scope === "task"
        ? input.scope
        : GLOBAL_BY_DEFAULT.has(itemKind)
          ? "global"
          : "workspace";
    const userText = this.latestUserText();
    const source: MemoryItemSource = thirdPartySender
      ? "third_party"
      : input?.user_asked === true && isExplicitRememberRequest(userText)
        ? "user_stated"
        : "inferred";
    // Pinning puts a fact in every prompt: the user's call. An inference the agent makes on
    // its own (perhaps steered by a page it read) is recalled when relevant instead.
    const pinRequested = input?.pin === true;
    const pin = pinRequested && source === "user_stated";
    const subjectKey = asString(input?.subject, 120);
    const recordId = randomUUID();

    try {
      // An approval-gated write is staged as the memory_items candidate itself and replayed
      // through MemoryWriter after approval (MemoryWriteGate `remember`), kind and scope intact.
      const gate = await MemoryWriteGate.evaluate({
        workspaceId: this.workspace.id,
        taskId: this.taskId,
        target: "curated",
        action: "remember",
        origin: "agent_tool",
        summary: `Remember ${itemKind}`,
        payload: {
          action: "remember",
          kind: itemKind,
          scope,
          scopeRef: thirdPartySender ?? (scope === "task" ? this.taskId : null),
          ...(subjectKey ? { subjectKey } : {}),
          source,
          confidence: source === "user_stated" ? 1 : 0.7,
          pinned: pin,
          recordId,
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

      // The memory repo (docs/memory-repo-phase1-design.md), when it runs, holds the user's
      // and workspace facts; contact, task and private facts stay in memory_items.
      // Commitments stay in memory_items: they carry due dates the briefing and reminders use.
      if (!thirdPartySender && (scope === "global" || scope === "workspace") && itemKind !== "commitment") {
        const repoResult = await this.rememberInRepo({
          content,
          kind: itemKind,
          scope,
          source,
          pin,
          pinRequested,
          subjectKey,
          userText,
        });
        if (repoResult) return repoResult;
      }

      const result = await writer.ingest({
        content,
        kind: itemKind,
        scope,
        workspaceId: scope === "global" ? null : this.workspace.id,
        scopeRef: thirdPartySender ?? (scope === "task" ? this.taskId : null),
        ...(subjectKey ? { subjectKey } : {}),
        source,
        sourceRef: { store: "agent_tool", id: recordId, taskId: this.taskId },
        confidence: source === "user_stated" ? 1 : 0.7,
        pinned: pin,
        taskId: this.taskId,
        originWorkspaceId: this.workspace.id,
        originText: userText,
      });
      if (result.status === "skipped") {
        return fail(skipMessage(result), { reason: result.reason });
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
        ...(pinRequested && !pin
          ? { note: "Not pinned: pin only when the user asks to keep it in every prompt." }
          : {}),
        ...(result.supersededIds.length > 0
          ? { replaced: result.supersededIds.map((id) => `memory:${id}`) }
          : {}),
        ...(result.redactions > 0 ? { redactions: result.redactions } : {}),
      };
    } catch (error) {
      return fail(String(error instanceof Error ? error.message : error));
    }
  }

  /**
   * Write a fact into the memory repo. Null when the repo is not running or the fact must
   * stay in memory_items (strict privacy, repo unavailable); a result otherwise.
   */
  private async rememberInRepo(input: {
    content: string;
    kind: MemoryItemKind;
    scope: "global" | "workspace";
    source: MemoryItemSource;
    pin: boolean;
    pinRequested: boolean;
    subjectKey: string;
    userText: string;
  }): Promise<Record<string, unknown> | null> {
    const repo = MemoryRepoService.get();
    // Only tasks whose memoryRepo layer is on (the access scope the executor sets).
    if (!repo?.isWritable() || !isMemoryRepoReadAllowed()) return null;
    const tool = MEMORY_REMEMBER_TOOL;
    const by = input.source === "user_stated" ? "user" : "agent";
    // The preferred name lives in PersonalityManager (Phase 3); a stated name updates it and
    // mirrors into me.md, like set_user_name.
    if (by === "user" && normalizeSubjectKey(input.subjectKey) === "preferred_name") {
      const name = sanitizeStoredPreferredName(
        input.content.replace(/^\s*(?:preferred name|my name is|call me)\s*:?\s*/i, ""),
      );
      if (name) {
        PersonalityManager.setUserName(name);
        const named = await rememberPreferredNameInFolder(name, { taskId: this.taskId });
        if (named?.status === "written") {
          this.daemon.logEvent(this.taskId, "tool_result", { tool, success: true, memoryId: named.ref });
          return { success: true, id: named.ref, action: named.action, kind: input.kind, scope: "global", source: input.source, file: named.path };
        }
      }
    }
    const tainted =
      by === "agent" &&
      (this.daemon.listRecentSensitiveSources?.(this.taskId) ?? []).some((item) =>
        isUntrustedExternalSource(item),
      );
    const result = await repo.remember({
      text: input.content,
      kind: input.kind,
      scope: input.scope,
      workspaceId: this.workspace.id,
      workspaceName: this.workspace.name,
      by,
      pinned: input.pin,
      subject: input.subjectKey || null,
      taskId: this.taskId,
      tainted,
      originText: input.userText,
      origin: "agent_tool",
    });
    if (result.status === "skipped") {
      if (result.reason === "private" || result.reason === "unavailable") return null;
      const error =
        result.reason === "busy"
          ? "The memory repo is busy; try again in a moment."
          : result.reason === "outranked"
            ? `Not saved: it would replace what the user stated. ${result.detail ?? ""}`.trim()
            : result.reason === "too_large"
              ? `Not saved: ${result.detail ?? "the memory file is full"}`
              : `Not saved (${result.reason}).`;
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool,
        success: false,
        error,
        reason: result.reason,
      });
      return { success: false, error, reason: result.reason };
    }
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool,
      success: true,
      memoryId: result.ref,
      action: result.action,
      source: input.source,
    });
    return {
      success: true,
      id: result.ref,
      action: result.action,
      kind: input.kind,
      scope: input.scope,
      source: input.source,
      file: result.path,
      ...(result.path === "inbox.md"
        ? {
            note: "Saved to the unreviewed inbox: this task read untrusted content, so the memory is not used in prompts until the user reviews it.",
          }
        : {}),
      ...(input.pin && result.path === "MEMORY.md" ? { pinned: true } : {}),
      ...(input.pinRequested && !input.pin
        ? { note: "Not pinned: pin only when the user asks to keep it in every prompt." }
        : {}),
      ...(result.replaced ? { replaced: result.replaced } : {}),
      ...(result.redactions > 0 ? { redactions: result.redactions } : {}),
    };
  }

  /**
   * `memory_remember` with scope `external`: a memory that lives only in Supermemory (the
   * retired `supermemory_remember`). The write goes through the memory write gate
   * (target `external`), and its remote id is recorded so purges reach it.
   */
  private async rememberExternal(
    content: string,
    kind: MemoryRememberKind,
  ): Promise<Record<string, unknown>> {
    const tool = MEMORY_REMEMBER_TOOL;
    const fail = (error: string, extra: Record<string, unknown> = {}) => {
      this.daemon.logEvent(this.taskId, "tool_result", { tool, success: false, error, ...extra });
      return { success: false, error, ...extra };
    };
    // SEC-16: a channel sender other than the workspace owner never writes to the owner's
    // external memory.
    if (this.thirdPartyGatewaySender()) {
      return fail(
        "This task came from someone other than the workspace owner; external memory is not changed for them.",
      );
    }
    if (!this.externalAllowed() || !SupermemoryService.isConfigured()) {
      return fail(SUPERMEMORY_UNAVAILABLE);
    }
    // Workspace memory settings: nothing leaves the device when memory is off, or when
    // privacy mode is `disabled` or `strict` (strict makes every memory private).
    const policyError = await externalMemoryWriteRefusal(this.workspace.id);
    if (policyError) return fail(policyError, { reason: "memory_policy" });
    try {
      const result = await SupermemoryService.remember({
        workspace: { id: this.workspace.id, name: this.workspace.name },
        content,
        metadata: {
          source: "cowork_tool",
          kind,
          taskId: this.taskId,
          workspaceId: this.workspace.id,
        },
        taskId: this.taskId,
        origin: "agent_tool",
      });
      if (result.blocked) {
        return fail(result.error || "The external memory write was blocked.", { blocked: true });
      }
      if (result.staged) {
        this.daemon.logEvent(this.taskId, "tool_result", {
          tool,
          success: true,
          staged: true,
          pendingId: result.pendingId,
        });
        return {
          success: true,
          staged: true,
          pendingId: result.pendingId,
          message: "External memory write is pending user approval.",
        };
      }
      const ids = result.memoryIds.map((id) => `external:${id}`);
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool,
        success: true,
        stored: "external",
        memoryIds: result.memoryIds,
      });
      return {
        success: true,
        ...(ids[0] ? { id: ids[0] } : {}),
        ...(ids.length > 1 ? { ids } : {}),
        stored: "external",
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

  async forget(input: MemoryForgetToolInput): Promise<Record<string, unknown>> {
    const tool = MEMORY_FORGET_TOOL;
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
    if (!this.ownerMemoryToolsAllowed()) {
      return fail("Forgetting personal memory requires an owner conversation.");
    }
    const done = (ref: string) => {
      this.daemon.logEvent(this.taskId, "tool_result", { tool, success: true, forgotten: ref });
      return { success: true, forgotten: ref };
    };
    if (!id && !match)
      return fail("Provide the id of the memory (from memory_recall) or match text.");

    try {
      const repoRef = parseMemoryRepoRef(id);
      if (repoRef) return await this.forgetRepoEntry(repoRef.path, repoRef.line, input?.reason, fail, done);
      if (id) {
        if (/^team:/i.test(id)) return fail(TEAM_MEMORY_READ_ONLY_ERROR);
        const parsed = parseRecallRef(id);
        if (!parsed) return fail(`Unknown memory id "${id}".`);
        switch (parsed.kind) {
          case "item":
          case "uuid": {
            const item = await this.findForgettableItem(parsed.id);
            if (item) {
              if (!(await this.confirmForget(this.forgetTargetOfItem(item), input?.reason))) {
                return fail(FORGET_DENIED_ERROR, { denied: true });
              }
              await this.deleteItem(item.id);
              return done(`memory:${parsed.id}`);
            }
            if (parsed.kind === "uuid") {
              const row = await this.findForgettableArchiveRow(parsed.id);
              if (row) {
                if (!(await this.confirmForget(row, input?.reason))) {
                  return fail(FORGET_DENIED_ERROR, { denied: true });
                }
                if (await this.deleteArchiveRow(parsed.id)) return done(`archive:${parsed.id}`);
              }
            }
            return fail(`No memory "${id}" in this workspace.`);
          }
          case "archive": {
            const row = await this.findForgettableArchiveRow(parsed.id);
            if (!row) return fail(`No memory "${id}" in this workspace.`);
            if (!(await this.confirmForget(row, input?.reason))) {
              return fail(FORGET_DENIED_ERROR, { denied: true });
            }
            return (await this.deleteArchiveRow(parsed.id))
              ? done(`archive:${parsed.id}`)
              : fail(`No memory "${id}" in this workspace.`);
          }
          case "external": {
            if (!this.externalAllowed() || !SupermemoryService.isConfigured()) {
              return fail(SUPERMEMORY_UNAVAILABLE);
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

      if (input?.scope === "external") {
        // Supermemory matches the text itself (the retired text-matched supermemory_forget).
        if (!this.externalAllowed() || !SupermemoryService.isConfigured()) {
          return fail(SUPERMEMORY_UNAVAILABLE);
        }
        const result = await SupermemoryService.forget({
          workspace: { id: this.workspace.id, name: this.workspace.name },
          content: match,
          ...(input?.reason ? { reason: asString(input.reason, 300) } : {}),
        });
        return result.forgotten
          ? done(result.id ? `external:${result.id}` : "external")
          : fail("Supermemory found no memory with that text.");
      }

      const candidates = await this.forgetCandidates(match);
      if (candidates.length === 0) return fail(`No saved memory matches "${match}".`);
      if (candidates.length > 1) {
        return fail("More than one memory matches; pass the id of the one to forget.", {
          candidates: candidates.slice(0, 5).map((hit) => ({ id: hit.ref, snippet: hit.snippet })),
        });
      }
      const repoTarget = parseMemoryRepoRef(candidates[0].ref);
      if (repoTarget) {
        return await this.forgetRepoEntry(repoTarget.path, repoTarget.line, input?.reason, fail, done);
      }
      const target = parseRecallRef(candidates[0].ref);
      if (target?.lane === "memory") {
        const item = await this.findForgettableItem(target.id);
        if (item) {
          if (!(await this.confirmForget(this.forgetTargetOfItem(item), input?.reason))) {
            return fail(FORGET_DENIED_ERROR, { denied: true });
          }
          await this.deleteItem(item.id);
          return done(candidates[0].ref);
        }
      }
      if (target?.lane === "archive") {
        const row = await this.findForgettableArchiveRow(target.id);
        if (row) {
          if (!(await this.confirmForget(row, input?.reason))) {
            return fail(FORGET_DENIED_ERROR, { denied: true });
          }
          if (await this.deleteArchiveRow(target.id)) return done(candidates[0].ref);
        }
      }
      return fail(`Could not forget "${candidates[0].ref}".`);
    } catch (error) {
      return fail(String(error instanceof Error ? error.message : error));
    }
  }

  /**
   * Remove a line of the memory repo. A line this task's agent wrote is removed without
   * asking; anything else takes the `memory_delete` approval.
   */
  private async forgetRepoEntry(
    relPath: string,
    line: number,
    reason: unknown,
    fail: (error: string, extra?: Record<string, unknown>) => Record<string, unknown>,
    done: (ref: string) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const repo = MemoryRepoService.get();
    if (!repo?.isWritable()) return fail("The memory repo is not available.");
    const entry = await repo.entryAt(relPath, line);
    const ref = memoryRepoRef(relPath, line);
    if (!entry) return fail(`No saved memory at "${ref}". Recall it again to get its current id.`);
    const target: ForgetTarget = {
      ref,
      content: entry.text,
      source: entry.by === "user" ? "user" : "agent",
      selfCreated: entry.by === "agent" && entry.metadata.source === taskSourceLink(this.taskId),
    };
    if (!(await this.confirmForget(target, reason))) return fail(FORGET_DENIED_ERROR, { denied: true });
    const removed = await repo.forget(relPath, line, { expectHash: entry.hash, taskId: this.taskId });
    return removed.removed ? done(ref) : fail(removed.error ?? `Could not forget "${ref}".`);
  }

  /** Memory items, memory repo entries and own archive rows containing every term of `match`. */
  private async forgetCandidates(match: string): Promise<MemoryRecallHit[]> {
    const result = await MemoryRecallService.getDefault().recall({
      text: match,
      workspaceId: this.workspace.id,
      taskId: this.taskId,
      lanes: ["memory", "repo", "archive"],
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
      // Team memory repos are read-only (docs/memory-repo-phase4-design.md §2).
      if (hit.ref.startsWith("team:")) continue;
      visible.push(hit);
    }
    return visible;
  }

  /** A memory item this workspace may see (same visibility as recall; private included). */
  private async findForgettableItem(id: string): Promise<MemoryItem | null> {
    if (!MemoryWriter.get()) return null;
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
    return hits[0]?.item ?? null;
  }

  private forgetTargetOfItem(item: MemoryItem): ForgetTarget {
    const aliases = Array.isArray(item.sourceRef?.aliases) ? item.sourceRef.aliases : [];
    return {
      ref: `memory:${item.id}`,
      content: item.content,
      source: item.source,
      selfCreated:
        item.source === "inferred" &&
        item.taskId === this.taskId &&
        item.sourceRef?.store === "agent_tool" &&
        aliases.length === 0,
    };
  }

  /** Delete a memory item, as the Memory Hub does. */
  private async deleteItem(id: string): Promise<void> {
    const hub = new MemoryItemsHubService({ getWriter: () => MemoryWriter.get() });
    await hub.delete({ workspaceId: this.workspace.id, id });
  }

  /** An archive row owned by this workspace (never another workspace's import). */
  private async findForgettableArchiveRow(id: string): Promise<ForgetTarget | null> {
    const [memory] = await MemoryService.getFullDetails([id]);
    if (!memory || memory.workspaceId !== this.workspace.id) return null;
    return { ref: `archive:${id}`, content: String(memory.content ?? ""), selfCreated: false };
  }

  private async deleteArchiveRow(id: string): Promise<boolean> {
    return (await MemoryService.deleteEntries(this.workspace.id, [id])) > 0;
  }

  /**
   * Ask the user before a memory is deleted. Deletes are destructive and a prompt-injected
   * agent could otherwise erase what the user told CoWork, so this goes through the
   * permission engine as a delete (`memory_delete`): it prompts in the default and
   * dangerous-only modes and is allowed only by bypass modes or a rule the user saved.
   * A fact this task's agent inferred itself (`memory_remember` without the user asking,
   * not merged with any other record) is forgotten without a prompt.
   */
  private async confirmForget(target: ForgetTarget, reason?: unknown): Promise<boolean> {
    if (target.selfCreated) return true;
    if (typeof this.daemon.requestApproval !== "function") return false;
    const preview = target.content.replace(/\s+/g, " ").trim().slice(0, 160);
    try {
      return (
        (await this.daemon.requestApproval(
          this.taskId,
          "memory_delete",
          `Forget a saved memory: "${preview}"`,
          {
            tool: MEMORY_FORGET_TOOL,
            memory: target.ref,
            content: preview,
            ...(target.source ? { source: target.source } : {}),
            ...(typeof reason === "string" && reason.trim()
              ? { reason: reason.trim().slice(0, 300) }
              : {}),
          },
        )) === true
      );
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // context_recall
  // ---------------------------------------------------------------------------

  async contextRecall(input: ContextRecallToolInput): Promise<Record<string, unknown>> {
    const tool = CONTEXT_RECALL_TOOL;
    const query = asString(input?.query, MAX_QUERY_CHARS);
    const id = asString(input?.id, 300);
    // Always the active task: other tasks are recalled through memory_recall.
    const taskId = this.taskId;
    this.daemon.logEvent(this.taskId, "tool_call", { tool, query, id });
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

  /**
   * The contact reference of the channel sender when this task came from someone other
   * than the workspace owner (SEC-16), else null.
   */
  private thirdPartyGatewaySender(): string | null {
    let task: ReturnType<AgentDaemon["getTask"]> | undefined;
    try {
      task = this.daemon.getTask?.(this.taskId);
    } catch {
      task = undefined;
    }
    if (!isThirdPartyGatewayTask(task)) return null;
    const ref = task?.agentConfig?.gatewaySenderRef;
    return typeof ref === "string" && ref.trim() ? ref.trim().slice(0, 200) : "unattributed";
  }

  /** These tools span owner archives, files and external stores; shared grants do not apply. */
  private ownerMemoryToolsAllowed(): boolean {
    try {
      const task = this.daemon.getTask?.(this.taskId);
      if (!task || isThirdPartyGatewayTask(task)) return false;
      const gateway = task.agentConfig?.gatewayContext;
      return !gateway || gateway === "private";
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
