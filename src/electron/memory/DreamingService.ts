/**
 * Dreaming — the curator of `memory_items` (docs/memory-engine.md §9, audit §8.2).
 *
 * A run reads the workspace's active items (and global items), recent archive outcomes and
 * corrections, and conversation evidence of finished commitments; MemoryCurator turns them
 * into proposals, and an optional, budgeted LLM synthesis step adds more. Then:
 *
 *   - safe proposals are applied through MemoryWriter (one audited, undoable operation
 *     each, at most MAX_AUTO_APPLY per run);
 *   - everything else is queued in `dreaming_candidates` for the Memory Hub Review tab.
 *
 * Proposals the user rejected, and changes the user undid, are never proposed again.
 * At most one run per workspace is in progress, and automatic triggers are spaced by
 * DREAMING_WORKSPACE_COOLDOWN_MS. Per-run counts and LLM tokens go to `dreaming_runs`.
 */
import type {
  DreamingCandidate,
  DreamingRun,
  DreamingScopeKind,
  DreamingTriggerSource,
  EvidenceRef,
  MemoryFeaturesSettings,
} from "../../shared/types";
import type { MemoryReviewEvidence } from "../../shared/memory-review-types";
import { createLogger } from "../utils/logger";
import type { DreamingRepository } from "./DreamingRepository";
import { DurableContextService, type ConversationHit } from "./DurableContextService";
import { MemoryCurationRepository } from "./MemoryCurationRepository";
import { clip, contentWords, curateMemory, type CurationProposal } from "./MemoryCurator";
import { MemoryWriter, type MemoryCandidate } from "./MemoryWriter";
import type { ArchiveEvidenceRow } from "./memory-curation-sql";
import {
  CURATION_LLM_DEFAULT_DAILY_BUDGET,
  createProviderCurationLlmClient,
  runCurationSynthesis,
  type CurationLlmClient,
} from "./memory-curation-llm";
import type { MemoryItem } from "./memory-items-types";
import type { TranscriptReadGuard } from "./TranscriptStore";

const logger = createLogger("Dreaming");

/** Minimum spacing between automatic Dreaming runs of one workspace. */
export const DREAMING_WORKSPACE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** Interval of the idle curation the Heartbeat pulse runs per active workspace. */
export const DREAMING_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A workspace with a task created within this window gets the daily idle curation. */
export const MEMORY_CURATION_ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Archive outcomes older than this are not considered for promotion. */
export const DREAMING_ARCHIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Safe operations applied per run; the rest wait for the next run. */
export const MAX_AUTO_APPLY = 25;
/** Proposals queued for review per run. */
export const MAX_QUEUED = 20;
/** Overdue commitments checked against the conversation index per run. */
const MAX_DONE_SIGNAL_LOOKUPS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const DONE_WORDS =
  /\b(done|completed?|finished|sent|shipped|resolved|delivered|submitted|closed|merged|paid)\b/i;

/** Candidate statuses that keep a curator proposal from being proposed again. */
const BLOCKING_CANDIDATE_STATUSES = new Set<DreamingCandidate["status"]>([
  "proposed",
  "accepted",
  "rejected",
  "dismissed",
]);

export type DreamingSkipReason = "cooldown" | "in_flight";

export interface DreamingRunResult {
  run: DreamingRun;
  /** Proposals queued for review by this run. */
  candidates: DreamingCandidate[];
  /** Operations applied automatically by this run (curation log ids). */
  appliedLogIds?: string[];
  /**
   * Set when this request did not start a run: `run` is then the recent run (cooldown) or the
   * overlapping run (in_flight).
   */
  skipped?: DreamingSkipReason;
}

export interface RunDreamingRequest {
  workspaceId: string;
  workspacePath: string;
  scopeKind?: DreamingScopeKind;
  scopeRef?: string;
  triggerSource: DreamingTriggerSource;
  triggerHeartbeatRunId?: string;
  sourceTaskId?: string;
  /** Recorded on the run for context only; never sent to the model. */
  taskPrompt?: string;
  instructions?: string;
  readGuard?: TranscriptReadGuard;
  /** Run even within the workspace cooldown. Manual triggers always bypass it. */
  bypassCooldown?: boolean;
}

