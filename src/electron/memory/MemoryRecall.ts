/**
 * MemoryRecall — one recall query over every memory lane (docs/memory-engine.md §4, audit
 * §8.2 "MemoryRecall", RECALL-2/4/8).
 *
 * Lanes:
 *  - `memory`        memory_items (facts, preferences, rules, decisions …), FTS + trust;
 *  - `repo`          the memory repo's markdown entries (docs/memory-repo-phase1-design.md
 *                    §6.3), searched in process; `inbox.md` hits are tagged unreviewed;
 *  - `archive`       the episodic `memories` archive (task outcomes, errors, saved notes,
 *                    imports), the existing hybrid search with the Phase 0 visibility filter;
 *  - `conversations` the unified conversation index of earlier tasks;
 *  - `knowledge`     knowledge-graph entities and the `.cowork/` markdown index;
 *  - `external`      Supermemory, only when the caller's policy allows it.
 *
 * Every lane returns its own ranked list; lists are fused with weighted reciprocal-rank
 * fusion (scores of different lanes are never compared directly), duplicates across
 * lanes are merged by normalized text, and the fused score is normalized to [0, 1].
 *
 * Privacy and scope are decided once per lane, in the lane's own query: memory items only
 * from this workspace, global scope, the active task and (when given) the handled contact,
 * never `private` items unless the policy asks; archive rows only when agent-visible
 * (never suppressed or redacted) and from this workspace or a non-private import;
 * conversations, entities and files of this workspace only.
 *
 * `query` has no side effects. A use is counted with `markUsed`, which callers invoke for
 * hits they actually return in full or inject, never for a listing.
 */
import { isMemoryRepoReadAllowed } from "../security/memory-repo-access";
import * as fs from "fs/promises";
import * as path from "path";
import { createLogger } from "../utils/logger";
import { extractFtsTerms, foldForMatch, isFtsStopword, termCoverage } from "../database/fts-query";
import type { Memory, MemorySearchResult } from "../database/repositories";
import type {
  MemoryRecall,
  MemoryRecallHit,
  MemoryRecallLane,
  MemoryRecallPolicy,
  MemoryRecallQuery,
} from "./memory-engine-contracts";
import type { MemoryItemRecallRequest, MemoryItemRecallRow } from "./memory-recall-sql";
import { redactSensitiveMarkdownContent } from "./markdown-index-sql";
import { MemoryRepoService } from "./repo/MemoryRepoService";
import {
  MEMORY_REPO_INBOX_FILE,
  memoryRepoRef,
  parseMemoryRepoEntries,
  parseMemoryRepoRef,
  splitLines,
  type MemoryRepoEntry,
} from "./repo/memory-repo-format";
import { MEMORY_ITEM_TRUST, type MemoryItem, type MemoryItemSource } from "./memory-items-types";
import { hasReservedImportPrefix } from "./memory-visibility";
import { MemoryService } from "./MemoryService";
import { MemoryObservationService } from "./MemoryObservationService";
import { DurableContextService } from "./DurableContextService";
import { SupermemoryService } from "./SupermemoryService";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";

const logger = createLogger("MemoryRecall");

/** Tool-level scopes; `memory` covers both fact lanes (items and archive). */
export const MEMORY_RECALL_SCOPES = ["memory", "conversations", "knowledge", "external"] as const;
export type MemoryRecallScope = (typeof MEMORY_RECALL_SCOPES)[number];
export const DEFAULT_MEMORY_RECALL_SCOPES: readonly MemoryRecallScope[] = [
  "memory",
  "conversations",
  "knowledge",
];

export const MEMORY_RECALL_DEFAULT_LIMIT = 10;
export const MEMORY_RECALL_MAX_LIMIT = 30;
/** Characters of one hit's content in a `full` result. */
export const MEMORY_RECALL_FULL_CHARS = 4000;
const SNIPPET_CHARS = 240;
const TITLE_CHARS = 90;
/** Reciprocal-rank-fusion constant (Cormack et al.). */
const RRF_K = 60;

/**
 * Lane weights for fusion: the curated fact store first, then episodic memory, then
 * conversations and documents. Imported archive rows (other workspaces) count half, so
 * they never tie this workspace's own results (RECALL-8).
 */
export const MEMORY_RECALL_LANE_WEIGHTS: Readonly<Record<MemoryRecallLane, number>> = {
  memory: 1,
  repo: 1,
  archive: 0.8,
  conversations: 0.7,
  knowledge: 0.6,
  external: 0.5,
};
const IMPORTED_ARCHIVE_FACTOR = 0.5;
/** Lines of a memory repo file returned around an entry by `detail: "full"`. */
export const MEMORY_REPO_FULL_LINES = 80;
const UNREVIEWED_PREFIX = "[unreviewed] ";

/** Lowest trust admitted by default: everything but `third_party`. */
const DEFAULT_MIN_TRUST = MEMORY_ITEM_TRUST.inferred;

/**
 * The distinctive terms of a recall query (stopwords dropped), used to damp candidates that
 * matched only one weak term. Fewer than two such terms: no damping.
 */
function queryFocusTerms(text: string | undefined): string[] {
  const terms = extractFtsTerms(String(text || ""), { maxTerms: 12 }).filter(
    (term) => !isFtsStopword(term),
  );
  return terms.length >= 2 ? terms : [];
}

