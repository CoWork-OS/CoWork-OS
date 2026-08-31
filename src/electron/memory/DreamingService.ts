import type {
  CuratedMemoryEntry,
  DreamingCandidate,
  DreamingCandidateAction,
  DreamingCandidateTarget,
  DreamingRun,
  DreamingScopeKind,
  DreamingTriggerSource,
  EvidenceRef,
  MemoryObservationSearchResult,
} from "../../shared/types";
import { CuratedMemoryService } from "./CuratedMemoryService";
import { MemoryObservationService } from "./MemoryObservationService";
import {
  TranscriptSearchResult,
  TranscriptSpanRecord,
  TranscriptStore,
  type TranscriptReadGuard,
} from "./TranscriptStore";
import type { DreamingRepository } from "./DreamingRepository";

interface DreamingEvidenceBundle {
  observations: MemoryObservationSearchResult[];
  transcriptHits: TranscriptSearchResult[];
  recentSpans: TranscriptSpanRecord[];
  curatedEntries: CuratedMemoryEntry[];
}

export interface DreamingServiceDeps {
  searchMemoryObservations?: (query: {
    workspaceId: string;
    query?: string;
    limit?: number;
  }) => MemoryObservationSearchResult[];
  searchTranscriptSpans?: (params: {
    workspacePath: string;
    query: string;
    taskId?: string;
    limit?: number;
    readGuard?: TranscriptReadGuard;
  }) => Promise<TranscriptSearchResult[]>;
  loadRecentTranscriptSpans?: (
    workspacePath: string,
    taskId: string,
    limit?: number,
    readGuard?: TranscriptReadGuard,
  ) => Promise<TranscriptSpanRecord[]>;
  listCuratedEntries?: (workspaceId: string) => CuratedMemoryEntry[];
  applyCuratedMemory?: typeof CuratedMemoryService.curate;
  now?: () => number;
}