/** The curation store reads Dreaming needs (MemoryCurationRepository). */
export type DreamingCurationPort = Pick<
  MemoryCurationRepository,
  "archiveEvidence" | "llmTokensSince" | "undoneFingerprints"
>;

export interface DreamingServiceDeps {
  now?: () => number;
  /** The process-wide writer (defaults to `MemoryWriter.get()`). */
  getWriter?: () => MemoryWriter | null;
  /** Defaults to a repository over the Dreaming repository's database. */
  curation?: DreamingCurationPort;
  /** Conversation index search (defaults to `DurableContextService.searchConversation`). */
  searchConversation?: (params: {
    workspaceId: string;
    query: string;
    limit?: number;
  }) => Promise<ConversationHit[]>;
  /** Memory feature settings (the LLM switch and budget). */
  getSettings?: () => Pick<
    MemoryFeaturesSettings,
    "dreamingLlmEnabled" | "dreamingLlmDailyTokenBudget"
  > | null;
  /** LLM client for synthesis (defaults to the configured provider). */
  llmClient?: CurationLlmClient | null;
}

/** Runs in progress per workspace, shared by every trigger and service instance. */
const inFlightRunsByWorkspace = new Map<string, Promise<DreamingRunResult>>();

function evidenceRef(evidence: MemoryReviewEvidence, now: number): EvidenceRef {
  return {
    evidenceId: evidence.ref,
    sourceType: evidence.kind === "conversation" ? "tool_output" : "other",
    sourceUrlOrPath: evidence.taskId ? `${evidence.ref}#task:${evidence.taskId}` : evidence.ref,
    snippet: evidence.snippet,
    capturedAt: evidence.at ?? now,
  };
}

function operationSummary(proposal: CurationProposal): string {
  const operation = proposal.operation;
  switch (operation.op) {
    case "merge":
      return `Merged ${operation.mergeIds.length + 1} near-duplicate items`;
    case "resolve_conflict":
      return "Resolved a contradiction";
    case "promote":
      return `Learned a recurring ${operation.kind.replace("_", " ")} from ${operation.taskIds.length} tasks`;
    case "decay":
      return "Archived an unused item";
    case "expire_commitment":
      return "Closed a commitment that was done";
  }
}

/** The MemoryWriter candidate of a promotion: an inferred workspace fact. */
export function promotionCandidate(
  workspaceId: string,
  proposal: CurationProposal,
  runId: string | null,
): MemoryCandidate | null {
  const operation = proposal.operation;
  if (operation.op !== "promote") return null;
  return {
    content: operation.content,
    kind: operation.kind,
    scope: "workspace",
    workspaceId,
    source: "inferred",
    sourceRef: {
      store: "dreaming",
      id: proposal.fingerprint,
      ...(runId ? { runId } : {}),
      reason: "recurring_outcome",
      taskIds: operation.taskIds,
      aliases: operation.evidenceIds.map((id) => `archive:${id}`),
    },
    confidence: proposal.confidence,
  };
}

export class DreamingService {
  private readonly curation: DreamingCurationPort;

  constructor(
    private readonly repo: DreamingRepository,
    private readonly deps: DreamingServiceDeps = {},
  ) {
    this.curation = deps.curation ?? new MemoryCurationRepository(repo.statementPort);
  }