/**
 * Weight of a candidate by how many of the query's distinctive terms its text contains:
 * every lane ranks by its own score, and rank fusion alone lets a one-term match in a
 * strong lane outrank a full match in a weaker lane.
 */
function coverageFactor(content: string, focusTerms: string[]): number {
  if (focusTerms.length === 0) return 1;
  return COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * termCoverage(content, focusTerms);
}
const COVERAGE_FLOOR = 0.4;

export function lanesForScopes(scopes: Iterable<string> | undefined): MemoryRecallLane[] {
  const requested = new Set(
    [...(scopes ?? DEFAULT_MEMORY_RECALL_SCOPES)].filter((scope): scope is MemoryRecallScope =>
      (MEMORY_RECALL_SCOPES as readonly string[]).includes(scope),
    ),
  );
  if (requested.size === 0) {
    for (const scope of DEFAULT_MEMORY_RECALL_SCOPES) requested.add(scope);
  }
  const lanes: MemoryRecallLane[] = [];
  if (requested.has("memory")) lanes.push("memory", "repo", "archive");
  if (requested.has("conversations")) lanes.push("conversations");
  if (requested.has("knowledge")) lanes.push("knowledge");
  if (requested.has("external")) lanes.push("external");
  return lanes;
}

export interface KnowledgeEntityHit {
  id: string;
  name: string;
  type?: string;
  description?: string;
  observations?: string[];
  confidence?: number;
  createdAt: number;
  score: number;
}

export interface ConversationRecallHit {
  id: string;
  taskId: string;
  role: string;
  type: string;
  snippet: string;
  timestamp: number;
  score: number;
}

export interface ExternalRecallHit {
  id?: string;
  text: string;
  similarity?: number;
  updatedAt?: string;
}

/**
 * Read access to the memory repo for the `repo` lane: the running `MemoryRepoService` in
 * production (only while it is ready), a fake in tests.
 */
export interface MemoryRepoRecallSource {
  /** Root-relative markdown paths (`.git` and hidden entries skipped, capped). */
  listFiles(): Promise<string[]>;
  /** A file's text, or null when missing or unsafe. */
  readFile(relPath: string): Promise<string | null>;
  /** Changes when the file changes (mtime and size), so parsed entries can be cached. */
  stamp(relPath: string): Promise<string | null>;
}

/** Backends of the lanes. Production wiring is `defaultMemoryRecallDeps`; tests inject fakes. */
export interface MemoryRecallDeps {
  searchItems(request: MemoryItemRecallRequest): Promise<MemoryItemRecallRow[]>;
  markItemsUsed(ids: string[]): Promise<void>;
  searchArchive(workspaceId: string, query: string, limit: number): Promise<MemorySearchResult[]>;
  archiveDetails(ids: string[]): Promise<Memory[]>;
  archiveHiddenIds(ids: string[]): Promise<Set<string>>;
  recordArchiveUse(ids: string[]): void;
  searchConversation(args: {
    workspaceId: string;
    taskId?: string;
    query: string;
    limit: number;
  }): Promise<ConversationRecallHit[]>;
  describeConversation(args: {
    workspaceId: string;
    id: string;
  }): Promise<{ id: string; taskId: string; text: string; timestamp: number } | null>;
  searchKnowledgeGraph(
    workspaceId: string,
    query: string,
    limit: number,
  ): Promise<KnowledgeEntityHit[]>;
  getKnowledgeEntity(workspaceId: string, id: string): Promise<KnowledgeEntityHit | null>;
  searchMarkdown(
    workspaceId: string,
    kitRoot: string,
    query: string,
    limit: number,
    readGuard?: (absolutePath: string) => boolean,
  ): Promise<MemorySearchResult[]>;
  readTextFile(absolutePath: string): Promise<string>;
  searchExternal(args: {
    workspace: { id: string; name: string };
    query: string;
    limit: number;
  }): Promise<ExternalRecallHit[]>;
  externalConfigured(): boolean;
  /** The memory repo, or null when it is off or not ready (the `repo` lane is skipped). */
  memoryRepo?(): MemoryRepoRecallSource | null;
  /** Feature toggles from Memory settings; a lane switched off is skipped. */
  laneEnabled(lane: MemoryRecallLane): boolean;
  now(): number;
}

export interface MemoryRecallResult {
  hits: MemoryRecallHit[];
  /** Lanes that were queried. */
  lanes: MemoryRecallLane[];
  /** Lanes that failed, with a short reason; their hits are missing from `hits`. */
  laneErrors: Partial<Record<MemoryRecallLane, string>>;
  /** Refs that were asked for (ids) but are unknown or not visible here. */
  missing: string[];
}

interface LaneCandidate {
  lane: MemoryRecallLane;
  ref: string;
  title: string;
  content: string;
  source: MemoryRecallHit["source"];
  createdAt: number;
  kind?: string;
  provenance: Record<string, unknown>;
  item?: MemoryItem;
  /** Multiplier of the lane weight for this candidate (imports). */
  weightFactor?: number;
}

function collapse(text: string): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(text: string, max: number): string {
  const value = collapse(text);
  if (value.length <= max) return value;
  const slice = value.slice(0, max);
  const space = slice.lastIndexOf(" ");
  return `${(space > max * 0.6 ? slice.slice(0, space) : slice).trimEnd()}…`;
}

