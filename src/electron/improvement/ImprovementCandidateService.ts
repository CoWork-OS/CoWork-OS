import fs from "fs";
import path from "path";
import crypto from "crypto";
import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";
import type {
  ImprovementCandidate,
  ImprovementCandidateReadiness,
  ImprovementCandidateSource,
  ImprovementEvidence,
  ImprovementFailureClass,
} from "../../shared/types";
import { getImprovementResetBaselineAt } from "./ImprovementHistoryState";
import { ImprovementCandidateRepository } from "./ImprovementRepositories";
import { ImprovementRunRepository } from "./ImprovementRepositories";
import { ImprovementSettingsManager } from "./ImprovementSettingsManager";

const RECENT_WINDOW_DAYS = 14;
const MAX_EVIDENCE_ITEMS = 8;
const PROVIDER_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DETERMINISTIC_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_FAILURE_STREAK_BEFORE_PARK = 3;

export class ImprovementCandidateService {
  private readonly candidateRepo: ImprovementCandidateRepository;
  private readonly runRepo: ImprovementRunRepository;
  private readonly taskRepo: TaskRepository;
  private readonly workspaceRepo: WorkspaceRepository;
  private started = false;

  constructor(private readonly db: Database.Database) {
    this.candidateRepo = new ImprovementCandidateRepository(db);
    this.runRepo = new ImprovementRunRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
  }

  async start(agentDaemon: AgentDaemon): Promise<void> {
    if (this.started) return;
    this.started = true;

    agentDaemon.on("task_completed", (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      void this.ingestTaskFailureCandidate(taskId);
    });

    agentDaemon.on("verification_failed", (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      void this.ingestEventCandidate(taskId, "verification_failure", evt);
    });

    agentDaemon.on("safety_stop_triggered", (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      void this.ingestEventCandidate(taskId, "task_failure", evt);
    });

    agentDaemon.on("user_feedback", (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      void this.ingestFeedbackCandidate(taskId, evt);
    });

    await this.refresh();
  }

  async refresh(): Promise<{ candidateCount: number }> {
    await this.rebuildFromRecentSignals();
    await this.ingestDevLogs();
    this.reconcileExistingCandidates();
    return {
      candidateCount: this.listCandidates().length,
    };
  }

  listCandidates(workspaceId?: string): ImprovementCandidate[] {
    return this.candidateRepo.list({ workspaceId });
  }

  dismissCandidate(candidateId: string): ImprovementCandidate | undefined {
    const existing = this.candidateRepo.findById(candidateId);
    if (!existing) return undefined;
    const readiness = this.deriveReadiness({ ...existing, status: "dismissed", resolvedAt: Date.now() });
    this.candidateRepo.update(candidateId, {
      status: "dismissed",
      readiness: readiness.readiness,
      readinessReason: readiness.reason,
      resolvedAt: Date.now(),
    });
    return this.candidateRepo.findById(candidateId);
  }

  markCandidateRunning(candidateId: string): void {
    const existing = this.candidateRepo.findById(candidateId);
    const readiness = existing
      ? this.deriveReadiness({ ...existing, status: "running", lastExperimentAt: Date.now(), resolvedAt: undefined })
      : undefined;
    this.candidateRepo.update(candidateId, {
      status: "running",
      readiness: readiness?.readiness,
      readinessReason: readiness?.reason,
      lastExperimentAt: Date.now(),
      resolvedAt: null as Any,
    });
  }

  markCandidateReview(candidateId: string): void {
    const existing = this.candidateRepo.findById(candidateId);
    const readiness = existing
      ? this.deriveReadiness({ ...existing, status: "review", resolvedAt: Date.now() })
      : undefined;
    this.candidateRepo.update(candidateId, {
      status: "review",
      readiness: readiness?.readiness,
      readinessReason: readiness?.reason,
      resolvedAt: Date.now(),
    });
  }

  markCandidateResolved(candidateId: string): void {
    const existing = this.candidateRepo.findById(candidateId);
    const readiness = existing
      ? this.deriveReadiness({ ...existing, status: "resolved", resolvedAt: Date.now() })
      : undefined;
    this.candidateRepo.update(candidateId, {
      status: "resolved",
      readiness: readiness?.readiness,
      readinessReason: readiness?.reason,
      resolvedAt: Date.now(),
    });
  }