  /**
   * Run Dreaming for a workspace. At most one run per workspace is in progress at a time (an
   * overlapping request shares the running one), and automatic triggers are spaced by
   * DREAMING_WORKSPACE_COOLDOWN_MS.
   */
  async run(request: RunDreamingRequest): Promise<DreamingRunResult> {
    const inFlight = inFlightRunsByWorkspace.get(request.workspaceId);
    if (inFlight) {
      const shared = await inFlight;
      return { run: shared.run, candidates: [], skipped: "in_flight" };
    }
    let release!: () => void;
    const execution = (async (): Promise<DreamingRunResult> => {
      const recent =
        request.bypassCooldown || request.triggerSource === "manual"
          ? undefined
          : await this.findRunWithinCooldown(request.workspaceId);
      if (recent) return { run: recent, candidates: [], skipped: "cooldown" };
      return this.execute(request);
    })().finally(() => release());
    release = () => {
      if (inFlightRunsByWorkspace.get(request.workspaceId) === execution) {
        inFlightRunsByWorkspace.delete(request.workspaceId);
      }
    };
    inFlightRunsByWorkspace.set(request.workspaceId, execution);
    return execution;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private writer(): MemoryWriter | null {
    return this.deps.getWriter ? this.deps.getWriter() : MemoryWriter.get();
  }

  private async findRunWithinCooldown(workspaceId: string): Promise<DreamingRun | undefined> {
    const now = this.now();
    const runs = await this.repo.listRuns({ workspaceId, limit: 10 });
    return runs.find(
      (run) =>
        run.status !== "failed" &&
        now - (run.startedAt || run.createdAt) < DREAMING_WORKSPACE_COOLDOWN_MS,
    );
  }

  private async execute(request: RunDreamingRequest): Promise<DreamingRunResult> {
    const run = await this.repo.createRun({
      workspaceId: request.workspaceId,
      scopeKind: request.scopeKind || "workspace",
      scopeRef: request.scopeRef || request.workspaceId,
      status: "running",
      triggerSource: request.triggerSource,
      triggerHeartbeatRunId: request.triggerHeartbeatRunId,
      sourceTaskId: request.sourceTaskId,
      instructions: request.instructions ? clip(request.instructions, 2000) : undefined,
      evidenceCount: 0,
      candidateCount: 0,
      startedAt: this.now(),
    });

    try {
      const writer = this.writer();
      if (!writer?.supportsCuration) {
        return await this.finishSkipped(
          run,
          "The memory engine is not running; nothing was curated.",
        );
      }
      if (!(await writer.repository.isLaneMigrationComplete())) {
        return await this.finishSkipped(
          run,
          "Memory items are still being migrated; curation starts after the migration.",
        );
      }
      return await this.curate(run, request, writer);
    } catch (error) {
      logger.warn("Dreaming run failed:", error);
      const failed = await this.repo.updateRun(run.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: this.now(),
      });
      return { run: failed || run, candidates: [] };
    }
  }

  private async finishSkipped(run: DreamingRun, summary: string): Promise<DreamingRunResult> {
    const updated = await this.repo.updateRun(run.id, {
      status: "skipped",
      summary,
      completedAt: this.now(),
    });
    return { run: updated || run, candidates: [] };
  }

