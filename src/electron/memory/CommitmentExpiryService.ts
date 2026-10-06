/**
 * Commitment expiry (docs/memory-repo-phase3-design.md §6): closes past-due `commitment`
 * items of `memory_items` once later activity says they were done.
 *
 * A sweep reads the active global and workspace commitments that are at least a day past
 * due, looks for "done" evidence (archive outcomes and the conversation index of the
 * commitment's workspace; for global commitments, of the most recent workspaces), and
 * archives the ones with evidence through `MemoryWriter.applyCuration` — one logged,
 * undoable `expire_commitment` per item. Nothing is queued for review:
 *
 *   - commitments the user stated or confirmed are never closed automatically;
 *   - commitments without evidence stay open, however late;
 *   - an expiry the user undid is never applied again.
 *
 * The Heartbeat pulse offers a sweep; it runs at most once per COMMITMENT_SWEEP_INTERVAL_MS.
 * The cooldown is in memory only (one sweep per process start, then daily), so no state
 * table is needed; a restart at worst repeats a cheap, idempotent sweep.
 */
import type { MemoryReviewEvidence } from "../../shared/memory-review-types";
import { createLogger } from "../utils/logger";
import { DurableContextService, type ConversationHit } from "./DurableContextService";
import type { MemoryCurationRepository } from "./MemoryCurationRepository";
import { MemoryWriter } from "./MemoryWriter";
import type { ArchiveEvidenceRow } from "./memory-curation-sql";
import type { MemoryItem } from "./memory-items-types";

const logger = createLogger("CommitmentExpiry");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimum spacing between sweeps of one process. */
export const COMMITMENT_SWEEP_INTERVAL_MS = DAY_MS;
/** Archive outcomes older than this are not read as done evidence. */
export const COMMITMENT_ARCHIVE_WINDOW_MS = 30 * DAY_MS;
/** Expiries applied per sweep; the rest wait for the next one. */
export const MAX_EXPIRIES_PER_SWEEP = 25;
/** Conversation index searches per sweep (least recently checked commitments first). */
export const MAX_CONVERSATION_LOOKUPS = 20;
/** Workspaces searched for done evidence of a global commitment. */
export const MAX_GLOBAL_WORKSPACES = 5;
/** Commitments read per sweep. */
const MAX_COMMITMENTS = 2000;

const PROTECTED_SOURCES = new Set(["user_stated", "user_confirmed"]);

const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for with from as is are was were be been " +
    "being it its this that these those there here i me my we our you your he she they them their " +
    "his her do does did done has have had will would should could can may might must shall so " +
    "than too very just also about into over under up down out off again more most some any all " +
    "each other such only own same what which who whom when where why how use uses used using user"
  ).split(" "),
);

const DONE_WORDS =
  /\b(done|completed?|finished|sent|shipped|resolved|delivered|submitted|closed|merged|paid)\b/i;

/** Words of a commitment too generic to tie evidence to it. */
const GENERIC_COMMITMENT_WORDS = new Set(["follow", "send", "reply", "commitment"]);

// ---- Pure helpers ----

