/**
 * Memory Hub "Review" for `memory_items`: the commitments CommitmentExpiryService closed
 * automatically, with undo (docs/memory-repo-phase3-design.md §6).
 *
 * Callers pass the workspace the Hub is showing; a log entry of another workspace, or one
 * that is not a commitment expiry, is reported as not found.
 */
import type {
  MemoryCurationChange,
  MemoryReviewMutationResult,
  MemoryReviewState,
} from "../../shared/memory-review-types";
import type { MemoryCurationRepository } from "./MemoryCurationRepository";
import type { MemoryWriter } from "./MemoryWriter";
import type { CurationLogEntry, CurationSnapshot } from "./memory-curation-sql";

const MAX_RECENT = 30;
/** Log rows read to find the recent expiries (older curator operations are skipped). */
const LOG_SCAN = 200;

export class MemoryReviewError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "unavailable",
  ) {
    super(message);
    this.name = "MemoryReviewError";
  }
}

export interface MemoryReviewDeps {
  curation: Pick<MemoryCurationRepository, "listLog" | "findLog">;
  getWriter: () => MemoryWriter | null;
}

const REFUSAL_MESSAGES: Record<string, string> = {
  changed: "This commitment changed since; undo is no longer possible.",
  conflict: "Undoing would clash with a memory added since.",
  already_undone: "This change was already undone.",
  missing: "This change no longer exists.",
};

function isExpiry(log: CurationLogEntry): boolean {
  return log.op === "expire_commitment";
}

function statusLabel(snapshot: CurationSnapshot | undefined): string | null {
  return snapshot ? snapshot.status : null;
}

export class MemoryReviewService {
  constructor(private readonly deps: MemoryReviewDeps) {}

  private writer(): MemoryWriter {
    const writer = this.deps.getWriter();
    if (!writer?.supportsCuration) {
      throw new MemoryReviewError("The memory engine is not running yet.", "unavailable");
    }
    return writer;
  }

  async state(workspaceId: string): Promise<MemoryReviewState> {
    const writer = this.deps.getWriter();
    return { recent: writer ? await this.recent(workspaceId, writer) : [] };
  }

  private async recent(workspaceId: string, writer: MemoryWriter): Promise<MemoryCurationChange[]> {
    const logs = (await this.deps.curation.listLog(workspaceId, LOG_SCAN))
      .filter(isExpiry)
      .slice(0, MAX_RECENT);
    const changes: MemoryCurationChange[] = [];
    for (const log of logs) {
      changes.push({
        id: log.id,
        op: "expire_commitment",
        origin: log.origin,
        summary: log.summary,
        rationale: log.rationale,
        items: this.changeItems(log),
        appliedAt: log.appliedAt,
        undoneAt: log.undoneAt,
        canUndo: log.undoneAt === null && (await this.unchangedSince(log, writer)),
      });
    }
    return changes;
  }

  private changeItems(log: CurationLogEntry): MemoryCurationChange["items"] {
    const before = new Map(log.before.map((entry) => [entry.id, entry]));
    return log.after.map((after) => ({
      id: after.id,
      kind: after.kind as MemoryCurationChange["items"][number]["kind"],
      content: after.content || before.get(after.id)?.content || "",
      before: statusLabel(before.get(after.id)),
      after: after.status,
    }));
  }

  private async unchangedSince(log: CurationLogEntry, writer: MemoryWriter): Promise<boolean> {
    for (const expected of log.after) {
      const current = await writer.repository.findById(expected.id);
      if (
        !current ||
        current.status !== expected.status ||
        current.updatedAt !== expected.updatedAt
      ) {
        return false;
      }
    }
    return true;
  }

  async undo(workspaceId: string, logId: string): Promise<MemoryReviewMutationResult> {
    const log = await this.deps.curation.findLog(logId);
    if (!log || log.workspaceId !== workspaceId || !isExpiry(log)) {
      throw new MemoryReviewError("Change not found.", "not_found");
    }
    const outcome = await this.writer().undoCuration(logId, workspaceId);
    if (outcome.status !== "undone") {
      const message = REFUSAL_MESSAGES[outcome.reason] ?? "It could not be undone.";
      return { success: false, error: message, reason: outcome.reason };
    }
    return { success: true, message: "Undone. This commitment will not be closed automatically again." };
  }
}