  reopenCandidate(candidateId: string): void {
    const existing = this.candidateRepo.findById(candidateId);
    const reopened = existing
      ? ({
          ...existing,
          status: "open",
          cooldownUntil: undefined,
          parkReason: undefined,
          parkedAt: undefined,
          resolvedAt: undefined,
        } satisfies ImprovementCandidate)
      : undefined;
    const readiness = reopened ? this.deriveReadiness(reopened) : undefined;
    this.candidateRepo.update(candidateId, {
      status: "open",
      readiness: readiness?.readiness,
      readinessReason: readiness?.reason,
      cooldownUntil: null as Any,
      parkReason: null as Any,
      parkedAt: null as Any,
      resolvedAt: null as Any,
    });
  }

  markCandidateParked(candidateId: string, reason: string): void {
    const existing = this.candidateRepo.findById(candidateId);
    const parked = existing
      ? ({
          ...existing,
          status: "parked",
          parkReason: reason,
          parkedAt: Date.now(),
          resolvedAt: Date.now(),
        } satisfies ImprovementCandidate)
      : undefined;
    const readiness = parked ? this.deriveReadiness(parked) : undefined;
    this.candidateRepo.update(candidateId, {
      status: "parked",
      readiness: readiness?.readiness,
      readinessReason: readiness?.reason,
      parkReason: reason,
      parkedAt: Date.now(),
      resolvedAt: Date.now(),
    });
  }

  recordCandidateSkip(candidateId: string, reason: string): void {
    const candidate = this.candidateRepo.findById(candidateId);
    if (!candidate) return;
    const withSkip: ImprovementCandidate = {
      ...candidate,
      lastSkipReason: reason,
      lastSkipAt: Date.now(),
    };
    const readiness = this.deriveReadiness(withSkip, reason);
    this.candidateRepo.update(candidateId, {
      lastSkipReason: reason,
      lastSkipAt: withSkip.lastSkipAt,
      readiness: readiness.readiness,
      readinessReason: readiness.reason,
    });
  }

  recordCampaignFailure(
    candidateId: string,
    params: { failureClass: ImprovementFailureClass; attemptFingerprint: string; reason?: string },
  ): void {
    const candidate = this.candidateRepo.findById(candidateId);
    if (!candidate) return;

    const sameFingerprint =
      candidate.lastAttemptFingerprint &&
      candidate.lastAttemptFingerprint === params.attemptFingerprint;
    const failureStreak = sameFingerprint ? (candidate.failureStreak || 0) + 1 : 1;
    const cooldownMs = this.isProviderFailure(params.failureClass)
      ? PROVIDER_FAILURE_COOLDOWN_MS
      : DETERMINISTIC_FAILURE_COOLDOWN_MS;
    const now = Date.now();
    const shouldPark = sameFingerprint && failureStreak >= MAX_FAILURE_STREAK_BEFORE_PARK;

    const nextCandidate: ImprovementCandidate = {
      ...candidate,
      status: shouldPark ? "parked" : "open",
      failureStreak,
      cooldownUntil: shouldPark ? undefined : now + cooldownMs,
      parkReason: shouldPark ? params.reason || params.failureClass : undefined,
      parkedAt: shouldPark ? now : undefined,
      lastAttemptFingerprint: params.attemptFingerprint,
      lastFailureClass: params.failureClass,
      lastExperimentAt: now,
      resolvedAt: shouldPark ? now : undefined,
    };
    const readiness = this.deriveReadiness(nextCandidate);

    this.candidateRepo.update(candidateId, {
      status: shouldPark ? "parked" : "open",
      readiness: readiness.readiness,
      readinessReason: readiness.reason,
      failureStreak,
      cooldownUntil: shouldPark ? null as Any : now + cooldownMs,
      parkReason: shouldPark ? params.reason || params.failureClass : null as Any,
      parkedAt: shouldPark ? now : null as Any,
      lastAttemptFingerprint: params.attemptFingerprint,
      lastFailureClass: params.failureClass,
      lastExperimentAt: now,
      resolvedAt: shouldPark ? now : null as Any,
    });
  }