/** Lower-cased Unicode word tokens, apostrophes dropped ("don't" → "dont"). */
function tokenize(text: string): string[] {
  return (
    String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/['’`]/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Content words: stopwords and one-letter tokens removed. */
export function contentWords(text: string): Set<string> {
  return new Set(tokenize(text).filter((token) => token.length > 1 && !STOPWORDS.has(token)));
}

function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared;
}

export function clip(text: string, max: number): string {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) return normalized;
  const cut = normalized.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The due date of a commitment, or null when it has none. */
export function commitmentDueAt(item: Pick<MemoryItem, "sourceRef">): number | null {
  const dueAt = item.sourceRef?.dueAt;
  return typeof dueAt === "number" && Number.isFinite(dueAt) ? dueAt : null;
}

/** The curation log fingerprint of an expiry (an undone one blocks the item for good). */
export function expiryFingerprint(itemId: string): string {
  return `expire_commitment:${itemId}`;
}

/**
 * Whether a commitment may be closed automatically: active, global or workspace scope,
 * at least a day past due, and not stated or confirmed by the user.
 */
export function isExpiryCandidate(item: MemoryItem, now: number): boolean {
  if (item.kind !== "commitment" || item.status !== "active") return false;
  if (item.scope !== "global" && item.scope !== "workspace") return false;
  if (PROTECTED_SOURCES.has(item.source)) return false;
  const dueAt = commitmentDueAt(item);
  return dueAt !== null && dueAt <= now - DAY_MS;
}

function commitmentKeywords(item: MemoryItem): Set<string> {
  const words = contentWords(item.content);
  for (const word of GENERIC_COMMITMENT_WORDS) words.delete(word);
  return words;
}

/** Text from after the due window that mentions the commitment and a "done" word. */
function saysDone(
  keywords: ReadonlySet<string>,
  text: string,
  at: number,
  dueAt: number,
): boolean {
  return (
    at >= dueAt - 7 * DAY_MS &&
    DONE_WORDS.test(text) &&
    sharedCount(keywords, contentWords(text)) >= Math.min(2, keywords.size)
  );
}

/** Archive rows after the due window that mention the commitment and a "done" word. */
export function archiveDoneSignals(
  item: MemoryItem,
  archive: ArchiveEvidenceRow[],
): MemoryReviewEvidence[] {
  const dueAt = commitmentDueAt(item);
  const keywords = commitmentKeywords(item);
  if (dueAt === null || keywords.size === 0) return [];
  return archive
    .filter((row) => saysDone(keywords, row.content, row.createdAt, dueAt))
    .slice(0, 3)
    .map((row) => ({
      kind: "archive",
      ref: `archive:${row.id}`,
      snippet: clip(row.content, 240),
      at: row.createdAt,
      taskId: row.taskId,
    }));
}

/** Conversation index hits after the due window that mention the commitment as done. */
export function conversationDoneSignals(
  item: MemoryItem,
  hits: ConversationHit[],
): MemoryReviewEvidence[] {
  const dueAt = commitmentDueAt(item);
  const keywords = commitmentKeywords(item);
  if (dueAt === null || keywords.size === 0) return [];
  return hits
    .filter((hit) => saysDone(keywords, hit.snippet, hit.timestamp, dueAt))
    .slice(0, 3)
    .map((hit) => ({
      kind: "conversation",
      ref: `event:${hit.eventId ?? hit.id}`,
      snippet: clip(hit.snippet, 240),
      at: hit.timestamp,
      taskId: hit.taskId,
    }));
}

// ---- Service ----

export interface CommitmentSweepResult {
  /** Past-due commitments that could be closed automatically. */
  checked: number;
  /** Commitments closed by this sweep. */
  expired: number;
  /** Curation log ids of the expiries (undoable in the Memory Hub Review tab). */
  logIds: string[];
  /** Expiries the store refused (the item changed meanwhile), by reason. */
  refused: Record<string, number>;
}

export type CommitmentSweepSkip = "cooldown" | "in_flight" | "unavailable";

export interface CommitmentExpiryDeps {
  now?: () => number;
  /** The process-wide writer (defaults to `MemoryWriter.get()`). */
  getWriter?: () => MemoryWriter | null;
  /** Archive evidence and undone fingerprints (MemoryCurationRepository). */
  curation: Pick<MemoryCurationRepository, "archiveEvidence" | "undoneFingerprints">;
  /** Conversation index search (defaults to `DurableContextService.searchConversation`). */
  searchConversation?: (params: {
    workspaceId: string;
    query: string;
    limit?: number;
  }) => Promise<ConversationHit[]>;
  /** Workspaces searched for a global commitment's evidence, most recently used first. */
  listWorkspaceIds?: () => string[] | Promise<string[]>;
}

export class CommitmentExpiryService {
  private lastSweepAt: number | null = null;
  private inFlight: Promise<CommitmentSweepResult | CommitmentSweepSkip> | null = null;
  /** When each commitment was last searched in the conversation index (fair rotation). */
  private readonly lastSearchedAt = new Map<string, number>();

  constructor(private readonly deps: CommitmentExpiryDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Run a sweep unless one ran within COMMITMENT_SWEEP_INTERVAL_MS (`force` skips that
   * check) or one is in progress. Returns the skip reason when nothing ran.
   */
  async sweep(options: { force?: boolean } = {}): Promise<CommitmentSweepResult | CommitmentSweepSkip> {
    if (this.inFlight) return "in_flight";
    const now = this.now();
    if (
      !options.force &&
      this.lastSweepAt !== null &&
      now - this.lastSweepAt < COMMITMENT_SWEEP_INTERVAL_MS
    ) {
      return "cooldown";
    }
    const run = this.execute(now).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async execute(now: number): Promise<CommitmentSweepResult | CommitmentSweepSkip> {
    const writer = this.deps.getWriter ? this.deps.getWriter() : MemoryWriter.get();
    if (!writer?.supportsCuration) return "unavailable";
    if (!(await writer.repository.isLaneMigrationComplete())) return "unavailable";
    this.lastSweepAt = now;

    const commitments = (
      await writer.repository.list({
        kinds: ["commitment"],
        statuses: ["active"],
        includePrivate: true,
        limit: MAX_COMMITMENTS,
      })
    ).filter((item) => isExpiryCandidate(item, now));
    const result: CommitmentSweepResult = {
      checked: commitments.length,
      expired: 0,
      logIds: [],
      refused: {},
    };
    if (commitments.length === 0) return result;

    const recentWorkspaces = commitments.some((item) => item.workspaceId === null)
      ? (await this.listWorkspaceIds()).slice(0, MAX_GLOBAL_WORKSPACES)
      : [];
    const archiveByWorkspace = new Map<string, ArchiveEvidenceRow[]>();
    const undoneByWorkspace = new Map<string, Set<string>>();
    const archiveOf = async (workspaceId: string) => {
      let rows = archiveByWorkspace.get(workspaceId);
      if (!rows) {
        rows = await this.deps.curation.archiveEvidence(
          workspaceId,
          now - COMMITMENT_ARCHIVE_WINDOW_MS,
          300,
        );
        archiveByWorkspace.set(workspaceId, rows);
      }
      return rows;
    };
    const undoneOf = async (workspaceId: string) => {
      let undone = undoneByWorkspace.get(workspaceId);
      if (!undone) {
        undone = new Set(await this.deps.curation.undoneFingerprints(workspaceId));
        undoneByWorkspace.set(workspaceId, undone);
      }
      return undone;
    };

    // Least recently searched first, so a long list rotates through the lookup budget.
    const ordered = [...commitments].sort(
      (a, b) => (this.lastSearchedAt.get(a.id) ?? 0) - (this.lastSearchedAt.get(b.id) ?? 0),
    );
    let lookups = 0;
    for (const item of ordered) {
      if (result.expired >= MAX_EXPIRIES_PER_SWEEP) break;
      const workspaces = item.workspaceId ? [item.workspaceId] : recentWorkspaces;
      if (workspaces.length === 0) continue;
      const fingerprint = expiryFingerprint(item.id);
      let blocked = false;
      for (const workspaceId of workspaces) {
        if ((await undoneOf(workspaceId)).has(fingerprint)) blocked = true;
      }
      if (blocked) continue;

      let found: { workspaceId: string; evidence: MemoryReviewEvidence[] } | null = null;
      for (const workspaceId of workspaces) {
        const evidence = archiveDoneSignals(item, await archiveOf(workspaceId));
        if (evidence.length > 0) {
          found = { workspaceId, evidence };
          break;
        }
      }
      if (!found) {
        for (const workspaceId of workspaces) {
          if (lookups >= MAX_CONVERSATION_LOOKUPS) break;
          lookups += 1;
          this.lastSearchedAt.set(item.id, now);
          const evidence = conversationDoneSignals(item, await this.search(workspaceId, item));
          if (evidence.length > 0) {
            found = { workspaceId, evidence };
            break;
          }
        }
      }
      if (!found) continue;

      const dueAt = commitmentDueAt(item) as number;
      const overdueDays = Math.max(1, Math.floor((now - dueAt) / DAY_MS));
      try {
        const outcome = await writer.applyCuration({
          workspaceId: found.workspaceId,
          runId: null,
          candidateId: null,
          origin: "auto",
          fingerprint,
          summary: "Closed a commitment that was done",
          rationale: clip(
            `Past due for ${overdueDays} day(s), and later activity says it was done: ` +
              found.evidence.map((entry) => `"${entry.snippet}"`).join("; "),
            2000,
          ),
          allowProtected: false,
          operation: { op: "expire_commitment", itemIds: [item.id] },
        });
        if (outcome.status === "applied") {
          result.expired += 1;
          result.logIds.push(outcome.log.id);
          this.lastSearchedAt.delete(item.id);
        } else {
          result.refused[outcome.reason] = (result.refused[outcome.reason] ?? 0) + 1;
        }
      } catch (error) {
        logger.warn("Could not close a past-due commitment:", error);
        result.refused.error = (result.refused.error ?? 0) + 1;
      }
    }
    return result;
  }

  private async listWorkspaceIds(): Promise<string[]> {
    try {
      return (await this.deps.listWorkspaceIds?.()) ?? [];
    } catch (error) {
      logger.warn("Could not list workspaces for commitment expiry:", error);
      return [];
    }
  }

  private async search(workspaceId: string, item: MemoryItem): Promise<ConversationHit[]> {
    const words = [...commitmentKeywords(item)].slice(0, 6);
    if (words.length === 0) return [];
    const search =
      this.deps.searchConversation ??
      ((params: { workspaceId: string; query: string; limit?: number }) =>
        DurableContextService.searchConversation({ ...params, mode: "any" }));
    try {
      return await search({ workspaceId, query: words.join(" "), limit: 8 });
    } catch {
      return [];
    }
  }
}