/** Cut long text at a word boundary, keeping its line structure (full content). */
function truncateKeepingLines(text: string, max: number): string {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  const slice = value.slice(0, max);
  const space = slice.search(/\s\S*$/);
  return `${(space > max * 0.6 ? slice.slice(0, space) : slice).trimEnd()}…`;
}

function titleOf(text: string): string {
  const firstLine = String(text || "")
    .split(/\n/)
    .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean);
  return cut(firstLine || text, TITLE_CHARS);
}

export function estimateRecallTokens(text: string): number {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

/** Key used to merge the same text found in two lanes. */
function dedupeKey(text: string): string {
  return foldForMatch(collapse(text))
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .slice(0, 160);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? "unknown error")).slice(0, 200);
}

function trustOfSource(source: MemoryItemSource | undefined): number {
  return source ? MEMORY_ITEM_TRUST[source] : 0;
}

/** Parse a lane-qualified ref; bare uuids are memory items, bare `md:` / `dce_` ids map too. */
export function parseRecallRef(
  raw: string,
): { lane: MemoryRecallLane; kind: string; id: string } | null {
  const ref = String(raw || "").trim();
  if (!ref) return null;
  const colon = ref.indexOf(":");
  const prefix = colon > 0 ? ref.slice(0, colon) : "";
  const rest = colon > 0 ? ref.slice(colon + 1) : ref;
  switch (prefix) {
    case "memory":
      return rest ? { lane: "memory", kind: "item", id: rest } : null;
    case "archive":
      return rest ? { lane: "archive", kind: "archive", id: rest } : null;
    case "event":
      return rest ? { lane: "conversations", kind: "event", id: rest } : null;
    case "kg":
      return rest ? { lane: "knowledge", kind: "kg", id: rest } : null;
    case "doc":
      return rest ? { lane: "knowledge", kind: "doc", id: rest } : null;
    case "external":
      return rest ? { lane: "external", kind: "external", id: rest } : null;
    case "repo": {
      const repoRef = parseMemoryRepoRef(ref);
      return repoRef
        ? { lane: "repo", kind: "repo", id: `${repoRef.path}#L${repoRef.line}` }
        : null;
    }
    default:
      if (/^dc[es]_[A-Za-z0-9_-]+$/.test(ref))
        return { lane: "conversations", kind: "event", id: ref };
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
        // A bare uuid: memory items and archive rows both use uuids; try both.
        return { lane: "memory", kind: "uuid", id: ref };
      }
      return null;
  }
}

export class MemoryRecallService implements MemoryRecall {
  private static defaultInstance: MemoryRecallService | null = null;
  /** Parsed memory repo files by path, reused while the file stamp is unchanged. */
  private readonly repoFileCache = new Map<string, { stamp: string; entries: MemoryRepoEntry[] }>();

  constructor(private readonly deps: MemoryRecallDeps) {}

  /** The process-wide recall over the production lanes. */
  static getDefault(): MemoryRecallService {
    if (!this.defaultInstance) {
      this.defaultInstance = new MemoryRecallService(defaultMemoryRecallDeps());
    }
    return this.defaultInstance;
  }

  /** Install a recall (tests) or reset to the default with null. */
  static setDefault(instance: MemoryRecallService | null): void {
    this.defaultInstance = instance;
  }

  async query(request: MemoryRecallQuery): Promise<MemoryRecallHit[]> {
    const result = await this.recall(request);
    const failed = Object.keys(result.laneErrors).length;
    if (failed > 0 && failed === result.lanes.length) {
      throw new Error(
        `Memory recall is unavailable: ${Object.values(result.laneErrors).join("; ")}`,
      );
    }
    return result.hits;
  }

  /** `query` plus the lanes that ran or failed and the refs that were not found. */
  async recall(request: MemoryRecallQuery): Promise<MemoryRecallResult> {
    const limit = Math.max(
      1,
      Math.min(MEMORY_RECALL_MAX_LIMIT, Math.floor(request.limit ?? MEMORY_RECALL_DEFAULT_LIMIT)),
    );
    const requestedLanes = request.lanes?.length
      ? [...new Set(request.lanes)]
      : lanesForScopes(DEFAULT_MEMORY_RECALL_SCOPES);
    const lanes = requestedLanes.filter((lane) => this.laneAvailable(lane, request.policy));
    const ids = (request.ids ?? []).map((id) => String(id || "").trim()).filter(Boolean);
    if (ids.length > 0) {
      return this.expand(request, ids.slice(0, MEMORY_RECALL_MAX_LIMIT), lanes);
    }

    const perLane = Math.min(MEMORY_RECALL_MAX_LIMIT, limit * 2);
    const laneErrors: MemoryRecallResult["laneErrors"] = {};
    const lists = await Promise.all(
      lanes.map(async (lane) => {
        try {
          return await this.runLane(lane, request, perLane);
        } catch (error) {
          laneErrors[lane] = errorText(error);
          logger.warn(`Recall lane ${lane} failed:`, error);
          return [] as LaneCandidate[];
        }
      }),
    );
    const hits = this.fuse(lists, limit, request.detail === "full", queryFocusTerms(request.text));
    return { hits, lanes, laneErrors, missing: [] };
  }

