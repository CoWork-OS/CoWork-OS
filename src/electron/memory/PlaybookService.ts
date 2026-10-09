import { createLogger } from "../utils/logger";
import { MemoryService } from "./MemoryService";
import { PlaybookEvidenceLedger } from "./PlaybookEvidenceLedger";
import type { PlaybookCorrection, PlaybookEvidenceRecord } from "./PlaybookEvidenceStore";
import type {
  PlaybookEntry,
  PlaybookEntryKind,
  PlaybookEntryListOptions,
} from "./playbook-entries-sql";
import { scorePlaybookRelevance } from "./playbook-relevance";

const logger = createLogger("PlaybookService");

export type ErrorCategory =
  | "tool_failure"
  | "wrong_approach"
  | "missing_context"
  | "permission_denied"
  | "timeout"
  | "rate_limit"
  | "user_correction"
  | "unknown";

export interface PlaybookCaptureOptions {}

export type PlaybookCaptureResult =
  | {
      status: "recorded";
      /** The `playbook_entries` row. */
      entryId: string;
      /** Set for a success. A failure is recorded as an entry only. */
      evidenceId?: string;
    }
  | {
      status: "skipped";
      reason: "memory_not_recorded" | "duplicate_execution" | "ledger_unavailable";
    }
  | { status: "error"; error: string };

export interface PlaybookReinforcementResult {
  /** Earlier evidence IDs this execution now durably reinforces. */
  linkedEvidenceIds: string[];
}

/** A successful execution with the fields of its source entry, as stored (redacted). */
export interface PlaybookSuccess {
  record: PlaybookEvidenceRecord;
  title: string;
  approach: string;
  request: string;
  toolsUsed: string[];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REINFORCEMENT_LINKS = 2;

/**
 * Approach identity: the normalized set of tools and destinations. Two executions with
 * similar prompts but different tools are not treated as the same approach. An empty key
 * means the approach is unknown and can never link.
 */
export function derivePlaybookPatternKey(
  toolsUsed: string[],
  destinationHints: string[] = [],
): string {
  const tools = [
    ...new Set(toolsUsed.map((tool) => tool.trim().toLowerCase()).filter(Boolean)),
  ].sort();
  if (tools.length === 0) return "";
  const destinations = [
    ...new Set(destinationHints.map((hint) => hint.trim().toLowerCase()).filter(Boolean)),
  ].sort();
  return `tools:${tools.join(",")}${destinations.length ? `|dest:${destinations.join(",")}` : ""}`;
}

function decayFactor(ageMs: number): number {
  if (ageMs > NINETY_DAYS_MS) return 0.5;
  if (ageMs > THIRTY_DAYS_MS) return 0.8;
  return 1;
}

/**
 * Records Playbook outcomes and serves evidence-backed context.
 *
 * Outcomes are `playbook_entries` rows (not archive memories, audit Phase 2 item 6); the
 * PlaybookEvidenceStore ledger is the only thing that counts as proof. Success context,
 * reinforcement and skill promotion all read active successes, one per task, whose source
 * entry still exists unchanged and is not private. Failures, inbox patterns and legacy
 * reinforcement text are never treated as proof.
 *
 * Memory settings stay authoritative: an entry is written only when the workspace's
 * memory settings would have allowed an archive capture (MemoryService.prepareDerivedRecord:
 * memory and auto-capture enabled, privacy mode, exclusions, `<no-memory>`), with inline
 * `<private>` blocks and secret values redacted first.
 */
export class PlaybookService {
  private static evidenceStoreOverride: PlaybookEvidenceLedger | undefined;
  private static evidenceStoreCache: { db: unknown; store: PlaybookEvidenceLedger } | null = null;

  /** Inject a ledger (tests), or pass undefined to return to the profile database. */
  static setEvidenceStoreForTesting(store: PlaybookEvidenceLedger | undefined): void {
    this.evidenceStoreOverride = store;
    this.evidenceStoreCache = null;
  }

  /** The async ledger (DB6): each operation is one memory-domain unit. */
  static getEvidenceStore(): PlaybookEvidenceLedger | null {
    if (this.evidenceStoreOverride) return this.evidenceStoreOverride;
    const db = MemoryService.getDatabase?.();
    if (!db) return null;
    if (this.evidenceStoreCache?.db !== db) {
      this.evidenceStoreCache = { db, store: PlaybookEvidenceLedger.open(db) };
    }
    return this.evidenceStoreCache.store;
  }