  getTopCandidateForWorkspace(workspaceId: string): ImprovementCandidate | undefined {
    const settings = ImprovementSettingsManager.loadSettings();
    return this.candidateRepo.getTopRunnableCandidate(
      workspaceId,
      settings.maxOpenCandidatesPerWorkspace,
    );
  }

  private async rebuildFromRecentSignals(): Promise<void> {
    const baseline = getImprovementResetBaselineAt() || 0;
    const since = Math.max(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000, baseline);
    const recentTasks = this.db
      .prepare(
        `
        SELECT id
        FROM tasks
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT 300
      `,
      )
      .all(since) as Array<{ id: string }>;

    for (const task of recentTasks) {
      await this.ingestTaskFailureCandidate(task.id);
    }

    const eventRows = this.db
      .prepare(
        `
        SELECT task_id, type, payload, id, timestamp
        FROM task_events
        WHERE timestamp >= ?
          AND COALESCE(legacy_type, type) IN ('verification_failed', 'safety_stop_triggered', 'user_feedback')
        ORDER BY timestamp DESC
        LIMIT 400
      `,
      )
      .all(since) as Any[];

    for (const row of eventRows) {
      const taskId = typeof row.task_id === "string" ? row.task_id : "";
      if (!taskId) continue;
      const payload = this.parsePayload(row.payload);
      const effectiveType = typeof row.type === "string" ? row.type : "";
      if (effectiveType === "user_feedback") {
        await this.ingestFeedbackCandidate(taskId, payload);
      } else if (effectiveType === "verification_failed") {
        await this.ingestEventCandidate(taskId, "verification_failure", {
          ...payload,
          eventId: row.id,
          timestamp: row.timestamp,
        });
      } else {
        await this.ingestEventCandidate(taskId, "task_failure", {
          ...payload,
          eventId: row.id,
          timestamp: row.timestamp,
        });
      }
    }
  }

  private async ingestTaskFailureCandidate(taskId: string): Promise<void> {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.source === "improvement") return;

    const failureClass = String(task.failureClass || "unknown");
    const summary =
      typeof task.resultSummary === "string" && task.resultSummary.trim()
        ? task.resultSummary.trim()
        : task.error
          ? String(task.error)
          : `Task ended with ${failureClass}`;
    if (!this.shouldIngestTaskFailure(task.status, task.terminalStatus, summary, failureClass)) {
      return;
    }
    const evidence: ImprovementEvidence = {
      type: "task_failure",
      taskId: task.id,
      summary: this.truncate(summary),
      details: this.truncate(task.prompt, 800),
      createdAt: Date.now(),
      metadata: {
        failureClass,
        terminalStatus: task.terminalStatus,
        title: task.title,
      },
    };

    // Build a stable fingerprint key from structured metadata so all failures
    // of the same class (e.g. contract_unmet_write_required) within a workspace
    // merge into one candidate, rather than creating a new entry for every task
    // whose LLM result-summary happens to be phrased differently.
    const normalizedTitle = this.normalizeTaskTitleForFingerprint(task.title);
    const blockerSignature = this.extractFailureSignature(summary, failureClass);
    const fingerprintKey = `${failureClass}:${normalizedTitle}:${blockerSignature}`;