export interface RunDreamingRequest {
  workspaceId: string;
  workspacePath: string;
  scopeKind?: DreamingScopeKind;
  scopeRef?: string;
  triggerSource: DreamingTriggerSource;
  triggerHeartbeatRunId?: string;
  sourceTaskId?: string;
  taskPrompt?: string;
  instructions?: string;
  readGuard?: TranscriptReadGuard;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeText(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, max: number): string {
  const normalized = normalizeText(value);
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function evidenceFromObservation(observation: MemoryObservationSearchResult): EvidenceRef {
  return {
    evidenceId: observation.memoryId,
    sourceType: "other",
    sourceUrlOrPath: `memory:${observation.memoryId}`,
    snippet: truncate(observation.snippet || observation.title, 260),
    capturedAt: observation.createdAt,
  };
}

function evidenceFromTranscript(hit: TranscriptSearchResult | TranscriptSpanRecord): EvidenceRef {
  const id = hit.eventId || `${hit.taskId}:${hit.timestamp}:${hit.type}`;
  const payload = typeof hit.payload === "string" ? hit.payload : JSON.stringify(hit.payload || {});
  return {
    evidenceId: id,
    sourceType: "tool_output",
    sourceUrlOrPath: `transcript:${hit.taskId}`,
    snippet: truncate(`[${hit.type}] ${payload}`, 260),
    capturedAt: hit.timestamp,
  };
}

function combinedEvidenceText(bundle: DreamingEvidenceBundle): string {
  return [
    ...bundle.observations.map((entry) =>
      [entry.title, entry.subtitle, entry.snippet, entry.concepts?.join(" ")]
        .filter(Boolean)
        .join(" "),
    ),
    ...bundle.transcriptHits.map((entry) => entry.rawLine),
    ...bundle.recentSpans.map((entry) =>
      typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload || {}),
    ),
  ].join("\n");
}

function inferCuratedTarget(action: DreamingCandidateAction): DreamingCandidateTarget {
  if (action.startsWith("curated_")) return "curated_memory";
  if (action === "archive_mark_stale") return "archive_memory";
  if (action === "topic_pack_update") return "topic_pack";
  if (action === "ignored_noise_pattern") return "suggestion_policy";
  return "core_memory";
}

function uniqueCandidates(
  candidates: Array<Omit<DreamingCandidate, "id" | "createdAt">>,
): Array<Omit<DreamingCandidate, "id" | "createdAt">> {
  const seen = new Set<string>();
  const result: Array<Omit<DreamingCandidate, "id" | "createdAt">> = [];
  for (const candidate of candidates) {
    const key = [
      candidate.workspaceId,
      candidate.action,
      candidate.target,
      candidate.currentValue || "",
      candidate.proposedValue.toLowerCase(),
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export class DreamingService {
  constructor(
    private readonly repo: DreamingRepository,
    private readonly deps: DreamingServiceDeps = {},
  ) {}

  async run(
    request: RunDreamingRequest,
  ): Promise<{ run: DreamingRun; candidates: DreamingCandidate[] }> {
    const now = this.deps.now?.() ?? Date.now();
    const run = this.repo.createRun({
      workspaceId: request.workspaceId,
      scopeKind: request.scopeKind || "workspace",
      scopeRef: request.scopeRef || request.workspaceId,
      status: "running",
      triggerSource: request.triggerSource,
      triggerHeartbeatRunId: request.triggerHeartbeatRunId,
      sourceTaskId: request.sourceTaskId,
      instructions: request.instructions,
      evidenceCount: 0,
      candidateCount: 0,
      startedAt: now,
    });

    try {
      const evidence = await this.gatherEvidence(request);
      const candidateInputs = this.proposeCandidates(run, evidence);
      const candidates = this.repo.bulkCreateCandidates(candidateInputs);
      const completed = this.repo.updateRun(run.id, {
        status:
          evidence.observations.length ||
          evidence.transcriptHits.length ||
          evidence.recentSpans.length
            ? "completed"
            : "skipped",
        summary: this.buildRunSummary(evidence, candidates.length),
        evidenceCount:
          evidence.observations.length +
          evidence.transcriptHits.length +
          evidence.recentSpans.length,
        candidateCount: candidates.length,
        completedAt: this.deps.now?.() ?? Date.now(),
      });
      return { run: completed || run, candidates };
    } catch (error) {
      const failed = this.repo.updateRun(run.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: this.deps.now?.() ?? Date.now(),
      });
      return { run: failed || run, candidates: [] };
    }
  }

  async applyAcceptedCandidate(
    candidateId: string,
    workspaceId: string,
  ): Promise<DreamingCandidate | undefined> {
    const candidate = this.repo.findCandidateById(candidateId);
    if (!candidate || candidate.workspaceId !== workspaceId || candidate.status !== "accepted") {
      return candidate;
    }
    if (candidate.target !== "curated_memory") {
      return candidate;
    }
    if (/^Staged pending memory approval \(/.test(candidate.resolution || "")) {
      return candidate;
    }

    const applyCurated =
      this.deps.applyCuratedMemory || CuratedMemoryService.curate.bind(CuratedMemoryService);
    let stagedPendingId: string | undefined;
    if (candidate.action === "curated_add") {
      const result = await applyCurated({
        workspaceId,
        action: "add",
        target: "workspace",
        kind: "project_fact",
        content: candidate.proposedValue,
        reason: candidate.rationale,
        origin: "dreaming",
      });
      stagedPendingId = result.pendingId;
    } else if (candidate.action === "curated_replace") {
      const result = await applyCurated({
        workspaceId,
        action: "replace",
        target: "workspace",
        kind: "project_fact",
        match: candidate.currentValue,
        content: candidate.proposedValue,
        reason: candidate.rationale,
        origin: "dreaming",
      });
      stagedPendingId = result.pendingId;
    } else if (candidate.action === "curated_archive") {
      const result = await applyCurated({
        workspaceId,
        action: "remove",
        target: "workspace",
        match: candidate.currentValue || candidate.proposedValue,
        reason: candidate.rationale,
        origin: "dreaming",
      });
      stagedPendingId = result.pendingId;
    }
    if (stagedPendingId) {
      return this.repo.reviewCandidate({
        id: candidate.id,
        status: "accepted",
        resolution: `Staged pending memory approval (${stagedPendingId}).`,
      });
    }
    return this.repo.reviewCandidate({
      id: candidate.id,
      status: "applied",
      resolution: "Applied by DreamingService.",
    });
  }

  private async gatherEvidence(request: RunDreamingRequest): Promise<DreamingEvidenceBundle> {
    const query = normalizeText(
      request.taskPrompt || request.instructions || "correction memory stale recurring open loop",
    );
    const searchMemoryObservations =
      this.deps.searchMemoryObservations ||
      ((input) =>
        MemoryObservationService.search({
          workspaceId: input.workspaceId,
          query: input.query || "",
          limit: input.limit || 40,
        }));
    const searchTranscriptSpans =
      this.deps.searchTranscriptSpans || TranscriptStore.searchSpans.bind(TranscriptStore);
    const loadRecentTranscriptSpans =
      this.deps.loadRecentTranscriptSpans || TranscriptStore.loadRecentSpans.bind(TranscriptStore);
    const listCuratedEntries =
      this.deps.listCuratedEntries ||
      ((workspaceId) => {
        try {
          return CuratedMemoryService.list(workspaceId, { status: "active", limit: 100 });
        } catch {
          return [];
        }
      });

    const [observations, transcriptHits, recentSpans] = await Promise.all([
      Promise.resolve(
        searchMemoryObservations({ workspaceId: request.workspaceId, query, limit: 40 }),
      ),
      searchTranscriptSpans({
        workspacePath: request.workspacePath,
        taskId: request.sourceTaskId,
        query,
        limit: 20,
        readGuard: request.readGuard,
      }),
      request.sourceTaskId
        ? loadRecentTranscriptSpans(
            request.workspacePath,
            request.sourceTaskId,
            30,
            request.readGuard,
          )
        : Promise.resolve([]),
    ]);

    return {
      observations,
      transcriptHits,
      recentSpans,
      curatedEntries: listCuratedEntries(request.workspaceId),
    };
  }

  private proposeCandidates(
    run: DreamingRun,
    evidence: DreamingEvidenceBundle,
  ): Array<Omit<DreamingCandidate, "id" | "createdAt">> {
    const text = combinedEvidenceText(evidence);
    const normalized = text.toLowerCase();
    const evidenceRefs = [
      ...evidence.observations.slice(0, 10).map(evidenceFromObservation),
      ...evidence.transcriptHits.slice(0, 8).map(evidenceFromTranscript),
      ...evidence.recentSpans.slice(-6).map(evidenceFromTranscript),
    ];
    const candidates: Array<Omit<DreamingCandidate, "id" | "createdAt">> = [];
    const push = (
      action: DreamingCandidateAction,
      proposedValue: string,
      rationale: string,
      confidence: number,
      currentValue?: string,
    ) => {
      candidates.push({
        runId: run.id,
        workspaceId: run.workspaceId,
        action,
        target: inferCuratedTarget(action),
        currentValue,
        proposedValue: truncate(proposedValue, 600),
        rationale: truncate(rationale, 900),
        confidence: clamp(confidence, 0, 1),
        evidenceRefs,
        status: "proposed",
        reviewedAt: undefined,
        resolution: undefined,
      });
    };

    const duplicateEntries = this.findDuplicateCuratedEntries(evidence.curatedEntries);
    for (const duplicate of duplicateEntries) {
      push(
        "curated_archive",
        duplicate.content,
        "Dreaming found a duplicate curated-memory entry. Archive the duplicate and keep one active copy.",
        0.86,
        duplicate.content,
      );
    }

    for (const entry of evidence.curatedEntries) {
      const key = entry.content.toLowerCase();
      if (!key || !normalized.includes(key)) continue;
      if (/\b(no longer|outdated|stale|invalid|replaced by|instead of)\b/i.test(text)) {
        push(
          "curated_archive",
          entry.content,
          "Recent evidence appears to invalidate this curated-memory entry.",
          0.78,
          entry.content,
        );
      }
    }

    if (
      /\b(correction|corrected|actually|instead|should have|wrong assumption|invalidated)\b/i.test(
        text,
      )
    ) {
      push(
        "correction",
        "A recent correction should be reviewed for durable memory promotion.",
        "Dreaming saw correction language in recent memory/session evidence.",
        0.8,
      );
    }

    if (
      /\b(todo|follow up|follow-up|blocked|needs review|open loop|waiting on|next action)\b/i.test(
        text,
      )
    ) {
      push(
        "open_loop",
        "Recent work contains an unresolved open loop that may need tracking.",
        "Dreaming found unresolved follow-up or blocker language in recent evidence.",
        0.76,
      );
    }

    if (/\b(every|daily|weekly|monthly|recurring|cadence|schedule|cron)\b/i.test(text)) {
      push(
        "recurring_task",
        "A workflow may be recurring and should be considered for routine or heartbeat tracking.",
        "Dreaming found cadence language in recent evidence.",
        0.72,
      );
    }

    if (/\b(dismissed|ignored|low signal|noise|not useful|false positive)\b/i.test(text)) {
      push(
        "ignored_noise_pattern",
        "Similar low-signal suggestions should be deprioritized.",
        "Dreaming found ignored-noise feedback in recent evidence.",
        0.74,
      );
    }

    if (/\b(do not|never|avoid|required|must|constraint|policy|approval|private)\b/i.test(text)) {
      push(
        "constraint",
        "A durable operating constraint may need memory review.",
        "Dreaming found policy or constraint language in recent evidence.",
        0.7,
      );
    }

    if (!candidates.length && evidence.observations.length >= 5) {
      push(
        "topic_pack_update",
        "Recent memory evidence is dense enough to consider refreshing a topic pack.",
        "Dreaming found several related memory observations but no specific safe memory mutation.",
        0.58,
      );
    }

    return uniqueCandidates(candidates).filter((candidate) => candidate.evidenceRefs.length > 0);
  }

  private findDuplicateCuratedEntries(entries: CuratedMemoryEntry[]): CuratedMemoryEntry[] {
    const seen = new Set<string>();
    const duplicates: CuratedMemoryEntry[] = [];
    for (const entry of entries) {
      const key = `${entry.target}:${entry.kind}:${normalizeText(entry.content).toLowerCase()}`;
      if (seen.has(key)) {
        duplicates.push(entry);
      } else {
        seen.add(key);
      }
    }
    return duplicates;
  }

  private buildRunSummary(evidence: DreamingEvidenceBundle, candidateCount: number): string {
    const evidenceCount =
      evidence.observations.length + evidence.transcriptHits.length + evidence.recentSpans.length;
    if (!evidenceCount) {
      return "Dreaming found no recent memory/session evidence in scope.";
    }
    return `Dreaming reviewed ${evidenceCount} evidence item(s) and proposed ${candidateCount} candidate(s).`;
  }
}