  async markUsed(refs: string[]): Promise<void> {
    const itemIds: string[] = [];
    const archiveIds: string[] = [];
    for (const ref of refs) {
      const parsed = parseRecallRef(ref);
      if (!parsed) continue;
      if (parsed.lane === "memory" && parsed.kind === "item") itemIds.push(parsed.id);
      if (parsed.lane === "archive") archiveIds.push(parsed.id);
    }
    if (archiveIds.length > 0) {
      try {
        this.deps.recordArchiveUse(archiveIds);
      } catch (error) {
        logger.warn("Recording archive use failed:", error);
      }
    }
    if (itemIds.length > 0) {
      try {
        await this.deps.markItemsUsed(itemIds);
      } catch (error) {
        logger.warn("Recording memory item use failed:", error);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lanes
  // ---------------------------------------------------------------------------

  private laneAvailable(lane: MemoryRecallLane, policy: MemoryRecallPolicy | undefined): boolean {
    if (lane === "external") {
      return policy?.allowExternal === true && this.deps.externalConfigured();
    }
    if (lane === "repo") {
      return Boolean(this.deps.memoryRepo?.()) && this.deps.laneEnabled(lane);
    }
    return this.deps.laneEnabled(lane);
  }

  private async runLane(
    lane: MemoryRecallLane,
    request: MemoryRecallQuery,
    limit: number,
  ): Promise<LaneCandidate[]> {
    const text = String(request.text || "").trim();
    switch (lane) {
      case "memory":
        return this.memoryLane(request, text, limit);
      case "repo":
        return text ? this.repoLane(text, limit) : [];
      case "archive":
        return text && request.workspaceId
          ? this.archiveLane(request.workspaceId, text, limit)
          : [];
      case "conversations":
        return text && request.workspaceId ? this.conversationLane(request, text, limit) : [];
      case "knowledge":
        return text && request.workspaceId ? this.knowledgeLane(request, text, limit) : [];
      case "external":
        return text && request.workspaceId ? this.externalLane(request, text, limit) : [];
      default:
        return [];
    }
  }

  private itemRequest(
    request: MemoryRecallQuery,
    text: string,
    limit: number,
  ): MemoryItemRecallRequest {
    const minTrust =
      request.minSource !== undefined
        ? trustOfSource(request.minSource)
        : request.contactRef
          ? MEMORY_ITEM_TRUST.third_party
          : DEFAULT_MIN_TRUST;
    return {
      workspaceId: request.workspaceId,
      query: text,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.contactRef ? { contactRef: request.contactRef } : {}),
      ...(request.kinds?.length ? { kinds: request.kinds } : {}),
      ...(request.scopes?.length ? { scopes: request.scopes } : {}),
      minTrust,
      includePrivate: request.policy?.includePrivate === true,
      limit,
      now: this.deps.now(),
    };
  }

  private async memoryLane(
    request: MemoryRecallQuery,
    text: string,
    limit: number,
  ): Promise<LaneCandidate[]> {
    const rows = await this.deps.searchItems(this.itemRequest(request, text, limit));
    // Lane-internal order: lexical relevance (relative to the best match), then trust and
    // pin; a listing (no text) keeps the store's pinned / trusted / recent order.
    const best = Math.max(0, ...rows.map((row) => row.lexical));
    const ranked = text
      ? rows
          .map((row) => ({
            row,
            score:
              (best > 0 ? row.lexical / best : row.coverage) * 0.65 +
              row.coverage * 0.1 +
              row.item.trust * 0.2 +
              (row.item.pinned ? 0.05 : 0),
          }))
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.row)
      : rows;
    return ranked.map((row) => this.itemCandidate(row.item));
  }

  private itemCandidate(item: MemoryItem): LaneCandidate {
    return {
      lane: "memory",
      ref: `memory:${item.id}`,
      title: titleOf(item.content),
      content: item.content,
      source: item.source,
      createdAt: item.updatedAt || item.createdAt,
      kind: item.kind,
      item,
      provenance: {
        scope: item.scope,
        source: item.source,
        trust: item.trust,
        ...(item.pinned ? { pinned: true } : {}),
        ...(item.subjectKey && !/^[a-z_]+:[0-9a-f]{16}$/.test(item.subjectKey)
          ? { subject: item.subjectKey }
          : {}),
        ...(typeof item.sourceRef.store === "string" ? { store: item.sourceRef.store } : {}),
      },
    };
  }

  /**
   * Entries of the memory repo ranked by how many of the query's terms they contain
   * (stopwords dropped as in the fusion damping), then shorter entries, then newest first. Files are parsed once per change.
   */
  private async repoLane(text: string, limit: number): Promise<LaneCandidate[]> {
    const repo = this.deps.memoryRepo?.();
    if (!repo) return [];
    const terms = extractFtsTerms(text, { maxTerms: 12, dropStopwords: true });
    if (terms.length === 0) return [];
    const files = await repo.listFiles();
    const live = new Set(files);
    for (const cached of this.repoFileCache.keys()) {
      if (!live.has(cached)) this.repoFileCache.delete(cached);
    }
    const scored: Array<{ candidate: LaneCandidate; coverage: number; density: number }> = [];
    for (const file of files) {
      for (const entry of await this.repoEntries(repo, file)) {
        const coverage = termCoverage(entry.text, terms);
        if (coverage === 0) continue;
        scored.push({
          candidate: this.repoCandidate(file, entry, entry.text),
          coverage,
          // Shorter entries carry less unrelated text per matched term.
          density: 1 / Math.max(1, entry.text.length),
        });
      }
    }
    return scored
      .sort(
        (a, b) =>
          b.coverage - a.coverage ||
          b.density - a.density ||
          b.candidate.createdAt - a.candidate.createdAt,
      )
      .slice(0, limit)
      .map((entry) => entry.candidate);
  }

  private async repoEntries(
    repo: MemoryRepoRecallSource,
    file: string,
  ): Promise<MemoryRepoEntry[]> {
    const stamp = await repo.stamp(file).catch(() => null);
    const cached = stamp ? this.repoFileCache.get(file) : undefined;
    if (cached && cached.stamp === stamp) return cached.entries;
    const entries = parseMemoryRepoEntries((await repo.readFile(file)) ?? "");
    if (stamp) this.repoFileCache.set(file, { stamp, entries });
    else this.repoFileCache.delete(file);
    return entries;
  }

  private repoCandidate(file: string, entry: MemoryRepoEntry, content: string): LaneCandidate {
    const unreviewed = file === MEMORY_REPO_INBOX_FILE;
    const added = entry.metadata.added ? Date.parse(entry.metadata.added) : NaN;
    // Hand-written secrets are not redacted on disk (the user's file); recall never shows them.
    const text = `${unreviewed ? UNREVIEWED_PREFIX : ""}${redactSensitiveMarkdownContent(content)}`;
    return {
      lane: "repo",
      ref: memoryRepoRef(file, entry.line),
      title: titleOf(text),
      content: text,
      source: entry.by === "user" ? "user_stated" : "inferred",
      createdAt: Number.isFinite(added) ? added : 0,
      ...(entry.kind ? { kind: entry.kind } : {}),
      provenance: {
        store: "memory_repo",
        file,
        line: entry.line,
        by: entry.by,
        ...(entry.metadata.source ? { source: entry.metadata.source } : {}),
        ...(entry.metadata.added ? { added: entry.metadata.added } : {}),
        ...(entry.metadata.workspace ? { workspace: entry.metadata.workspace } : {}),
        ...(unreviewed ? { unreviewed: true } : {}),
      },
    };
  }

  private async archiveLane(
    workspaceId: string,
    text: string,
    limit: number,
  ): Promise<LaneCandidate[]> {
    const results = await this.deps.searchArchive(workspaceId, text, limit);
    return results
      .filter((result) => result.source !== "markdown")
      .map((result) =>
        this.archiveCandidate(
          result.id,
          result.snippet,
          result.type,
          result.createdAt,
          result.taskId,
        ),
      );
  }

  private archiveCandidate(
    id: string,
    content: string,
    type: string,
    createdAt: number,
    taskId?: string,
  ): LaneCandidate {
    const imported = hasReservedImportPrefix(content);
    return {
      lane: "archive",
      ref: `archive:${id}`,
      title: titleOf(content),
      content,
      source: imported ? "import" : "system",
      createdAt,
      kind: type,
      provenance: {
        store: "archive",
        ...(taskId ? { taskId } : {}),
        ...(imported ? { imported: true } : {}),
      },
      ...(imported ? { weightFactor: IMPORTED_ARCHIVE_FACTOR } : {}),
    };
  }

  private async conversationLane(
    request: MemoryRecallQuery,
    text: string,
    limit: number,
  ): Promise<LaneCandidate[]> {
    const workspaceId = request.workspaceId as string;
    const onlyTask = request.policy?.conversationTaskId;
    const excludeTask =
      !onlyTask && request.policy?.excludeActiveTaskConversation !== false
        ? request.taskId
        : undefined;
    const hits = await this.deps.searchConversation({
      workspaceId,
      ...(onlyTask ? { taskId: onlyTask } : {}),
      query: text,
      limit: excludeTask ? limit + 10 : limit,
    });
    return hits
      .filter((hit) => !excludeTask || hit.taskId !== excludeTask)
      .slice(0, limit)
      .map((hit) => ({
        lane: "conversations" as const,
        ref: `event:${hit.id}`,
        title: titleOf(hit.snippet),
        content: hit.snippet,
        source: "event" as const,
        createdAt: hit.timestamp,
        kind: hit.role,
        provenance: { taskId: hit.taskId, role: hit.role, type: hit.type },
      }));
  }

  private async knowledgeLane(
    request: MemoryRecallQuery,
    text: string,
    limit: number,
  ): Promise<LaneCandidate[]> {
    const workspaceId = request.workspaceId as string;
    const policy = request.policy;
    const workspacePath = policy?.workspacePath;
    const [entities, documents] = await Promise.all([
      this.deps.searchKnowledgeGraph(workspaceId, text, limit).catch((error) => {
        logger.debug?.("Knowledge graph recall failed:", error);
        return [] as KnowledgeEntityHit[];
      }),
      workspacePath
        ? this.deps.searchMarkdown(
            workspaceId,
            path.join(workspacePath, ".cowork"),
            text,
            limit,
            policy?.readGuard,
          )
        : Promise.resolve([] as MemorySearchResult[]),
    ]);
    const entityCandidates = entities.map((entity) => this.entityCandidate(entity, false));
    const documentCandidates = documents
      .filter(
        (doc): doc is Extract<MemorySearchResult, { source: "markdown" }> =>
          doc.source === "markdown",
      )
      .map((doc) => ({
        lane: "knowledge" as const,
        ref: `doc:${doc.startLine}-${doc.endLine}:${doc.path}`,
        title: `${doc.path}:${doc.startLine}`,
        content: doc.snippet,
        source: "document" as const,
        createdAt: doc.createdAt,
        kind: "document",
        provenance: { path: `.cowork/${doc.path}`, startLine: doc.startLine, endLine: doc.endLine },
      }));
    // Interleave the sources so one of them cannot crowd out the other.
    const merged: LaneCandidate[] = [];
    const sources = [entityCandidates, documentCandidates];
    for (let index = 0; merged.length < limit; index += 1) {
      let added = false;
      for (const list of sources) {
        if (index < list.length) {
          merged.push(list[index]);
          added = true;
        }
      }
      if (!added) break;
    }
    return merged.slice(0, limit);
  }

  private entityCandidate(entity: KnowledgeEntityHit, full: boolean): LaneCandidate {
    const lines = [
      `${entity.name}${entity.type ? ` (${entity.type})` : ""}`,
      entity.description || "",
      ...(entity.observations ?? [])
        .slice(0, full ? 20 : 3)
        .map((observation) => `- ${observation}`),
    ].filter(Boolean);
    return {
      lane: "knowledge",
      ref: `kg:${entity.id}`,
      title: cut(`${entity.name}${entity.type ? ` (${entity.type})` : ""}`, TITLE_CHARS),
      content: lines.join("\n"),
      source: "document",
      createdAt: entity.createdAt,
      kind: entity.type || "entity",
      provenance: {
        store: "knowledge_graph",
        entityId: entity.id,
        ...(typeof entity.confidence === "number" ? { confidence: entity.confidence } : {}),
      },
    };
  }

  private async externalLane(
    request: MemoryRecallQuery,
    text: string,
    limit: number,
  ): Promise<LaneCandidate[]> {
    const workspaceId = request.workspaceId as string;
    const results = await this.deps.searchExternal({
      workspace: { id: workspaceId, name: request.policy?.workspaceName || workspaceId },
      query: text,
      limit: Math.min(limit, 25),
    });
    return results.map((result, index) => ({
      lane: "external" as const,
      ref: result.id ? `external:${result.id}` : `external:#${index + 1}`,
      title: titleOf(result.text),
      content: result.text,
      source: "document" as const,
      createdAt: result.updatedAt ? Date.parse(result.updatedAt) || 0 : 0,
      kind: "external",
      provenance: {
        provider: "supermemory",
        ...(typeof result.similarity === "number" ? { similarity: result.similarity } : {}),
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Fusion
  // ---------------------------------------------------------------------------

  private fuse(
    lists: LaneCandidate[][],
    limit: number,
    full: boolean,
    focusTerms: string[] = [],
  ): MemoryRecallHit[] {
    interface Fused {
      candidate: LaneCandidate;
      score: number;
      laneRanks: Partial<Record<MemoryRecallLane, number>>;
    }
    const byKey = new Map<string, Fused>();
    const order: Fused[] = [];
    for (const list of lists) {
      list.forEach((candidate, index) => {
        const rank = index + 1;
        const contribution =
          ((MEMORY_RECALL_LANE_WEIGHTS[candidate.lane] * (candidate.weightFactor ?? 1)) /
            (RRF_K + rank)) *
          coverageFactor(candidate.content, focusTerms);
        const key = dedupeKey(candidate.content) || candidate.ref;
        const existing = byKey.get(key);
        if (existing) {
          existing.score += contribution;
          if (existing.laneRanks[candidate.lane] === undefined) {
            existing.laneRanks[candidate.lane] = rank;
          }
          // Keep the representative from the stronger lane (memory items over files …).
          if (
            MEMORY_RECALL_LANE_WEIGHTS[candidate.lane] >
            MEMORY_RECALL_LANE_WEIGHTS[existing.candidate.lane]
          ) {
            existing.candidate = candidate;
          }
          return;
        }
        const fused: Fused = {
          candidate,
          score: contribution,
          laneRanks: { [candidate.lane]: rank },
        };
        byKey.set(key, fused);
        order.push(fused);
      });
    }
    const ranked = order
      .sort((a, b) => b.score - a.score || b.candidate.createdAt - a.candidate.createdAt)
      .slice(0, limit);
    const top = ranked[0]?.score ?? 0;
    return ranked.map((entry) =>
      this.toHit(entry.candidate, {
        score: entry.score,
        relevance: top > 0 ? Math.round((entry.score / top) * 1000) / 1000 : 0,
        laneRanks: entry.laneRanks,
        full,
      }),
    );
  }

  private toHit(
    candidate: LaneCandidate,
    meta: {
      score: number;
      relevance: number;
      laneRanks: Partial<Record<MemoryRecallLane, number>>;
      full: boolean;
    },
  ): MemoryRecallHit {
    const content = truncateKeepingLines(candidate.content, MEMORY_RECALL_FULL_CHARS);
    return {
      lane: candidate.lane,
      ref: candidate.ref,
      ...(candidate.item ? { item: candidate.item } : {}),
      title: candidate.title,
      ...(meta.full ? { content } : {}),
      snippet: cut(candidate.content, SNIPPET_CHARS),
      score: Math.round(meta.score * 1e6) / 1e6,
      relevance: meta.relevance,
      laneRanks: meta.laneRanks,
      source: candidate.source,
      createdAt: candidate.createdAt,
      tokenEstimate: estimateRecallTokens(content),
      ...(candidate.kind ? { kind: candidate.kind } : {}),
      provenance: candidate.provenance,
    };
  }

  // ---------------------------------------------------------------------------
  // Expansion (detail: full with ids)
  // ---------------------------------------------------------------------------

  private async expand(
    request: MemoryRecallQuery,
    refs: string[],
    lanes: MemoryRecallLane[],
  ): Promise<MemoryRecallResult> {
    const allowed = new Set(lanes);
    const laneErrors: MemoryRecallResult["laneErrors"] = {};
    const missing: string[] = [];
    const found: LaneCandidate[] = [];
    for (const ref of refs) {
      const parsed = parseRecallRef(ref);
      if (!parsed || !request.workspaceId) {
        missing.push(ref);
        continue;
      }
      // A bare uuid may be a memory item or an archive row.
      const laneOk =
        parsed.kind === "uuid"
          ? allowed.has("memory") || allowed.has("archive")
          : allowed.has(parsed.lane);
      if (!laneOk) {
        missing.push(ref);
        continue;
      }
      try {
        const candidate = await this.expandOne(request, parsed, allowed);
        if (candidate) found.push(candidate);
        else missing.push(ref);
      } catch (error) {
        laneErrors[parsed.lane] = errorText(error);
        missing.push(ref);
      }
    }
    const hits = found.map((candidate, index) =>
      this.toHit(candidate, {
        score: 0,
        relevance: 1,
        laneRanks: { [candidate.lane]: index + 1 },
        full: true,
      }),
    );
    return { hits, lanes, laneErrors, missing };
  }

  private async expandOne(
    request: MemoryRecallQuery,
    parsed: { lane: MemoryRecallLane; kind: string; id: string },
    allowed: Set<MemoryRecallLane>,
  ): Promise<LaneCandidate | null> {
    const workspaceId = request.workspaceId as string;
    switch (parsed.kind) {
      case "item":
        return this.expandItem(request, parsed.id);
      case "uuid":
        return (
          (allowed.has("memory") ? await this.expandItem(request, parsed.id) : null) ??
          (allowed.has("archive") ? await this.expandArchive(workspaceId, parsed.id) : null)
        );
      case "archive":
        return this.expandArchive(workspaceId, parsed.id);
      case "event": {
        const event = await this.deps.describeConversation({ workspaceId, id: parsed.id });
        if (!event) return null;
        return {
          lane: "conversations",
          ref: `event:${event.id}`,
          title: titleOf(event.text),
          content: event.text,
          source: "event",
          createdAt: event.timestamp,
          provenance: { taskId: event.taskId },
        };
      }
      case "kg": {
        const entity = await this.deps.getKnowledgeEntity(workspaceId, parsed.id);
        return entity ? this.entityCandidate(entity, true) : null;
      }
      case "doc":
        return this.expandDocument(request.policy, parsed.id);
      case "repo":
        return this.expandRepo(parsed.id);
      default:
        // External hits carry their text in the listing; there is no fetch by id.
        return null;
    }
  }

  private async expandItem(request: MemoryRecallQuery, id: string): Promise<LaneCandidate | null> {
    const rows = await this.deps.searchItems({
      ...this.itemRequest(request, "", 1),
      ids: [id],
    });
    return rows[0] ? this.itemCandidate(rows[0].item) : null;
  }

  private async expandArchive(workspaceId: string, id: string): Promise<LaneCandidate | null> {
    const [memory] = await this.deps.archiveDetails([id]);
    if (!memory) return null;
    const ownRow = memory.workspaceId === workspaceId;
    const sharedImport = !memory.isPrivate && hasReservedImportPrefix(memory.content);
    if (!ownRow && !sharedImport) return null;
    const hidden = await this.deps.archiveHiddenIds([id]);
    if (hidden.has(id)) return null;
    return this.archiveCandidate(
      memory.id,
      memory.content || memory.summary || "",
      memory.type,
      memory.createdAt,
      memory.taskId,
    );
  }

  /** The entry plus the file lines around it (at most `MEMORY_REPO_FULL_LINES`). */
  private async expandRepo(id: string): Promise<LaneCandidate | null> {
    const ref = parseMemoryRepoRef(`repo:${id}`);
    const repo = this.deps.memoryRepo?.();
    if (!ref || !repo) return null;
    const raw = await repo.readFile(ref.path);
    if (raw === null) return null;
    const entry = parseMemoryRepoEntries(raw).find((candidate) => candidate.line === ref.line);
    if (!entry) return null;
    const lines = splitLines(raw);
    const start = Math.max(1, ref.line - Math.floor(MEMORY_REPO_FULL_LINES / 2));
    const end = Math.min(lines.length, start + MEMORY_REPO_FULL_LINES - 1);
    const section = lines.slice(start - 1, end).join("\n");
    const candidate = this.repoCandidate(ref.path, entry, section);
    return {
      ...candidate,
      title: titleOf(entry.text),
      provenance: { ...candidate.provenance, startLine: start, endLine: end },
    };
  }

  private async expandDocument(
    policy: MemoryRecallPolicy | undefined,
    id: string,
  ): Promise<LaneCandidate | null> {
    const match = /^(\d+)-(\d+):(.+)$/.exec(id);
    if (!match || !policy?.workspacePath) return null;
    const root = path.resolve(policy.workspacePath, ".cowork");
    const absolute = path.resolve(root, match[3]);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
    if (!absolute.toLowerCase().endsWith(".md")) return null;
    if (policy.readGuard && policy.readGuard(absolute) !== true) return null;
    const start = Math.max(1, Number(match[1]));
    const end = Math.min(start + 400, Math.max(start, Number(match[2])));
    const raw = await this.deps.readTextFile(absolute).catch(() => "");
    if (!raw) return null;
    const lines = raw.split(/\r?\n/).slice(start - 1, end);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    return {
      lane: "knowledge",
      ref: `doc:${start}-${end}:${relative}`,
      title: `${relative}:${start}`,
      content: lines.join("\n"),
      source: "document",
      createdAt: 0,
      kind: "document",
      provenance: { path: `.cowork/${relative}`, startLine: start, endLine: end },
    };
  }
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/** Lane backends over the running services. */
export function defaultMemoryRecallDeps(): MemoryRecallDeps {
  const featureSettings = () => {
    try {
      return MemoryFeaturesManager.loadSettings();
    } catch {
      return null;
    }
  };
  return {
    async searchItems(request) {
      const sql = MemoryService.getStatements();
      if (!sql) throw new Error("memory store is not initialized");
      return sql.unit("memoryRecall_searchItems", [request]);
    },
    async markItemsUsed(ids) {
      const sql = MemoryService.getStatements();
      if (!sql) return;
      await sql.unit("memoryItems_markUsed", [ids, Date.now()]);
    },
    searchArchive: (workspaceId, query, limit) =>
      MemoryService.searchForRecallAsync(workspaceId, query, limit),
    archiveDetails: (ids) => MemoryService.getFullDetails(ids),
    async archiveHiddenIds(ids) {
      try {
        return await MemoryObservationService.suppressedIds(ids);
      } catch {
        // Without the observation store nothing can be checked: hide everything asked for.
        return new Set(ids);
      }
    },
    recordArchiveUse(ids) {
      MemoryService.recordPromptInjection(ids);
    },
    async searchConversation(args) {
      const hits = await DurableContextService.searchConversation({
        workspaceId: args.workspaceId,
        ...(args.taskId ? { taskId: args.taskId } : {}),
        query: args.query,
        limit: args.limit,
        mode: "auto",
      });
      return hits.map((hit) => ({
        id: hit.id,
        taskId: hit.taskId,
        role: hit.role,
        type: hit.type,
        snippet: hit.snippet,
        timestamp: hit.timestamp,
        score: hit.score,
      }));
    },
    async describeConversation(args) {
      const description = await DurableContextService.describeConversationHit(args);
      if (!description || description.workspaceId !== args.workspaceId) return null;
      const sources = (description.sourceMessages ?? [])
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n");
      return {
        id: description.id,
        taskId: description.taskId,
        text: sources ? `${description.text}\n\nSource messages:\n${sources}` : description.text,
        timestamp: description.timestamp,
      };
    },
    async searchKnowledgeGraph(workspaceId, query, limit) {
      if (!KnowledgeGraphService.isInitialized()) return [];
      const results = await KnowledgeGraphService.search(workspaceId, query, Math.min(limit, 20));
      return results
        .filter((result) => result.entity.workspaceId === workspaceId)
        .map((result) => ({
          id: result.entity.id,
          name: result.entity.name,
          type: result.entity.entityTypeName,
          description: result.entity.description,
          observations: (result.observations ?? []).map((observation) => observation.content),
          confidence: result.entity.confidence,
          createdAt: result.entity.updatedAt || result.entity.createdAt,
          score: result.score,
        }));
    },
    async getKnowledgeEntity(workspaceId, id) {
      if (!KnowledgeGraphService.isInitialized()) return null;
      const entity = await KnowledgeGraphService.getEntity(workspaceId, id);
      if (!entity || entity.workspaceId !== workspaceId) return null;
      const observations = await KnowledgeGraphService.getObservations(workspaceId, id, 20);
      return {
        id: entity.id,
        name: entity.name,
        type: entity.entityTypeName,
        description: entity.description,
        observations: observations.map((observation) => observation.content),
        confidence: entity.confidence,
        createdAt: entity.updatedAt || entity.createdAt,
        score: 0,
      };
    },
    searchMarkdown: (workspaceId, kitRoot, query, limit, readGuard) =>
      MemoryService.searchWorkspaceMarkdown(workspaceId, kitRoot, query, limit, readGuard),
    async readTextFile(absolutePath) {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size > 2_000_000) return "";
      return fs.readFile(absolutePath, "utf8");
    },
    async searchExternal(args) {
      const result = await SupermemoryService.search({
        workspace: args.workspace,
        query: args.query,
        limit: args.limit,
      });
      return result.results;
    },
    externalConfigured() {
      try {
        return SupermemoryService.isConfigured();
      } catch {
        return false;
      }
    },
    memoryRepo() {
      const service = MemoryRepoService.get();
      // Only for a task whose memoryRepo layer is on (private, not a sub-agent, memory on):
      // the tool call runs inside that task's memory-repo access scope.
      if (!service?.isReady() || !isMemoryRepoReadAllowed()) return null;
      return {
        listFiles: () => service.listFiles(),
        readFile: (relPath) => service.readFile(relPath),
        async stamp(relPath) {
          try {
            const stat = await fs.stat(path.join(service.root, relPath));
            return `${service.root}:${stat.mtimeMs}:${stat.size}`;
          } catch {
            return null;
          }
        },
      };
    },
    laneEnabled(lane) {
      const settings = featureSettings();
      if (!settings) return true;
      if (lane === "conversations") return settings.sessionRecallEnabled !== false;
      return true;
    },
    now: () => Date.now(),
  };
}