  private async curate(
    run: DreamingRun,
    request: RunDreamingRequest,
    writer: MemoryWriter,
  ): Promise<DreamingRunResult> {
    const now = this.now();
    const workspaceId = request.workspaceId;
    const items = (
      await writer.repository.list({
        workspaceId,
        includeGlobal: true,
        statuses: ["active"],
        includePrivate: true,
        limit: 2000,
      })
    ).filter((item) => item.scope === "global" || item.scope === "workspace");
    const archive = await this.curation.archiveEvidence(
      workspaceId,
      now - DREAMING_ARCHIVE_WINDOW_MS,
      300,
    );
    const doneSignals = await this.findDoneSignals(workspaceId, items, now);

    const stats: Record<string, number> = {};
    const count = (key: string, by = 1) => {
      stats[key] = (stats[key] ?? 0) + by;
    };
    const proposals = curateMemory({ now, items, archive, doneSignals });
    count("heuristic_proposals", proposals.length);

    let llmTokens = 0;
    let llmCalls = 0;
    const settings = this.settings();
    if (settings.llmEnabled) {
      const client = this.deps.llmClient ?? createProviderCurationLlmClient();
      const used = await this.curation.llmTokensSince(now - DAY_MS);
      const synthesis = await runCurationSynthesis({
        client,
        workspaceId,
        items,
        archive,
        remainingTokens: settings.budget - used,
      });
      llmTokens = synthesis.tokens;
      llmCalls = synthesis.calls;
      count("llm_proposals", synthesis.proposals.length);
      if (synthesis.rejected) count("llm_rejected", synthesis.rejected);
      if (synthesis.skipped) count(`llm_${synthesis.skipped}`);
      const known = new Set(proposals.map((proposal) => proposal.fingerprint));
      for (const proposal of synthesis.proposals) {
        if (!known.has(proposal.fingerprint)) proposals.push(proposal);
      }
    }

    const blocked = await this.blockedFingerprints(workspaceId);
    const open = proposals.filter((proposal) => {
      if (!blocked.has(proposal.fingerprint)) return true;
      count("blocked");
      return false;
    });

    const appliedLogIds: string[] = [];
    const toQueue: CurationProposal[] = [];
    for (const proposal of open) {
      if (proposal.risk !== "safe") {
        toQueue.push(proposal);
        continue;
      }
      if (appliedLogIds.length >= MAX_AUTO_APPLY) {
        count("deferred");
        continue;
      }
      const outcome = await this.applySafe(writer, workspaceId, run.id, proposal);
      if (outcome.applied) {
        appliedLogIds.push(outcome.logId);
        count(`applied_${proposal.operation.op}`);
      } else {
        count(`refused_${outcome.reason}`);
      }
    }

    const queuedInputs = toQueue
      .slice(0, MAX_QUEUED)
      .map((proposal) => this.candidateInput(run, proposal, now));
    if (toQueue.length > MAX_QUEUED) count("queue_overflow", toQueue.length - MAX_QUEUED);
    const candidates = queuedInputs.length
      ? await this.repo.bulkCreateCandidates(queuedInputs)
      : [];

    const evidenceCount = items.length + archive.length;
    const summary =
      `Dreaming reviewed ${items.length} memory item(s) and ${archive.length} archive outcome(s): ` +
      `applied ${appliedLogIds.length} safe change(s) and queued ${candidates.length} for review.`;
    const completed = await this.repo.updateRun(run.id, {
      status: "completed",
      summary,
      evidenceCount,
      candidateCount: candidates.length,
      appliedCount: appliedLogIds.length,
      queuedCount: candidates.length,
      llmTokens,
      llmCalls,
      stats,
      completedAt: this.now(),
    });
    return { run: completed || run, candidates, appliedLogIds };
  }

  private settings(): { llmEnabled: boolean; budget: number } {
    let settings: ReturnType<NonNullable<DreamingServiceDeps["getSettings"]>> = null;
    try {
      settings = this.deps.getSettings?.() ?? null;
    } catch {
      settings = null;
    }
    const budget = settings?.dreamingLlmDailyTokenBudget;
    return {
      llmEnabled: settings?.dreamingLlmEnabled === true && this.deps.llmClient !== null,
      budget:
        typeof budget === "number" && Number.isFinite(budget) && budget > 0
          ? Math.floor(budget)
          : CURATION_LLM_DEFAULT_DAILY_BUDGET,
    };
  }

  private async blockedFingerprints(workspaceId: string): Promise<Set<string>> {
    const [candidates, undone] = await Promise.all([
      this.repo.listCandidates({ workspaceId, target: "memory_items", limit: 500 }),
      this.curation.undoneFingerprints(workspaceId),
    ]);
    const blocked = new Set(undone);
    for (const candidate of candidates) {
      if (candidate.fingerprint && BLOCKING_CANDIDATE_STATUSES.has(candidate.status)) {
        blocked.add(candidate.fingerprint);
      }
    }
    return blocked;
  }