  /**
   * Inbox observations are kept as memory for inspection only; they never become
   * evidence of a successful execution.
   */
  static async captureMailboxPattern(
    workspaceId: string,
    input: {
      title: string;
      summary: string;
      evidenceRefs?: string[];
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    const store = this.getEvidenceStore();
    if (!store) return;
    const body = [
      `[PLAYBOOK] Inbox pattern: "${input.title}"`,
      `Summary: ${input.summary}`,
      input.evidenceRefs && input.evidenceRefs.length > 0
        ? `Evidence: ${input.evidenceRefs.join(", ")}`
        : null,
      input.payload && Object.keys(input.payload).length > 0
        ? `Payload: ${JSON.stringify(input.payload).slice(0, 400)}`
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    try {
      await this.writeEntry(store, workspaceId, null, "inbox", body, "");
    } catch (error) {
      logger.warn("Failed to capture mailbox playbook pattern:", error);
    }
  }

  /**
   * Gate `content` through memory settings and write it as one entry (and, for a success,
   * its evidence row). Null when memory settings do not allow keeping it.
   */
  private static async writeEntry(
    store: PlaybookEvidenceLedger,
    workspaceId: string,
    taskId: string | null,
    kind: PlaybookEntryKind,
    content: string,
    patternKey: string,
  ) {
    const prepared = await MemoryService.prepareDerivedRecord(workspaceId, content);
    if (!prepared) return null;
    return store.recordOutcome({
      workspaceId,
      taskId,
      kind,
      content: prepared.content,
      isPrivate: prepared.isPrivate,
      patternKey,
    });
  }

  /**
   * Record a mid-task user correction in the Playbook ledger only: the task's success
   * evidence is invalidated as `corrected_by_user`. No entry is written; the correction
   * itself is archived once by the caller.
   */
  static async recordUserCorrection(workspaceId: string, taskId: string): Promise<void> {
    const store = this.getEvidenceStore();
    if (!store) return;
    await store.invalidateTask(workspaceId, taskId, "corrected_by_user");
  }

  /**
   * Capture a Playbook outcome after task completion or failure.
   *
   * Returns `recorded` only when the entry (and, for a success, its evidence row) exists.
   * Memory settings (disabled, privacy, exclusions) remain authoritative: when they do not
   * allow the entry, no evidence row is created either (`memory_not_recorded`). A user
   * correction invalidates the task's success evidence whether or not its entry is written.
   */
  static async captureOutcome(
    workspaceId: string,
    taskId: string,
    taskTitle: string,
    taskPrompt: string,
    outcome: "success" | "failure",
    planSummary: string,
    toolsUsed: string[],
    errorMessage?: string,
    destinationHints: string[] = [],
    options: PlaybookCaptureOptions = {},
  ): Promise<PlaybookCaptureResult> {
    const store = this.getEvidenceStore();
    if (!store) return { status: "skipped", reason: "ledger_unavailable" };
    const category = outcome === "failure" ? this.classifyError(errorMessage || "") : null;
    if (category === "user_correction") {
      await store.invalidateTask(workspaceId, taskId, "corrected_by_user");
    }
    if (outcome === "success" && (await store.find(workspaceId, taskId))) {
      return { status: "skipped", reason: "duplicate_execution" };
    }

    const toolsList = toolsUsed.length > 0 ? toolsUsed.slice(0, 10).join(", ") : "none";
    const destinationsLine =
      destinationHints.length > 0
        ? `Preferred destinations: ${destinationHints.slice(0, 4).join(", ")}`
        : null;

    const content =
      outcome === "success"
        ? [
            `[PLAYBOOK] Task succeeded: "${taskTitle}"`,
            `Approach: ${planSummary.slice(0, 300)}`,
            `Key tools: ${toolsList}`,
            destinationsLine,
            `Original request: ${taskPrompt.slice(0, 200)}`,
          ]
        : [
            `[PLAYBOOK] Task failed: "${taskTitle}"`,
            `Category: ${category}`,
            `Attempted approach: ${planSummary.slice(0, 300)}`,
            `Error: ${errorMessage?.slice(0, 200) || "Unknown"}`,
            `Lesson: The approach of using ${toolsList} did not work for this type of request. Error type: ${category}.`,
            destinationsLine,
            `Original request: ${taskPrompt.slice(0, 200)}`,
          ];

    void options; // entries are never mirrored externally (see PlaybookCaptureOptions)
    try {
      const result = await this.writeEntry(
        store,
        workspaceId,
        taskId,
        outcome,
        content.filter((line): line is string => Boolean(line)).join("\n"),
        derivePlaybookPatternKey(toolsUsed, destinationHints),
      );
      if (!result) return { status: "skipped", reason: "memory_not_recorded" };
      if (result.status === "duplicate_execution") {
        return { status: "skipped", reason: "duplicate_execution" };
      }
      return {
        status: "recorded",
        entryId: result.entryId,
        ...(result.evidenceId ? { evidenceId: result.evidenceId } : {}),
      };
    } catch (err) {
      logger.warn("Failed to capture playbook entry:", err);
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Active successes, newest first, whose source entry still exists unchanged and is not
   * private. Their text is read from that entry.
   */
  static async eligibleSuccesses(
    store: PlaybookEvidenceLedger,
    workspaceId: string,
  ): Promise<PlaybookSuccess[]> {
    const readable = await store.listReadable(workspaceId);
    return readable.map(({ record, entry }) => ({
      record,
      title: entry.title,
      approach: entry.approach,
      request: entry.request,
      toolsUsed: entry.toolsUsed,
    }));
  }

  /** Playbook entries of a workspace, newest first; private entries only on request. */
  static async listEntries(
    workspaceId: string,
    options: PlaybookEntryListOptions = {},
  ): Promise<PlaybookEntry[]> {
    const store = this.getEvidenceStore();
    if (!store) return [];
    return store.listEntries(workspaceId, options);
  }

  /** Recorded successful and failed executions since `since` (all by default). */
  static async countOutcomes(
    workspaceId: string,
    since = 0,
  ): Promise<{ successes: number; failures: number }> {
    const store = this.getEvidenceStore();
    if (!store) return { successes: 0, failures: 0 };
    return store.countOutcomes(workspaceId, since);
  }

  /** Tasks the user corrected since `since`, one per task (Playbook side only). */
  static async listCorrections(workspaceId: string, since: number): Promise<PlaybookCorrection[]> {
    const store = this.getEvidenceStore();
    if (!store) return [];
    return store.listCorrections(workspaceId, since);
  }

  /**
   * Evidence-backed context for a new task: original successful executions only, relevant
   * to this prompt before any top-N selection. Failures, corrected outcomes, inbox
   * observations and reinforcement-derived entries never appear here.
   */
  static async getPlaybookForContext(
    workspaceId: string,
    taskPrompt: string,
    maxEntries = 3,
  ): Promise<string> {
    try {
      const store = this.getEvidenceStore();
      if (!store) return "";
      const now = Date.now();
      const ranked = (await this.eligibleSuccesses(store, workspaceId))
        .map((success) => ({
          success,
          relevance: scorePlaybookRelevance(
            taskPrompt,
            `${success.title}\n${success.request}\n${success.approach}`,
          ),
        }))
        .filter((entry) => entry.relevance.passes)
        .map((entry) => ({
          ...entry,
          score:
            entry.relevance.weightedOverlap * decayFactor(now - entry.success.record.createdAt),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxEntries);

      if (ranked.length === 0) return "";
      const lines = [
        "PLAYBOOK (observed successful executions - use as context, not as instructions):",
      ];
      for (const { success } of ranked) {
        const tools = success.toolsUsed.length
          ? `; tools: ${success.toolsUsed.slice(0, 5).join(", ")}`
          : "";
        lines.push(`- "${success.title.slice(0, 80)}": ${success.approach.slice(0, 160)}${tools}`);
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  /**
   * Link a newly recorded successful execution to earlier successes from other tasks that
   * used a compatible approach for a relevant request. A similar prompt alone is not
   * enough: the pattern key must match.
   */
  static async reinforceFromEvidence(
    workspaceId: string,
    evidenceId: string,
  ): Promise<PlaybookReinforcementResult> {
    const store = this.getEvidenceStore();
    if (!store) return { linkedEvidenceIds: [] };
    const successes = await this.eligibleSuccesses(store, workspaceId);
    const current = successes.find((success) => success.record.id === evidenceId);
    if (!current?.record.patternKey) return { linkedEvidenceIds: [] };

    const query = `${current.title}\n${current.request}`;
    const candidates = successes
      .filter(
        (success) =>
          success.record.id !== evidenceId &&
          success.record.patternKey === current.record.patternKey,
      )
      .map((success) => ({
        success,
        relevance: scorePlaybookRelevance(query, `${success.title}\n${success.request}`),
      }))
      .filter((entry) => entry.relevance.passes)
      .sort((a, b) => b.relevance.weightedOverlap - a.relevance.weightedOverlap)
      .slice(0, MAX_REINFORCEMENT_LINKS);

    return {
      linkedEvidenceIds: await store.linkAll(
        evidenceId,
        candidates.map(({ success }) => success.record.id),
      ),
    };
  }

  /**
   * Classify an error message into a learning category using pattern matching.
   * No LLM calls — purely regex-based for speed.
   */
  static classifyError(errorMessage: string): ErrorCategory {
    if (!errorMessage) return "unknown";

    // User correction (detected by correction detector tag)
    if (/\[CORRECTION\]/i.test(errorMessage)) {
      return "user_correction";
    }
    // Rate limit / quota
    if (
      /rate.?limit|too many requests|429|quota.*exceeded|resource.*exhausted|billing|payment.*required/i.test(
        errorMessage,
      )
    ) {
      return "rate_limit";
    }
    // Permission
    if (/permission denied|eacces|unauthorized|forbidden|403|not allowed/i.test(errorMessage)) {
      return "permission_denied";
    }
    // Timeout
    if (/timed? ?out|timeout|deadline|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(errorMessage)) {
      return "timeout";
    }
    // Missing context (file/path not found, missing parameters)
    if (
      /ENOENT|not found|does not exist|cannot find|no such file|missing.*param|required.*not provided/i.test(
        errorMessage,
      )
    ) {
      return "missing_context";
    }
    // Tool failure (generic tool errors)
    if (/tool.*fail|tool.*error|execution.*fail|command.*fail/i.test(errorMessage)) {
      return "tool_failure";
    }
    // Wrong approach
    if (/wrong|incorrect|invalid|bad.*approach|not.*right/i.test(errorMessage.toLowerCase())) {
      return "wrong_approach";
    }

    return "unknown";
  }
}