    this.upsertCandidate(task.workspaceId, {
      source: "task_failure",
      title: `Fix repeated ${failureClass.replace(/_/g, " ")} failures`,
      summary: this.truncate(summary),
      evidence,
      lastTaskId: task.id,
      lastEventType: "task_completed",
      severity: this.inferTaskSeverity(task.failureClass, task.terminalStatus),
      fixabilityScore: this.inferFixabilityScore("task_failure", summary),
      fingerprintKey,
    });
  }

  private async ingestEventCandidate(
    taskId: string,
    source: ImprovementCandidateSource,
    payload: Any,
  ): Promise<void> {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.source === "improvement") return;

    const summary =
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : typeof payload?.verdict === "string" && payload.verdict.trim()
          ? payload.verdict.trim()
          : `Task ${task.title} triggered ${source}`;
    const evidence: ImprovementEvidence = {
      type: source,
      taskId: task.id,
      eventType: source === "verification_failure" ? "verification_failed" : "safety_stop_triggered",
      eventId: typeof payload?.eventId === "string" ? payload.eventId : undefined,
      summary: this.truncate(summary),
      details:
        typeof payload?.verdict === "string"
          ? this.truncate(payload.verdict, 1000)
          : typeof payload?.message === "string"
            ? this.truncate(payload.message, 1000)
            : undefined,
      createdAt: typeof payload?.timestamp === "number" ? payload.timestamp : Date.now(),
      metadata: {
        title: task.title,
      },
    };

    // The title for each event source is always one of two fixed strings, so
    // using `source` alone as the fingerprint key groups all events of the same
    // type into a single candidate per workspace (they are already workspace-
    // scoped by workspaceId, so no cross-workspace merging occurs).
    this.upsertCandidate(task.workspaceId, {
      source,
      title:
        source === "verification_failure"
          ? "Fix verifier-detected regressions"
          : "Fix safety-stop and no-progress loops",
      summary: this.truncate(summary),
      evidence,
      lastTaskId: task.id,
      lastEventType: evidence.eventType,
      severity: source === "verification_failure" ? 0.95 : 0.72,
      fixabilityScore: this.inferFixabilityScore(source, summary),
      fingerprintKey:
        source === "verification_failure"
          ? "verification_failure"
          : this.extractFailureSignature(summary, source),
    });
  }

  private async ingestFeedbackCandidate(taskId: string, payload: Any): Promise<void> {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.source === "improvement") return;

    const decision = typeof payload?.decision === "string" ? payload.decision.trim() : "";
    const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
    if ((decision !== "rejected" && decision !== "edit") || !reason) {
      return;
    }

    const evidence: ImprovementEvidence = {
      type: "user_feedback",
      taskId: task.id,
      eventType: "user_feedback",
      summary: this.truncate(reason),
      details: this.truncate(task.resultSummary || task.prompt, 900),
      createdAt: Date.now(),
      metadata: {
        decision,
        title: task.title,
      },
    };

    this.upsertCandidate(task.workspaceId, {
      source: "user_feedback",
      title: "Fix issues repeatedly flagged by the user",
      summary: this.truncate(reason),
      evidence,
      lastTaskId: task.id,
      lastEventType: "user_feedback",
      severity: decision === "rejected" ? 0.9 : 0.75,
      fixabilityScore: this.inferFixabilityScore("user_feedback", reason),
    });
  }

  private async ingestDevLogs(): Promise<void> {
    const settings = ImprovementSettingsManager.loadSettings();
    if (!settings.includeDevLogs) return;
    const baseline = getImprovementResetBaselineAt() || 0;

    for (const workspace of this.workspaceRepo.findAll()) {
      const logPath = path.join(workspace.path, "logs", "dev-latest.log");
      if (!fs.existsSync(logPath)) continue;
      if (baseline > 0) {
        try {
          const stat = fs.statSync(logPath);
          if (stat.mtimeMs < baseline) continue;
        } catch {
          continue;
        }
      }
      let content = "";
      try {
        content = fs.readFileSync(logPath, "utf8");
      } catch {
        continue;
      }
      const lines = content
        .split(/\r?\n/)
        .filter((line) => /error|exception|failed|uncaught/i.test(line))
        .slice(-8);
      if (lines.length === 0) continue;
      const summary = lines[lines.length - 1].trim();
      const evidence: ImprovementEvidence = {
        type: "dev_log",
        summary: this.truncate(summary),
        details: this.truncate(lines.join("\n"), 1200),
        createdAt: Date.now(),
        metadata: {
          logPath,
        },
      };
      this.upsertCandidate(workspace.id, {
        source: "dev_log",
        title: "Investigate recurring dev log errors",
        summary: this.truncate(summary),
        evidence,
        severity: 0.78,
        fixabilityScore: this.inferFixabilityScore("dev_log", summary),
        fingerprintKey: this.normalizeDevLogSignature(summary),
      });
    }
  }

  private upsertCandidate(
    workspaceId: string,
    input: {
      source: ImprovementCandidateSource;
      title: string;
      summary: string;
      evidence: ImprovementEvidence;
      lastTaskId?: string;
      lastEventType?: string;
      severity: number;
      fixabilityScore: number;
      /** When provided, used as the hash input instead of `summary`.
       *  Pass stable structured data (e.g. `failureClass:normalizedTitle`) so
       *  that semantically identical failures always map to the same candidate
       *  regardless of how the LLM words its result summary each time. */
      fingerprintKey?: string;
    },
  ): ImprovementCandidate {
    const fingerprint = this.buildFingerprint(input.source, input.fingerprintKey ?? input.summary);
    const existing = this.candidateRepo.findByFingerprint(workspaceId, fingerprint);
    const nextPriority = this.computePriorityScore(
      input.severity,
      (existing?.recurrenceCount || 0) + 1,
      input.fixabilityScore,
    );

    if (existing) {
      const duplicateEvidence = existing.evidence.some(
        (item) => this.getEvidenceKey(item) === this.getEvidenceKey(input.evidence),
      );
      if (duplicateEvidence) {
        return existing;
      }
      const evidence = [...existing.evidence, input.evidence]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-MAX_EVIDENCE_ITEMS);
      const nextStatus =
        existing.status === "dismissed"
          ? "dismissed"
          : existing.status === "running" || existing.status === "review" || existing.status === "parked"
            ? existing.status
            : "open";
      const nextCandidate: ImprovementCandidate = {
        ...existing,
        status: nextStatus,
        title: input.title,
        summary: input.summary,
        severity: Math.max(existing.severity, input.severity),
        recurrenceCount: existing.recurrenceCount + 1,
        fixabilityScore: Math.max(existing.fixabilityScore, input.fixabilityScore),
        priorityScore: nextPriority,
        evidence,
        lastTaskId: input.lastTaskId || existing.lastTaskId,
        lastEventType: input.lastEventType || existing.lastEventType,
        lastSeenAt: input.evidence.createdAt,
        resolvedAt: nextStatus === "open" ? undefined : existing.resolvedAt,
      };
      const readiness = this.deriveReadiness(nextCandidate);
      this.candidateRepo.update(existing.id, {
        status: nextStatus,
        readiness: readiness.readiness,
        readinessReason: readiness.reason,
        title: input.title,
        summary: input.summary,
        severity: Math.max(existing.severity, input.severity),
        recurrenceCount: existing.recurrenceCount + 1,
        fixabilityScore: Math.max(existing.fixabilityScore, input.fixabilityScore),
        priorityScore: nextPriority,
        evidence,
        lastTaskId: input.lastTaskId || existing.lastTaskId,
        lastEventType: input.lastEventType || existing.lastEventType,
        lastSeenAt: input.evidence.createdAt,
        resolvedAt: nextStatus === "open" ? null as Any : existing.resolvedAt,
      });
      return this.candidateRepo.findById(existing.id)!;
    }

    const createdCandidate: ImprovementCandidate = {
      // Temporary placeholder used only for readiness derivation before repository create() assigns the real id.
      id: "pending",
      workspaceId,
      fingerprint,
      source: input.source,
      status: "open",
      title: input.title,
      summary: input.summary,
      severity: input.severity,
      recurrenceCount: 1,
      fixabilityScore: input.fixabilityScore,
      priorityScore: nextPriority,
      evidence: [input.evidence],
      lastTaskId: input.lastTaskId,
      lastEventType: input.lastEventType,
      firstSeenAt: input.evidence.createdAt,
      lastSeenAt: input.evidence.createdAt,
    };
    const readiness = this.deriveReadiness(createdCandidate);

    return this.candidateRepo.create({
      workspaceId,
      fingerprint,
      source: input.source,
      status: "open",
      readiness: readiness.readiness,
      readinessReason: readiness.reason,
      title: input.title,
      summary: input.summary,
      severity: input.severity,
      recurrenceCount: 1,
      fixabilityScore: input.fixabilityScore,
      priorityScore: nextPriority,
      evidence: [input.evidence],
      lastTaskId: input.lastTaskId,
      lastEventType: input.lastEventType,
    });
  }

  private buildFingerprint(source: ImprovementCandidateSource, summary: string): string {
    const normalized = summary.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 220);
    return crypto.createHash("sha1").update(`${source}:${normalized}`).digest("hex");
  }

  private computePriorityScore(severity: number, recurrenceCount: number, fixabilityScore: number): number {
    return Number((severity * 0.55 + Math.min(1, recurrenceCount / 5) * 0.25 + fixabilityScore * 0.2).toFixed(4));
  }

  private inferFixabilityScore(source: ImprovementCandidateSource, summary: string): number {
    const normalized = summary.toLowerCase();
    if (/provider quota|quota|429|rate limit|budget exhausted/.test(normalized)) return 0.35;
    if (/timed out|timeout|request cancelled|fetch failed|server_error|application crashed/.test(normalized)) {
      return 0.5;
    }
    if (/test|repro|stack|trace|contract|verification|assert/.test(normalized)) return 0.95;
    if (source === "user_feedback") return 0.72;
    if (source === "dev_log") return 0.8;
    return 0.85;
  }

  private inferTaskSeverity(
    failureClass?: string | null,
    terminalStatus?: string,
  ): number {
    if (/required_verification|contract_error|required_contract/i.test(String(failureClass || ""))) {
      return 0.9;
    }
    if (terminalStatus === "failed") return 0.82;
    if (terminalStatus === "partial_success") return 0.62;
    return 0.7;
  }

  private isProviderFailure(failureClass: ImprovementFailureClass): boolean {
    return failureClass.startsWith("provider_");
  }

  private shouldIngestTaskFailure(
    status: string | null | undefined,
    terminalStatus: string | null | undefined,
    summary: string,
    failureClass: string,
  ): boolean {
    if (status === "failed" || terminalStatus === "failed") {
      return true;
    }
    if (terminalStatus !== "partial_success") {
      return false;
    }
    const normalizedSummary = summary.toLowerCase();
    if (
      /(^|\s)(##\s*)?(✅|step complete|task complete|heartbeat complete|verification result|execution summary|status:\s*linked)/.test(
        normalizedSummary,
      )
    ) {
      return false;
    }
    const normalized = `${failureClass} ${summary}`.toLowerCase();
    if (
      /blocked|failed|failure|timed out|timeout|incomplete|unresolved|budget exhausted|quota|rate limit|mutation-required|cannot|unable|missing|error/.test(
        normalized,
      )
    ) {
      return true;
    }
    return false;
  }

  private reconcileExistingCandidates(): void {
    const candidates = this.candidateRepo.list();
    for (const candidate of candidates) {
      if (candidate.status !== "open") continue;

      if (this.isLikelySuccessOnlyCandidate(candidate)) {
        this.candidateRepo.update(candidate.id, {
          status: "resolved",
          readiness: "unknown",
          readinessReason: "Candidate looked like a success-only checkpoint and was auto-resolved.",
          resolvedAt: Date.now(),
        });
        continue;
      }

      if (candidate.source !== "dev_log") continue;
      const normalizedFingerprint = this.buildFingerprint(
        "dev_log",
        this.normalizeDevLogSignature(candidate.summary),
      );
      if (normalizedFingerprint === candidate.fingerprint) continue;

      const existing = this.candidateRepo.findByFingerprint(candidate.workspaceId, normalizedFingerprint);
      if (existing && existing.id !== candidate.id) {
        this.db.transaction(() => {
          this.runRepo.reassignCandidate(candidate.id, existing.id);
          this.candidateRepo.update(existing.id, {
            recurrenceCount: existing.recurrenceCount + candidate.recurrenceCount,
            severity: Math.max(existing.severity, candidate.severity),
            fixabilityScore: Math.max(existing.fixabilityScore, candidate.fixabilityScore),
            priorityScore: Math.max(existing.priorityScore, candidate.priorityScore),
            evidence: [...existing.evidence, ...candidate.evidence]
              .sort((a, b) => a.createdAt - b.createdAt)
              .slice(-MAX_EVIDENCE_ITEMS),
            lastSeenAt: Math.max(existing.lastSeenAt, candidate.lastSeenAt),
          });
          this.candidateRepo.delete(candidate.id);
        })();
        continue;
      }

      this.candidateRepo.update(candidate.id, {
        fingerprint: normalizedFingerprint,
      });
    }
  }

  private deriveReadiness(
    candidate: ImprovementCandidate,
    overrideReason?: string,
  ): { readiness: ImprovementCandidateReadiness; reason: string } {
    if (candidate.status === "parked") {
      if (candidate.lastFailureClass && this.isProviderFailure(candidate.lastFailureClass)) {
        return {
          readiness: "blocked_provider",
          reason: overrideReason || candidate.parkReason || "Provider failures are parking this candidate.",
        };
      }
      return {
        readiness: "parked",
        reason: overrideReason || candidate.parkReason || "Candidate is parked after repeated failures.",
      };
    }

    if (candidate.cooldownUntil && candidate.cooldownUntil > Date.now()) {
      return {
        readiness: "cooling_down",
        reason:
          overrideReason ||
          `Candidate is cooling down until ${new Date(candidate.cooldownUntil).toLocaleString()}.`,
      };
    }

    if (candidate.status !== "open") {
      return {
        readiness: "unknown",
        reason: overrideReason || `Candidate is currently ${candidate.status}.`,
      };
    }

    if (candidate.evidence.length < 1 || candidate.fixabilityScore < 0.4) {
      return {
        readiness: "needs_more_evidence",
        reason:
          overrideReason ||
          "Candidate needs stronger reproduction or verification evidence before running.",
      };
    }

    return {
      readiness: "ready",
      reason: overrideReason || "Candidate has sufficient evidence to run a bounded improvement campaign.",
    };
  }

  private isLikelySuccessOnlyCandidate(candidate: ImprovementCandidate): boolean {
    if (!this.looksLikeSuccessCheckpoint(candidate.summary)) return false;
    if (candidate.evidence.length === 0) return true;
    return candidate.evidence.every((evidence) => {
      const terminalStatus = String(evidence.metadata?.terminalStatus || "");
      return terminalStatus === "partial_success" || this.looksLikeSuccessCheckpoint(evidence.summary);
    });
  }

  private looksLikeSuccessCheckpoint(summary: string): boolean {
    return /(^|\s)(##\s*)?(✅|step complete|task complete|heartbeat complete|verification result|execution summary|status:\s*linked)/i.test(
      summary.toLowerCase(),
    );
  }

  private normalizeTaskTitleForFingerprint(title: unknown): string {
    if (typeof title !== "string") return "";
    return title
      .toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
      .replace(/\b\d+\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  private extractFailureSignature(summary: string, failureClass: string): string {
    const normalized = `${failureClass} ${summary}`
      .toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
      .replace(/\b\d+\b/g, "<n>");
    const patterns = [
      /unresolved [^.:\n;]*/g,
      /mutation-required[^.:\n;]*/g,
      /budget exhausted[^.:\n;]*/g,
      /timed out[^.:\n;]*/g,
      /request cancelled[^.:\n;]*/g,
      /fetch failed[^.:\n;]*/g,
      /provider quota[^.:\n;]*/g,
      /rate limit[^.:\n;]*/g,
      /verification[^.:\n;]*/g,
      /missing [^.:\n;]*/g,
      /workspace linkage does not exist[^.:\n;]*/g,
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[0]) return match[0].trim().slice(0, 160);
    }
    return normalized.replace(/\s+/g, " ").trim().slice(0, 160);
  }

  private normalizeDevLogSignature(line: string): string {
    return line
      .toLowerCase()
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\bat [^(]+\([^)]*\)/g, "stack-frame")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
      .replace(/\b\d+\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  private parsePayload(payload: unknown): Record<string, unknown> {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    if (typeof payload !== "string") {
      return {};
    }
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private truncate(value: string, max = 280): string {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
  }

  private getEvidenceKey(evidence: ImprovementEvidence): string {
    return [
      evidence.type,
      evidence.taskId || "",
      evidence.eventId || "",
      evidence.eventType || "",
      evidence.summary,
    ].join("|");
  }
}
