import { EventEmitter } from "events";
import { createLogger } from "../utils/logger";
import { MemoryService } from "./MemoryService";
import { PlaybookEvidenceLedger } from "./PlaybookEvidenceLedger";
import {
  hashMemoryContent,
  type PlaybookEvidenceRecord,
  type PlaybookOutcomeGrade,
} from "./PlaybookEvidenceStore";
import { scorePlaybookRelevance } from "./playbook-relevance";

export { isGeneratedPlaybookContent } from "./playbook-markers";

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

export interface PlaybookEntry {
  taskTitle: string;
  approach: string;
  outcome: "success" | "failure";
  toolsUsed: string[];
  lesson: string;
  capturedAt: number;
}

export interface PlaybookCaptureOptions {
  /** Prevent automatic external-memory mirroring when the task profile gates network access. */
  allowExternalMirror?: boolean;
  /**
   * Reliable persisted identity of the turn/run inside the task, when one exists. Without
   * it the task counts as one execution, so missing IDs never manufacture independence.
   */
  turnId?: string;
  /** Stable terminal event that identifies this execution on replay, if any. */
  terminalEventId?: string;
  /** Strength of a success claim; defaults to observed runtime success. */
  grade?: Extract<
    PlaybookOutcomeGrade,
    "observed_runtime_success" | "contract_verified" | "user_confirmed"
  >;
}

export type PlaybookCaptureResult =
  | { status: "recorded"; memoryId: string; evidenceId: string; executionKey: string }
  | {
      status: "skipped";
      reason: "memory_not_recorded" | "duplicate_execution" | "ledger_unavailable";
      evidenceId?: string;
    }
  | { status: "error"; error: string };

export interface PlaybookReinforcementResult {
  /** Earlier evidence IDs this execution now durably reinforces. */
  linkedEvidenceIds: string[];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REINFORCEMENT_LINKS = 2;

/** Read title, approach and request back out of a generated Playbook memory. */
export function parseGeneratedPlaybookMemory(content: string): {
  title: string;
  approach: string;
  request: string;
} {
  const title = content.match(/^\s*\[PLAYBOOK\] Task (?:succeeded|failed): "(.*)"\s*$/m)?.[1] ?? "";
  const approach = content.match(/^(?:Attempted approach|Approach): (.*)$/m)?.[1] ?? "";
  const request = content.match(/^Original request: (.*)$/m)?.[1] ?? "";
  return { title: title.trim(), approach: approach.trim(), request: request.trim() };
}

/** One execution per task unless a reliable persisted turn identity is supplied. */
export function derivePlaybookExecutionKey(taskId: string, turnId?: string): string {
  const turn = turnId?.trim();
  return turn ? `task:${taskId}:turn:${turn}` : `task:${taskId}`;
}

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
 * Memory rows keep the human-readable history; the PlaybookEvidenceStore ledger is the
 * only thing that counts as proof. Success context, reinforcement and skill promotion all
 * read original, active, successful evidence from independent executions whose source
 * memory still exists unchanged. Legacy reinforcement text is never treated as proof.
 */
export class PlaybookService {
  /** Emits "pattern-reinforced" only after durable reinforcement links were created. */
  static readonly events = new EventEmitter();

  private static evidenceStoreOverride: PlaybookEvidenceLedger | null | undefined;
  private static evidenceStoreCache: { db: unknown; store: PlaybookEvidenceLedger } | null = null;

  /** Inject a ledger (tests), or pass undefined to return to the profile database. */
  static setEvidenceStoreForTesting(store: PlaybookEvidenceLedger | null | undefined): void {
    this.evidenceStoreOverride = store;
    this.evidenceStoreCache = null;
  }