  private async applySafe(
    writer: MemoryWriter,
    workspaceId: string,
    runId: string,
    proposal: CurationProposal,
  ): Promise<{ applied: true; logId: string } | { applied: false; reason: string }> {
    const operation = proposal.operation;
    const common = {
      workspaceId,
      runId,
      candidateId: null,
      origin: "auto" as const,
      fingerprint: proposal.fingerprint,
      summary: operationSummary(proposal),
      rationale: proposal.rationale,
      allowProtected: false,
    };
    try {
      const outcome =
        operation.op === "promote"
          ? await writer.applyCuration({
              ...common,
              operation: {
                op: "promote",
                candidate: promotionCandidate(workspaceId, proposal, runId) as MemoryCandidate,
              },
            })
          : await writer.applyCuration({ ...common, operation });
      if (outcome.status === "applied") return { applied: true, logId: outcome.log.id };
      return { applied: false, reason: outcome.reason };
    } catch (error) {
      logger.warn("Dreaming could not apply a curation operation:", error);
      return { applied: false, reason: "error" };
    }
  }

  private candidateInput(
    run: DreamingRun,
    proposal: CurationProposal,
    now: number,
  ): Omit<DreamingCandidate, "id" | "createdAt"> {
    const operation = proposal.operation;
    return {
      runId: run.id,
      workspaceId: run.workspaceId,
      action: `memory_${operation.op}` as DreamingCandidate["action"],
      target: "memory_items",
      proposedValue: operation.op === "promote" ? operation.content : proposal.title,
      rationale: clip(proposal.rationale, 900),
      confidence: Math.max(0, Math.min(1, proposal.confidence)),
      evidenceRefs: proposal.evidence.slice(0, 12).map((entry) => evidenceRef(entry, now)),
      status: "proposed",
      operation: operation as unknown as Record<string, unknown>,
      reviewReason: proposal.reviewReason ?? undefined,
      origin: proposal.origin,
      fingerprint: proposal.fingerprint,
    };
  }

  /**
   * Conversation evidence that overdue commitments were done: index hits after the due
   * window that share the commitment's words and say "done", "sent", "shipped", ….
   */
  private async findDoneSignals(
    workspaceId: string,
    items: MemoryItem[],
    now: number,
  ): Promise<Map<string, MemoryReviewEvidence[]>> {
    const signals = new Map<string, MemoryReviewEvidence[]>();
    const search =
      this.deps.searchConversation ??
      ((params: { workspaceId: string; query: string; limit?: number }) =>
        DurableContextService.searchConversation({ ...params, mode: "any" }));
    const overdue = items
      .filter(
        (item) =>
          item.kind === "commitment" &&
          typeof item.sourceRef.dueAt === "number" &&
          item.sourceRef.dueAt < now - DAY_MS,
      )
      .slice(0, MAX_DONE_SIGNAL_LOOKUPS);
    for (const item of overdue) {
      const dueAt = item.sourceRef.dueAt as number;
      const words = [...contentWords(item.content)].slice(0, 6);
      if (words.length === 0) continue;
      let hits: ConversationHit[] = [];
      try {
        hits = await search({ workspaceId, query: words.join(" "), limit: 8 });
      } catch {
        continue;
      }
      const keywords = new Set(words);
      const done = hits
        .filter((hit) => {
          if (hit.timestamp < dueAt - 7 * DAY_MS || !DONE_WORDS.test(hit.snippet)) return false;
          const hitWords = contentWords(hit.snippet);
          let shared = 0;
          for (const word of keywords) if (hitWords.has(word)) shared += 1;
          return shared >= Math.min(2, keywords.size);
        })
        .slice(0, 3)
        .map((hit): MemoryReviewEvidence => ({
          kind: "conversation",
          ref: `event:${hit.eventId ?? hit.id}`,
          snippet: clip(hit.snippet, 240),
          at: hit.timestamp,
          taskId: hit.taskId,
        }));
      if (done.length > 0) signals.set(item.id, done);
    }
    return signals;
  }
}

/** Archive rows' shape, re-exported for tests and callers that build curator inputs. */
export type { ArchiveEvidenceRow };