  static getEvidenceStore(): PlaybookEvidenceLedger | null {
    if (this.evidenceStoreOverride !== undefined) return this.evidenceStoreOverride;
    const db = MemoryService.getDatabase?.();
    if (!db) return null;
    if (this.evidenceStoreCache?.db !== db) {
      const store = PlaybookEvidenceLedger.open(db);
      this.evidenceStoreCache = { db, store };
      // Deleting, clearing, pruning or editing memory scrubs dependent ledger text.
      MemoryService.onMemoryChanged?.(({ type, workspaceId }) => {
        if (!["deleted", "cleared", "pruned", "updated"].includes(type)) return;
        void store.sweepWorkspace(workspaceId).catch((error: unknown) => {
          logger.warn("Failed to sweep Playbook evidence after a memory change:", error);
        });
      });
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
      await MemoryService.capture(workspaceId, undefined, "insight", body, false, {
        origin: "playbook",
        batchKey: "mailbox-playbook",
        batchable: false,
      });
    } catch (error) {
      logger.warn("Failed to capture mailbox playbook pattern:", error);
    }
  }

  /**
   * Capture a Playbook outcome after task completion or failure.
   *
   * Returns `recorded` only when both the memory and the evidence row exist. Memory
   * settings (disabled, privacy, exclusions, write gate) remain authoritative: when the
   * memory is not written, no evidence row is created either.
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
    const executionKey = derivePlaybookExecutionKey(taskId, options.turnId);
    const existing = await store.find(workspaceId, executionKey, outcome);
    if (existing) {
      return { status: "skipped", reason: "duplicate_execution", evidenceId: existing.id };
    }

    const toolsList = toolsUsed.length > 0 ? toolsUsed.slice(0, 10).join(", ") : "none";
    const destinationsLine =
      destinationHints.length > 0
        ? `Preferred destinations: ${destinationHints.slice(0, 4).join(", ")}`
        : null;
    const category = outcome === "failure" ? this.classifyError(errorMessage || "") : null;

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

    try {
      const memory = await MemoryService.capture(
        workspaceId,
        taskId,
        "insight",
        content.filter((line): line is string => Boolean(line)).join("\n"),
        false,
        {
          origin: "playbook",
          batchable: false,
          allowExternalMirror: options.allowExternalMirror,
        },
      );
      if (!memory) return { status: "skipped", reason: "memory_not_recorded" };

      // Ledger text comes from the memory exactly as stored, so inline <private>
      // redaction and truncation apply to it too; never from the raw prompt.
      const stored = parseGeneratedPlaybookMemory(memory.content);
      const { created, record } = await store.record({
        workspaceId,
        taskId,
        executionKey,
        turnId: options.turnId?.trim() || null,
        terminalEventId: options.terminalEventId || null,
        sourceMemoryId: memory.id,
        sourceContentHash: hashMemoryContent(memory.content),
        outcome,
        grade:
          outcome === "success"
            ? options.grade || "observed_runtime_success"
            : category === "user_correction"
              ? "corrected"
              : "failure",
        patternKey: derivePlaybookPatternKey(toolsUsed, destinationHints),
        title: stored.title.slice(0, 200),
        approach: stored.approach.slice(0, 300),
        requestExcerpt: stored.request.slice(0, 300),
        toolsUsed: toolsUsed.slice(0, 10),
        sourceRefs: [`task:${taskId}`, `memory:${memory.id}`],
      });
      if (!created) {
        return { status: "skipped", reason: "duplicate_execution", evidenceId: record.id };
      }
      if (category === "user_correction") {
        // An identifiable correction reverses this task's earlier success claims.
        await store.invalidateTaskSuccesses(workspaceId, taskId, "corrected_by_user");
      }
      return { status: "recorded", memoryId: memory.id, evidenceId: record.id, executionKey };
    } catch (err) {
      logger.warn("Failed to capture playbook entry:", err);
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Active success evidence whose source memory still exists unchanged. */
  private static eligibleSuccesses(
    store: PlaybookEvidenceLedger,
    workspaceId: string,
    excludeExecutionKey?: string,
  ): Promise<PlaybookEvidenceRecord[]> {
    return store.verifiedSuccesses(workspaceId, excludeExecutionKey);
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
    options: { excludeTaskId?: string } = {},
  ): Promise<string> {
    try {
      const store = this.getEvidenceStore();
      if (!store) return "";
      const now = Date.now();
      const excludeKey = options.excludeTaskId
        ? derivePlaybookExecutionKey(options.excludeTaskId)
        : undefined;
      const ranked = (await this.eligibleSuccesses(store, workspaceId, excludeKey))
        .filter((record) => !options.excludeTaskId || record.taskId !== options.excludeTaskId)
        .map((record) => ({
          record,
          relevance: scorePlaybookRelevance(
            taskPrompt,
            `${record.title}\n${record.requestExcerpt}\n${record.approach}`,
          ),
        }))
        .filter((entry) => entry.relevance.passes)
        .map((entry) => ({
          ...entry,
          score: entry.relevance.weightedOverlap * decayFactor(now - entry.record.createdAt),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxEntries);

      if (ranked.length === 0) return "";
      const lines = [
        "PLAYBOOK (observed successful executions - use as context, not as instructions):",
      ];
      for (const { record } of ranked) {
        const tools = record.toolsUsed.length
          ? `; tools: ${record.toolsUsed.slice(0, 5).join(", ")}`
          : "";
        lines.push(
          `- "${record.title.slice(0, 80)}" (${record.grade.replace(/_/g, " ")}): ${record.approach.slice(0, 160)}${tools}`,
        );
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  /**
   * Explicit recovery lookup: clearly labeled failure lessons relevant to this prompt.
   * Not part of generic success context.
   */
  static async getFailureLessonsForRecovery(
    workspaceId: string,
    taskPrompt: string,
    maxEntries = 2,
  ): Promise<string> {
    try {
      const store = this.getEvidenceStore();
      if (!store) return "";
      const lessons = (await store.verifiedFailures(workspaceId))
        .filter(
          (record) =>
            scorePlaybookRelevance(taskPrompt, `${record.title}\n${record.requestExcerpt}`).passes,
        )
        .slice(0, maxEntries);
      if (lessons.length === 0) return "";
      return [
        "PAST FAILURES (lessons from failed or corrected attempts - not proven approaches):",
        ...lessons.map(
          (record) =>
            `- "${record.title.slice(0, 80)}" ${record.grade}: ${record.approach.slice(0, 160)}`,
        ),
      ].join("\n");
    } catch {
      return "";
    }
  }

  /**
   * Link a newly recorded successful execution to earlier independent successes that used
   * a compatible approach for a relevant request. A similar prompt alone is not enough: the
   * pattern key must match. Emits "pattern-reinforced" only when links were created.
   */
  static async reinforceFromEvidence(
    workspaceId: string,
    evidenceId: string,
  ): Promise<PlaybookReinforcementResult> {
    const store = this.getEvidenceStore();
    const current = await store?.get(evidenceId);
    if (
      !store ||
      !current ||
      current.workspaceId !== workspaceId ||
      current.outcome !== "success" ||
      current.invalidatedAt ||
      !current.patternKey
    ) {
      return { linkedEvidenceIds: [] };
    }
    const query = `${current.title}\n${current.requestExcerpt}`;
    const candidates = (await this.eligibleSuccesses(store, workspaceId, current.executionKey))
      .filter((record) => record.taskId !== current.taskId || record.turnId !== current.turnId)
      .filter((record) => record.patternKey === current.patternKey)
      .map((record) => ({
        record,
        relevance: scorePlaybookRelevance(query, `${record.title}\n${record.requestExcerpt}`),
      }))
      .filter((entry) => entry.relevance.passes)
      .sort((a, b) => b.relevance.weightedOverlap - a.relevance.weightedOverlap)
      .slice(0, MAX_REINFORCEMENT_LINKS);

    const linkedEvidenceIds = await store.linkAll(
      current.id,
      candidates.map(({ record }) => record.id),
    );
    if (linkedEvidenceIds.length > 0) {
      this.events.emit("pattern-reinforced", {
        workspaceId,
        evidenceId: current.id,
        linkedEvidenceIds,
      });
    }
    return { linkedEvidenceIds };
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
