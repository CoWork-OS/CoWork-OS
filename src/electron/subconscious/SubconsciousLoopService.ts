import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentDaemon } from "../agent/daemon";
import { ProactiveSuggestionsService } from "../agent/ProactiveSuggestionsService";
import { AutomationProfileRepository } from "../agents/AutomationProfileRepository";
import { buildCoreAutomationAgentConfig } from "../agents/autonomy-policy";
import { CoreMemoryCandidateService } from "../core/CoreMemoryCandidateService";
import { CoreMemoryDistiller } from "../core/CoreMemoryDistiller";
import { CoreLearningPipelineService } from "../core/CoreLearningPipelineService";
import { CoreTraceService } from "../core/CoreTraceService";
import { WorkspaceRepository } from "../database/repositories";
import { MemoryService } from "../memory/MemoryService";
import { getCronStorePath, loadCronStoreSync } from "../cron/store";
import type { EventTriggerService } from "../triggers/EventTriggerService";
import { GitService } from "../git/GitService";
import { getUserDataDir } from "../utils/user-data-dir";
import { createLogger } from "../utils/logger";
import type {
  ImprovementCampaign,
  ImprovementCandidate,
  ImprovementEligibility,
  ImprovementHistoryResetResult,
  ImprovementLoopSettings,
  NotificationType,
  Workspace,
} from "../../shared/types";
import {
  type SubconsciousBacklogItem,
  type SubconsciousBrainSummary,
  type SubconsciousCritique,
  type SubconsciousDecision,
  type SubconsciousDispatchKind,
  type SubconsciousDispatchRecord,
  type SubconsciousDreamArtifact,
  type SubconsciousEvidence,
  type SubconsciousHealth,
  type SubconsciousHistoryResetResult,
  type SubconsciousHypothesis,
  type SubconsciousJournalEntry,
  type SubconsciousMemoryItem,
  type SubconsciousNotificationIntent,
  type SubconsciousPermissionDecision,
  type SubconsciousRefreshResult,
  type SubconsciousRiskLevel,
  type SubconsciousRun,
  type SubconsciousRunOutcome,
  type SubconsciousRunStage,
  type SubconsciousSettings,
  type SubconsciousTargetDetail,
  type SubconsciousTargetKind,
  type SubconsciousTargetRef,
  type SubconsciousTargetSummary,
} from "../../shared/subconscious";
import { SubconsciousArtifactStore } from "./SubconsciousArtifactStore";
import { SubconsciousMigrationService } from "./SubconsciousMigrationService";
import {
  SubconsciousBacklogRepository,
  SubconsciousCritiqueRepository,
  clearSubconsciousTargetData,
  clearSubconsciousHistoryData,
  SubconsciousDecisionRepository,
  SubconsciousDispatchRepository,
  SubconsciousHypothesisRepository,
  SubconsciousRunRepository,
  SubconsciousTargetRepository,
} from "./SubconsciousRepositories";
import { SubconsciousSettingsManager } from "./SubconsciousSettingsManager";

type Any = any;
const logger = createLogger("Subconscious");

interface SubconsciousLoopServiceDeps {
  notify?: (params: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    workspaceId?: string;
  }) => Promise<void> | void;
  isUserFocused?: () => boolean;
  getTriggerService?: () => EventTriggerService | null;
  getGlobalRoot?: () => string;
  automationProfileRepo?: AutomationProfileRepository;
  coreTraceService?: CoreTraceService;
  coreMemoryCandidateService?: CoreMemoryCandidateService;
  coreMemoryDistiller?: CoreMemoryDistiller;
  coreLearningPipelineService?: CoreLearningPipelineService;
}

interface ReflectionPolicyEvaluation {
  confidence: number;
  riskLevel: SubconsciousRiskLevel;
  evidenceSources: string[];
  evidenceFreshness: number;
  permissionDecision: SubconsciousPermissionDecision;
  notificationIntent?: SubconsciousNotificationIntent;
}

function now(): number {
  return Date.now();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pick<T>(values: T[]): T | undefined {
  return values[0];
}

function limit<T>(values: T[], max: number): T[] {
  return values.slice(0, max);
}

function uniqueBy<T>(items: T[], getKey: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hashNumber(value: string): number {
  return parseInt(stableHash(value).slice(0, 8), 16);
}

function toDispatchPolicyKey(kind: SubconsciousDispatchKind):
  | keyof SubconsciousSettings["perExecutorPolicy"]
  | "codeChangeTask" {
  switch (kind) {
    case "code_change_task":
      return "codeChangeTask";
    default:
      return kind;
  }
}

function humanizeDispatchKind(kind?: SubconsciousDispatchKind): string {
  switch (kind) {
    case "code_change_task":
      return "code change task";
    default:
      return kind ? kind.replace(/_/g, " ") : "recommendation";
  }
}

function isSelfGeneratedSubconsciousTask(row: Any): boolean {
  return row?.source === "subconscious" && typeof row?.title === "string";
}

function isActionableHeartbeatPulseResult(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value !== "idle";
}

function isLowSignalHeartbeatSummary(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return [
    "no actionable heartbeat state",
    "dispatch already in flight",
    "dispatch cooldown active",
    "daily dispatch budget exhausted",
  ].some((entry) => normalized.includes(entry));
}

function isActionableHeartbeatRun(row: Any): boolean {
  const status = typeof row?.status === "string" ? row.status : "";
  if (["failed", "cancelled", "interrupted"].includes(status)) return true;
  if (status === "queued" || status === "running") {
    const updatedAt = Number(row?.updated_at || 0);
    return updatedAt > 0 && now() - updatedAt > 30 * 60 * 1000;
  }
  if (status !== "completed") return false;
  if (row?.dispatch_kind) return true;
  return !isLowSignalHeartbeatSummary(row?.summary || row?.reason);
}

function isActionableEvidenceSignal(evidence: SubconsciousEvidence): boolean {
  const summary = evidence.summary.toLowerCase();
  switch (evidence.type) {
    case "code_failure":
    case "pull_request_activity":
      return true;
    case "mailbox_event":
      return /reply|respond|urgent|blocked|waiting|follow up|needs?/i.test(summary);
    case "task_signal":
      return /failed|blocked|paused|interrupted|cancelled|needs input|waiting|stale/i.test(summary);
    case "heartbeat_signal":
    case "heartbeat_run":
      return !/idle|no actionable heartbeat state|completed$/i.test(summary);
    case "event_trigger":
    case "scheduled_task":
    case "briefing":
    case "memory_playbook":
      return /failed|paused|disabled|blocked|stale|error|missing/i.test(summary);
    default:
      return false;
  }
}

function scoreEvidenceUsefulness(evidence: SubconsciousEvidence[]): number {
  if (!evidence.length) return 0;
  const weights = evidence.map((item) => {
    const actionable = isActionableEvidenceSignal(item);
    switch (item.type) {
      case "code_failure":
        return 0.95;
      case "pull_request_activity":
        return 0.82;
      case "mailbox_event":
        return actionable ? 0.72 : 0.25;
      case "task_signal":
        return actionable ? 0.68 : 0.18;
      case "heartbeat_run":
      case "heartbeat_signal":
        return actionable ? 0.58 : 0.12;
      case "event_trigger":
      case "scheduled_task":
      case "briefing":
        return actionable ? 0.5 : 0.1;
      case "memory_playbook":
        return actionable ? 0.42 : 0.08;
      default:
        return actionable ? 0.4 : 0.05;
    }
  });
  const strongest = Math.max(...weights);
  const actionableCount = evidence.filter(isActionableEvidenceSignal).length;
  const densityBonus = Math.min(0.18, Math.max(0, actionableCount - 1) * 0.06);
  return clamp(strongest + densityBonus, 0, 1);
}

const COWORK_OS_REPO_IDENTITY = "CoWork-OS/CoWork-OS";

interface CodeWorkspaceTargetCandidate {
  workspace: Workspace;
  repoRoot: string;
  workspaceAtRepoRoot: boolean;
  remoteName?: string;
  remoteUrl?: string;
  repoIdentity?: string;
}

function normalizeRepoIdentity(value?: string | null): string | undefined {
  if (!value) return undefined;
  return value.toLowerCase() === COWORK_OS_REPO_IDENTITY.toLowerCase()
    ? COWORK_OS_REPO_IDENTITY
    : value;
}

function isCoworkRepoIdentity(value?: string | null): boolean {
  return value?.toLowerCase() === COWORK_OS_REPO_IDENTITY.toLowerCase();
}

function buildCodeTargetKey(candidate: Pick<CodeWorkspaceTargetCandidate, "repoRoot" | "repoIdentity">): string {
  if (candidate.repoIdentity) {
    return `code_workspace:github:${candidate.repoIdentity}`;
  }
  return `code_workspace:repo:${stableHash(candidate.repoRoot).slice(0, 16)}`;
}

async function normalizeComparablePath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

export class SubconsciousLoopService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly targetRepo: SubconsciousTargetRepository;
  private readonly runRepo: SubconsciousRunRepository;
  private readonly hypothesisRepo: SubconsciousHypothesisRepository;
  private readonly critiqueRepo: SubconsciousCritiqueRepository;
  private readonly decisionRepo: SubconsciousDecisionRepository;
  private readonly backlogRepo: SubconsciousBacklogRepository;
  private readonly dispatchRepo: SubconsciousDispatchRepository;
  private readonly artifactStore: SubconsciousArtifactStore;
  private readonly migrationService: SubconsciousMigrationService;
  private readonly latestEvidenceByTarget = new Map<string, SubconsciousEvidence[]>();
  private readonly lastNotificationByIntent = new Map<string, number>();
  private agentDaemon: AgentDaemon | null = null;
  private brainStatus: SubconsciousBrainSummary["status"] = "idle";
  private started = false;
  private lastDreamAt?: number;

  constructor(
    private readonly db: Database.Database,
    private readonly deps: SubconsciousLoopServiceDeps = {},
  ) {
    this.workspaceRepo = new WorkspaceRepository(db);
    this.targetRepo = new SubconsciousTargetRepository(db);
    this.runRepo = new SubconsciousRunRepository(db);
    this.hypothesisRepo = new SubconsciousHypothesisRepository(db);
    this.critiqueRepo = new SubconsciousCritiqueRepository(db);
    this.decisionRepo = new SubconsciousDecisionRepository(db);
    this.backlogRepo = new SubconsciousBacklogRepository(db);
    this.dispatchRepo = new SubconsciousDispatchRepository(db);
    this.artifactStore = new SubconsciousArtifactStore(
      (workspaceId?: string) => this.resolveWorkspacePath(workspaceId),
      () => this.resolveGlobalRoot(),
    );
    this.migrationService = new SubconsciousMigrationService(db);
  }

  private async finalizeCoreLearning(traceId: string, target?: SubconsciousTargetRef, sourceRunId?: string): Promise<void> {
    this.deps.coreMemoryCandidateService?.extractFromTrace(traceId, {
      target,
      sourceRunId,
    });
    this.deps.coreMemoryCandidateService?.autoAcceptHighSignalCandidates(traceId);
    await this.deps.coreMemoryDistiller?.runHotPath(traceId);
    this.deps.coreLearningPipelineService?.processTrace(traceId);
  }

  async start(agentDaemon: AgentDaemon): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.agentDaemon = agentDaemon;
    this.migrationService.runOnce();
    this.normalizeLegacyOutcomeVocabulary();
    this.pruneSessionOnlyState();
    await this.refreshTargets();
    logger.info("Service started", {
      enabled: this.getSettings().enabled,
      autoRun: this.getSettings().autoRun,
      cadenceMinutes: this.getSettings().cadenceMinutes,
      targetCount: this.targetRepo.list().length,
    });
  }

  stop(): void {
    this.started = false;
    this.agentDaemon = null;
    this.brainStatus = "idle";
  }

  getSettings(): SubconsciousSettings {
    return SubconsciousSettingsManager.loadSettings();
  }

  saveSettings(settings: SubconsciousSettings): SubconsciousSettings {
    SubconsciousSettingsManager.saveSettings(settings);
    return this.getSettings();
  }

  getBrainSummary(): SubconsciousBrainSummary {
    const settings = this.getSettings();
    const targets = this.targetRepo.list();
    const activeRunCount = this.runRepo.list({ activeOnly: true }).length;
    const lastRunAt = pick(
      this.runRepo
        .list({ limit: 1 })
        .map((run) => run.completedAt || run.startedAt)
        .filter((value): value is number => typeof value === "number"),
    );
    return {
      status: settings.enabled ? this.brainStatus : "paused",
      enabled: settings.enabled,
      autonomyMode: settings.autonomyMode,
      cadenceMinutes: settings.cadenceMinutes,
      targetCount: targets.length,
      activeRunCount,
      lastRunAt,
      lastDreamAt: this.lastDreamAt,
      updatedAt: now(),
    };
  }

  listTargets(workspaceId?: string): SubconsciousTargetSummary[] {
    return this.targetRepo.list({ workspaceId });
  }

  listRuns(targetKey?: string): SubconsciousRun[] {
    return this.runRepo.list({ targetKey });
  }

  async getTargetDetail(targetKey: string): Promise<SubconsciousTargetDetail | null> {
    const target = this.targetRepo.findByKey(targetKey);
    if (!target) return null;
    const recentRuns = this.runRepo.list({ targetKey, limit: 12 });
    const latestRun = pick(recentRuns);
    return {
      target,
      latestEvidence: this.latestEvidenceByTarget.get(targetKey) || [],
      recentRuns,
      latestHypotheses: latestRun ? this.hypothesisRepo.listByRun(latestRun.id) : [],
      latestCritiques: latestRun ? this.critiqueRepo.listByRun(latestRun.id) : [],
      latestDecision: latestRun ? this.decisionRepo.findByRun(latestRun.id) : undefined,
      backlog: this.backlogRepo.listByTarget(targetKey, 50),
      dispatchHistory: this.dispatchRepo.listByTarget(targetKey, 30),
      journal: await this.artifactStore.readJournalEntries(targetKey, 40),
      memory: await this.artifactStore.readMemoryIndex(targetKey, target.target),
      dreams: await this.artifactStore.readDreamArtifacts(target.target, 5),
    };
  }

  async refreshTargets(): Promise<SubconsciousRefreshResult> {
    const settings = this.getSettings();
    const collected = await this.collectTargets(settings.enabledTargetKinds);
    const existingKeys = new Set(this.targetRepo.list().map((target) => target.key));
    const collectedKeys = new Set(collected.keys());
    const staleKeys = Array.from(existingKeys).filter((key) => !collectedKeys.has(key));
    if (staleKeys.length) {
      clearSubconsciousTargetData(this.db, staleKeys);
      for (const key of staleKeys) {
        this.latestEvidenceByTarget.delete(key);
      }
    }
    let evidenceCount = 0;
    for (const [targetKey, data] of collected.entries()) {
      if (data.target.kind === "code_workspace") {
        this.backlogRepo.deleteLegacyNoiseByTarget(targetKey);
      }
      this.backlogRepo.dedupeOpenByTarget(targetKey);
      const evidence = data.evidence
        .sort((a, b) => b.createdAt - a.createdAt)
        .filter((item, index, items) => items.findIndex((other) => other.fingerprint === item.fingerprint) === index);
      evidenceCount += evidence.length;
      this.latestEvidenceByTarget.set(targetKey, evidence);
      const backlogCount = this.backlogRepo.countOpenByTarget(targetKey);
      const summary = this.buildTargetSummary(
        data.target,
        evidence,
        backlogCount,
        this.targetRepo.findByKey(targetKey),
      );
      this.targetRepo.upsert(summary);
      await this.artifactStore.writeTargetState(summary, evidence, this.backlogRepo.listByTarget(targetKey, 50));
    }
    const targets = this.targetRepo.list();
    await this.artifactStore.writeBrainState(this.getBrainSummary(), targets);
    logger.info("Refreshed targets", {
      targetCount: targets.length,
      evidenceCount,
      enabledTargetKinds: settings.enabledTargetKinds,
    });
    return { targetCount: targets.length, evidenceCount };
  }

  async runNow(targetKey?: string): Promise<SubconsciousRun | null> {
    const settings = this.getSettings();
    if (!settings.enabled) return null;
    await this.refreshTargets();
    const target = targetKey ? this.targetRepo.findByKey(targetKey) : this.pickTargetForRun();
    if (!target) {
      logger.info("Run skipped: no eligible target", { requestedTargetKey: targetKey || null });
      return null;
    }

    const evidence = this.latestEvidenceByTarget.get(target.key) || [];
    const evidenceFingerprint = stableHash(
      evidence.map((item) => ({
        fingerprint: item.fingerprint,
        createdAt: item.createdAt,
      })),
    );
    const deduped = this.runRepo.findLatestByFingerprint(target.key, evidenceFingerprint);
    if (
      deduped &&
      ["sleep", "suggest", "dispatch", "notify", "defer", "dismiss"].includes(
        deduped.outcome || "",
      )
    ) {
      this.targetRepo.update(target.key, {
        nextEligibleAt: this.computeNextEligibleAt(target, now()),
        lastActionAt: now(),
        backlogCount: this.backlogRepo.countOpenByTarget(target.key),
      });
      logger.info("Run deduplicated", {
        targetKey: target.key,
        runId: deduped.id,
        outcome: deduped.outcome,
      });
      return deduped;
    }

    this.brainStatus = "running";
    const profile = this.resolveAutomationProfileForTarget(target.target);
    let run = this.runRepo.create({
      targetKey: target.key,
      workspaceId: target.target.workspaceId,
      stage: "collecting_evidence",
      evidenceFingerprint,
      evidenceSummary: evidence.map((item) => item.summary).slice(0, 3).join(" | "),
      artifactRoot: this.artifactStore.getRunRoot(target.target, randomUUID()),
      rejectedHypothesisIds: [],
      startedAt: now(),
    });
    const coreTrace = profile
      ? this.deps.coreTraceService?.startTrace({
          profileId: profile.id,
          workspaceId: target.target.workspaceId,
          targetKey: target.key,
          sourceSurface: "subconscious",
          traceKind: "subconscious_cycle",
          status: "running",
          subconsciousRunId: run.id,
          startedAt: run.startedAt,
        })
      : undefined;
    logger.info("Run started", {
      runId: run.id,
      targetKey: target.key,
      targetLabel: target.target.label,
      evidenceCount: evidence.length,
      requestedTargetKey: targetKey || null,
    });

    try {
      await this.appendJournal({
        runId: run.id,
        targetKey: target.key,
        kind: "observation",
        summary: `Reflector started for ${target.target.label}.`,
        details: evidence.length
          ? `Collected ${evidence.length} evidence signal(s).`
          : "No fresh evidence was collected.",
      });
      this.targetRepo.update(target.key, {
        state: "active",
        evidenceFingerprint,
        lastObservedAt: pick(evidence)?.createdAt || now(),
      });

      if (evidence.length === 0) {
        if (coreTrace) {
          this.deps.coreTraceService?.appendPhaseEvent(
            coreTrace.id,
            "evidence",
            "subconscious.no_evidence",
            "No fresh evidence was worth acting on right now.",
          );
        }
        run = this.completeSleepRun(run, "No fresh evidence was worth acting on right now.");
        await this.appendJournal({
          runId: run.id,
          targetKey: target.key,
          kind: "sleep",
          summary: `Reflector slept for ${target.target.label}.`,
          details: "No fresh evidence was worth acting on right now.",
          outcome: "sleep",
        });
        this.brainStatus = "idle";
        await this.artifactStore.writeRunArtifacts({
          target: target.target,
          run,
          evidence,
          hypotheses: [],
          critiques: [],
          backlog: [],
          dispatch: null,
        });
        await this.finalizeTargetAfterRun(target, run, undefined, null, evidence);
        await this.maybeRunDream(target.target);
        if (coreTrace) {
          this.deps.coreTraceService?.completeTrace(
            coreTrace.id,
            "completed",
            "No fresh evidence was worth acting on right now.",
          );
          await this.finalizeCoreLearning(coreTrace.id, target.target, run.id);
        }
        logger.info("Run completed", {
          runId: run.id,
          targetKey: target.key,
          targetLabel: target.target.label,
          stage: run.stage,
          outcome: run.outcome,
          reason: run.blockedReason || null,
        });
        return run;
      }

      run = await this.advanceRun(run.id, { stage: "ideating" });
      if (coreTrace) {
        this.deps.coreTraceService?.appendPhaseEvent(
          coreTrace.id,
          "evidence",
          "subconscious.evidence_collected",
          `Collected ${evidence.length} evidence signal(s).`,
          {
            evidenceCount: evidence.length,
            targetKey: target.key,
          },
        );
      }
      const hypotheses = this.generateHypotheses(target.target, evidence, settings.maxHypothesesPerRun).map(
        (item) => ({ ...item, runId: run.id }),
      );
      this.hypothesisRepo.replaceForRun(run.id, hypotheses);
      if (coreTrace) {
        this.deps.coreTraceService?.appendPhaseEvent(
          coreTrace.id,
          "decision",
          "subconscious.hypotheses_generated",
          `Generated ${hypotheses.length} hypothesis candidate(s).`,
        );
      }

      run = await this.advanceRun(run.id, { stage: "critiquing" });
      const critiques = this.generateCritiques(target.target, evidence, hypotheses).map((item) => ({
        ...item,
        runId: run.id,
      }));
      this.critiqueRepo.replaceForRun(run.id, critiques);
      if (coreTrace) {
        this.deps.coreTraceService?.appendPhaseEvent(
          coreTrace.id,
          "decision",
          "subconscious.critiques_generated",
          `Generated ${critiques.length} critique(s).`,
        );
      }

      run = await this.advanceRun(run.id, { stage: "synthesizing" });
      const decision = {
        ...this.synthesizeDecision(target.target, evidence, hypotheses, critiques),
        runId: run.id,
      };
      if (coreTrace) {
        this.deps.coreTraceService?.appendPhaseEvent(
          coreTrace.id,
          "decision",
          "subconscious.decision_synthesized",
          decision.winnerSummary,
          {
            recommendation: decision.recommendation,
          },
        );
      }
      this.decisionRepo.upsert(decision);
      await this.appendJournal({
        runId: run.id,
        targetKey: target.key,
        kind: "decision",
        summary: decision.winnerSummary,
        details: decision.recommendation,
      });
      const dispatchKind = this.resolveDispatchKind(target.target, evidence);
      const backlog = this.materializeBacklog(target.key, decision, dispatchKind);
      const policy = this.evaluatePolicy(target, decision, evidence, dispatchKind);
      const autoDispatchAllowed = this.shouldAutoDispatchDecision({
        settings,
        target,
        dispatchKind,
        policy,
        evidence,
      });
      this.runRepo.update(run.id, {
        confidence: policy.confidence,
        riskLevel: policy.riskLevel,
        evidenceSources: policy.evidenceSources,
        evidenceFreshness: policy.evidenceFreshness,
        permissionDecision: policy.permissionDecision,
        notificationIntent: policy.notificationIntent,
      });
      const placeholderDispatch =
        autoDispatchAllowed && dispatchKind
          ? ({
              id: randomUUID(),
              runId: run.id,
              targetKey: target.key,
              kind: dispatchKind,
              status: "queued",
              summary: "Dispatch queued after synthesis.",
              createdAt: now(),
            } satisfies SubconsciousDispatchRecord)
          : null;
      const artifactRoot = await this.artifactStore.writeRunArtifacts({
        target: target.target,
        run: { ...run, artifactRoot: this.artifactStore.getRunRoot(target.target, run.id) },
        evidence,
        hypotheses,
        critiques,
        decision,
        backlog,
        dispatch: placeholderDispatch,
      });
      this.runRepo.update(run.id, {
        artifactRoot,
      });

      let dispatchRecord: SubconsciousDispatchRecord | null = null;
      let outcome: SubconsciousRunOutcome =
        policy.permissionDecision === "blocked"
          ? "suggest"
          : policy.permissionDecision === "escalated"
            ? "defer"
            : autoDispatchAllowed && dispatchKind
              ? "dispatch"
              : "suggest";
      let finalStage: SubconsciousRunStage = "completed";
      if (autoDispatchAllowed && dispatchKind) {
        run = await this.advanceRun(run.id, { stage: "dispatching" });
        if (coreTrace) {
          this.deps.coreTraceService?.appendPhaseEvent(
            coreTrace.id,
            "dispatch",
            "subconscious.dispatch_started",
            `Dispatching ${humanizeDispatchKind(dispatchKind)}.`,
            {
              dispatchKind,
            },
          );
        }
        dispatchRecord = await this.dispatchDecision(target.target, decision, evidence);
        if (dispatchRecord) {
          this.dispatchRepo.create(dispatchRecord);
          outcome =
            dispatchRecord.status === "failed"
              ? "failed"
              : policy.notificationIntent === "completed_while_away"
                ? "notify"
                : dispatchRecord.status === "skipped"
                  ? "defer"
                  : "dispatch";
          if (dispatchRecord.status === "failed") {
            finalStage = "failed";
          }
        }
      } else {
        dispatchRecord = await this.dispatchSuggestionForReview(target.target, decision, evidence);
        if (dispatchRecord) {
          this.dispatchRepo.create(dispatchRecord);
          outcome = dispatchRecord.status === "skipped" ? "defer" : "suggest";
        }
      }

      this.runRepo.update(run.id, {
        stage: finalStage,
        outcome,
        dispatchKind: dispatchRecord?.kind,
        dispatchStatus: dispatchRecord?.status,
        confidence: policy.confidence,
        riskLevel: policy.riskLevel,
        evidenceSources: policy.evidenceSources,
        evidenceFreshness: policy.evidenceFreshness,
        permissionDecision: policy.permissionDecision,
        notificationIntent: policy.notificationIntent,
        completedAt: now(),
        rejectedHypothesisIds: decision.rejectedHypothesisIds,
      });
      const finalRun = this.runRepo.findById(run.id) || run;
      this.brainStatus = "idle";
      await this.artifactStore.writeRunArtifacts({
        target: target.target,
        run: finalRun,
        evidence,
        hypotheses,
        critiques,
        decision: { ...decision, outcome },
        backlog: this.backlogRepo.listByTarget(target.key, 50),
        dispatch: dispatchRecord,
      });
      await this.finalizeTargetAfterRun(target, finalRun, decision, dispatchRecord, evidence);
      await this.notifyForRun(target.target, finalRun, decision, dispatchRecord);
      await this.maybeRunDream(target.target);
      if (coreTrace) {
        this.deps.coreTraceService?.appendPhaseEvent(
          coreTrace.id,
          dispatchRecord ? "dispatch" : "complete",
          dispatchRecord ? "subconscious.dispatch_completed" : "subconscious.run_completed",
          dispatchRecord?.summary || decision.winnerSummary,
          {
            dispatchStatus: dispatchRecord?.status,
            outcome,
          },
        );
        this.deps.coreTraceService?.completeTrace(coreTrace.id, "completed", finalRun.outcome || outcome);
        await this.finalizeCoreLearning(coreTrace.id, target.target, finalRun.id);
      }
      logger.info("Run completed", {
        runId: finalRun.id,
        targetKey: target.key,
        targetLabel: target.target.label,
        stage: finalRun.stage,
        outcome: finalRun.outcome,
        dispatchKind: finalRun.dispatchKind || null,
        dispatchStatus: finalRun.dispatchStatus || null,
        permissionDecision: finalRun.permissionDecision || null,
      });
      return this.runRepo.findById(run.id) || finalRun;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.brainStatus = "idle";
      this.runRepo.update(run.id, {
        stage: "failed",
        outcome: "failed",
        error: message,
        completedAt: now(),
      });
      this.targetRepo.update(target.key, {
        state: "idle",
        health: "blocked",
      });
      await this.appendJournal({
        runId: run.id,
        targetKey: target.key,
        kind: "action",
        summary: `Run failed for ${target.target.label}.`,
        details: message,
        outcome: "failed",
      });
      await this.artifactStore.writeBrainState(this.getBrainSummary(), this.targetRepo.list());
      if (coreTrace) {
        this.deps.coreTraceService?.appendPhaseEvent(
          coreTrace.id,
          "error",
          "subconscious.error",
          message,
        );
        this.deps.coreTraceService?.failTrace(coreTrace.id, message);
        await this.finalizeCoreLearning(coreTrace.id, target.target, run.id);
      }
      logger.error("Run failed", {
        runId: run.id,
        targetKey: target.key,
        targetLabel: target.target.label,
        error: message,
      });
      return this.runRepo.findById(run.id) || null;
    }
  }

  async runFromHeartbeat(workspaceId?: string): Promise<SubconsciousRun | null> {
    const settings = this.getSettings();
    if (!settings.enabled || !settings.autoRun) return null;
    await this.refreshTargets();
    const target = this.pickTargetForRun(workspaceId);
    if (!target) {
      logger.info("Heartbeat-triggered reflection skipped: no eligible target", {
        workspaceId: workspaceId || null,
      });
      return null;
    }
    return this.runNow(target.key);
  }

  private resolveAutomationProfileForTarget(target: SubconsciousTargetRef) {
    const repo = this.deps.automationProfileRepo;
    if (!repo) return undefined;
    if (target.agentRoleId) {
      return repo.findByAgentRoleId(target.agentRoleId);
    }
    const enabled = repo.listEnabled();
    if (!enabled.length) return undefined;
    return enabled[0];
  }

  async retryRun(runId: string): Promise<SubconsciousRun | null> {
    const prior = this.runRepo.findById(runId);
    if (!prior) return null;
    return this.runNow(prior.targetKey);
  }

  async reviewRun(
    runId: string,
    reviewStatus: "accepted" | "dismissed",
  ): Promise<SubconsciousRun | undefined> {
    const run = this.runRepo.findById(runId);
    if (!run) return undefined;
    if (reviewStatus === "dismissed") {
      this.runRepo.update(runId, {
        stage: "blocked",
        outcome: "dismiss",
        blockedReason: "Dismissed during compatibility review.",
        completedAt: now(),
      });
      return this.runRepo.findById(runId);
    }
    if (run.dispatchStatus === "completed" || run.dispatchStatus === "dispatched") {
      return run;
    }
    return await this.retryRun(runId) || run;
  }

  dismissTarget(targetKey: string): SubconsciousTargetSummary | undefined {
    const target = this.targetRepo.findByKey(targetKey);
    if (!target) return undefined;
    this.targetRepo.update(targetKey, {
      state: "stale",
      health: "watch",
      lastDispatchStatus: "skipped",
      lastMeaningfulOutcome: "dismiss",
      lastActionAt: now(),
    });
    return this.targetRepo.findByKey(targetKey);
  }

  async resetHistory(): Promise<SubconsciousHistoryResetResult> {
    const deleted = clearSubconsciousHistoryData(this.db);
    this.latestEvidenceByTarget.clear();
    for (const workspace of this.workspaceRepo.findAll()) {
      if (!workspace.path) continue;
      await fs.rm(path.join(workspace.path, ".cowork", "subconscious"), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    await fs.rm(path.join(this.resolveGlobalRoot(), ".cowork", "subconscious"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    this.lastDreamAt = undefined;
    this.lastNotificationByIntent.clear();
    return {
      resetAt: now(),
      deleted,
    };
  }

  getImprovementCompatibilitySettings(): ImprovementLoopSettings {
    const settings = this.getSettings();
    return {
      enabled: settings.enabled,
      autoRun: settings.autoRun,
      includeDevLogs: true,
      intervalMinutes: settings.cadenceMinutes,
      variantsPerCampaign: 1,
      maxConcurrentCampaigns: 1,
      maxConcurrentImprovementExecutors: 1,
      maxQueuedImprovementCampaigns: 1,
      maxOpenCandidatesPerWorkspace: 25,
      requireWorktree: settings.perExecutorPolicy.codeChangeTask.requireWorktree,
      requireRepoChecks: true,
      enforcePatchScope: true,
      maxPatchFiles: 8,
      reviewRequired: settings.perExecutorPolicy.codeChangeTask.strictReview,
      judgeRequired: false,
      promotionMode: "github_pr",
      evalWindowDays: 14,
      replaySetSize: 3,
      campaignTimeoutMinutes: 30,
      campaignTokenBudget: 60000,
      campaignCostBudget: 15,
    };
  }

  getImprovementEligibility(): ImprovementEligibility {
    return {
      eligible: true,
      reason: "Workflow Intelligence is generally available.",
      enrolled: true,
      checks: {
        unpackagedApp: true,
        canonicalRepo: true,
        ownerEnrollment: true,
        ownerProofPresent: true,
      },
    };
  }

  listImprovementCandidates(workspaceId?: string): ImprovementCandidate[] {
    return this.listTargets(workspaceId).map((target) => ({
      id: target.key,
      workspaceId: target.target.workspaceId || workspaceId || "global",
      fingerprint: target.evidenceFingerprint || target.key,
      source: "user_feedback",
      status: target.state === "active" ? "running" : target.health === "blocked" ? "parked" : "open",
      readiness: "ready",
      readinessReason: target.lastWinner || undefined,
      title: target.target.label,
      summary: target.lastWinner || "Workflow intelligence target awaiting review.",
      severity: target.health === "blocked" ? 0.9 : target.health === "watch" ? 0.6 : 0.3,
      recurrenceCount: this.latestEvidenceByTarget.get(target.key)?.length || 0,
      fixabilityScore: 0.8,
      priorityScore: target.backlogCount + (target.health === "blocked" ? 2 : target.health === "watch" ? 1 : 0),
      evidence: (this.latestEvidenceByTarget.get(target.key) || []).map((item) => ({
        type: "user_feedback",
        summary: item.summary,
        details: item.details,
        createdAt: item.createdAt,
        metadata: item.metadata,
      })),
      firstSeenAt: target.lastEvidenceAt || now(),
      lastSeenAt: target.lastEvidenceAt || now(),
      lastExperimentAt: target.lastRunAt,
      failureStreak: target.health === "blocked" ? 1 : 0,
      parkReason: target.health === "blocked" ? "Target is blocked." : undefined,
      parkedAt: target.health === "blocked" ? target.lastRunAt : undefined,
    }));
  }

  listImprovementCampaigns(workspaceId?: string): ImprovementCampaign[] {
    const targets = new Map(this.listTargets(workspaceId).map((item) => [item.key, item]));
    return this.runRepo.list({ workspaceId }).map((run) => {
      const target = targets.get(run.targetKey);
      const decision = this.decisionRepo.findByRun(run.id);
      return {
        id: run.id,
        candidateId: run.targetKey,
        workspaceId: run.workspaceId || target?.target.workspaceId || "global",
        status:
          run.stage === "dispatching"
            ? "ready_for_review"
            : run.outcome === "failed"
              ? "failed"
              : "promoted",
        stage:
          run.stage === "collecting_evidence" || run.stage === "ideating"
            ? "preflight"
            : run.stage === "critiquing"
              ? "reproducing"
              : run.stage === "synthesizing"
                ? "verifying"
                : "completed",
        reviewStatus: "accepted",
        promotionStatus:
          run.dispatchStatus === "failed"
            ? "promotion_failed"
            : run.dispatchStatus === "completed" || run.dispatchStatus === "dispatched"
              ? "pr_opened"
              : "idle",
        stopReason: run.blockedReason,
        verdictSummary: decision?.winnerSummary || run.evidenceSummary,
        evaluationNotes: decision?.recommendation,
        trainingEvidence: [],
        holdoutEvidence: [],
        replayCases: [],
        variants: [],
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      };
    });
  }

  async resetImprovementCompatibilityHistory(): Promise<ImprovementHistoryResetResult> {
    const result = await this.resetHistory();
    return {
      resetAt: result.resetAt,
      deleted: {
        candidates: result.deleted.targets,
        campaigns: result.deleted.runs,
        variantRuns: result.deleted.hypotheses + result.deleted.critiques,
        judgeVerdicts: result.deleted.decisions,
        legacyRuns: result.deleted.dispatchRecords,
      },
      cancelledTaskIds: [],
    };
  }

  private pruneSessionOnlyState(): void {
    const durableKinds = new Set(this.getSettings().durableTargetKinds);
    const staleKeys = this.targetRepo
      .list()
      .filter((target) => !durableKinds.has(target.target.kind))
      .map((target) => target.key);
    if (staleKeys.length) {
      clearSubconsciousTargetData(this.db, staleKeys);
    }
  }

  private computeJitterMs(targetKey: string, cadenceMinutes: number): number {
    const maxJitter = Math.min(cadenceMinutes * 60 * 1000 * 0.1, 15 * 60 * 1000);
    if (maxJitter <= 0) return 0;
    return hashNumber(targetKey) % Math.max(1, Math.round(maxJitter));
  }

  private computeNextEligibleAt(target: SubconsciousTargetSummary, completedAt: number): number {
    return completedAt + this.getSettings().cadenceMinutes * 60 * 1000 + (target.jitterMs || 0);
  }

  private hasFreshActionableEvidence(target: SubconsciousTargetSummary): boolean {
    const latestEvidenceAt = (this.latestEvidenceByTarget.get(target.key) || [])[0]?.createdAt || target.lastEvidenceAt || 0;
    if (!latestEvidenceAt) return false;
    const freshnessWindowMs = Math.max(this.getSettings().cadenceMinutes * 60 * 1000, 12 * 60 * 60 * 1000);
    return now() - latestEvidenceAt <= freshnessWindowMs;
  }

  private computeExpiryAt(latestEvidenceAt?: number): number | undefined {
    if (!latestEvidenceAt) return undefined;
    return latestEvidenceAt + 30 * 24 * 60 * 60 * 1000;
  }

  private completeSleepRun(
    run: SubconsciousRun,
    reason: string,
  ): SubconsciousRun {
    this.runRepo.update(run.id, {
      stage: "completed",
      outcome: "sleep",
      blockedReason: reason,
      completedAt: now(),
      confidence: 0.25,
      riskLevel: "low",
      evidenceSources: [],
      evidenceFreshness: 0,
      permissionDecision: "blocked",
      notificationIntent: "input_needed",
    });
    const finalRun = this.runRepo.findById(run.id) || run;
    return finalRun;
  }

  private normalizeLegacyOutcomeVocabulary(): void {
    const statements = [
      "UPDATE subconscious_runs SET outcome = 'dispatch' WHERE outcome = 'completed'",
      "UPDATE subconscious_runs SET outcome = 'suggest' WHERE outcome = 'completed_no_dispatch'",
      "UPDATE subconscious_decisions SET outcome = 'dispatch' WHERE outcome = 'completed'",
      "UPDATE subconscious_decisions SET outcome = 'suggest' WHERE outcome = 'completed_no_dispatch'",
      "UPDATE subconscious_targets SET last_meaningful_outcome = 'dispatch' WHERE last_meaningful_outcome = 'completed'",
      "UPDATE subconscious_targets SET last_meaningful_outcome = 'suggest' WHERE last_meaningful_outcome = 'completed_no_dispatch'",
    ];
    try {
      for (const sql of statements) {
        this.db.prepare(sql).run();
      }
    } catch (error) {
      logger.warn("Skipping legacy outcome vocabulary normalization:", error);
    }
  }

  private async appendJournal(input: Omit<SubconsciousJournalEntry, "id" | "createdAt"> & { createdAt?: number }): Promise<void> {
    if (!this.getSettings().journalingEnabled) return;
    await this.artifactStore.appendJournalEntry({
      id: randomUUID(),
      createdAt: input.createdAt ?? now(),
      ...input,
    });
  }

  private evaluatePolicy(
    target: SubconsciousTargetSummary,
    decision: SubconsciousDecision,
    evidence: SubconsciousEvidence[],
    dispatchKind?: SubconsciousDispatchKind,
  ): ReflectionPolicyEvaluation {
    const settings = this.getSettings();
    const evidenceSources = uniqueBy(evidence.map((item) => item.type), (value) => value);
    const newestEvidenceAt = Math.max(...evidence.map((item) => item.createdAt), 0);
    const ageHours = newestEvidenceAt ? (now() - newestEvidenceAt) / (60 * 60 * 1000) : 999;
    const evidenceFreshness = clamp(1 - ageHours / 72, 0, 1);
    const usefulness = scoreEvidenceUsefulness(evidence);
    const confidence = clamp(
      0.35 +
        Math.min(evidence.filter(isActionableEvidenceSignal).length, 5) * 0.08 +
        usefulness * 0.24 +
        (decision.winnerSummary.length > 0 ? 0.08 : 0),
      0,
      0.98,
    );
    const riskLevel: SubconsciousRiskLevel =
      dispatchKind === "code_change_task" ? "high" : dispatchKind === "task" ? "medium" : "low";
    let permissionDecision: SubconsciousPermissionDecision = "allowed";
    if (!dispatchKind) {
      permissionDecision = "blocked";
    } else if (!settings.dispatchDefaults.autoDispatch) {
      permissionDecision = "escalated";
    } else if (riskLevel === "high") {
      permissionDecision = settings.trustedTargetKeys.includes(target.key) ? "allowed" : "escalated";
    } else if (riskLevel === "medium" && settings.autonomyMode === "recommendation_first") {
      permissionDecision = "escalated";
    } else if (usefulness < 0.45) {
      permissionDecision = "blocked";
    } else if (confidence < 0.55 || evidenceFreshness < 0.2) {
      permissionDecision = "escalated";
    }

    let notificationIntent: SubconsciousNotificationIntent | undefined;
    if (permissionDecision === "escalated") {
      notificationIntent = "input_needed";
    } else if (permissionDecision === "allowed" && !this.deps.isUserFocused?.()) {
      notificationIntent = "completed_while_away";
    } else if (permissionDecision === "allowed" && dispatchKind) {
      notificationIntent = "important_action_taken";
    }

    return {
      confidence,
      riskLevel,
      evidenceSources,
      evidenceFreshness,
      permissionDecision,
      notificationIntent,
    };
  }

  private shouldNotify(intent?: SubconsciousNotificationIntent): boolean {
    if (!intent) return false;
    const policy = this.getSettings().notificationPolicy;
    const hour = new Date().getHours();
    const inQuietHours =
      policy.quietHoursStart === policy.quietHoursEnd
        ? false
        : policy.quietHoursStart < policy.quietHoursEnd
          ? hour >= policy.quietHoursStart && hour < policy.quietHoursEnd
          : hour >= policy.quietHoursStart || hour < policy.quietHoursEnd;
    if (inQuietHours && intent !== "input_needed") return false;
    const enabled =
      (intent === "input_needed" && policy.inputNeeded) ||
      (intent === "important_action_taken" && policy.importantActionTaken) ||
      (intent === "completed_while_away" && policy.completedWhileAway);
    if (!enabled) return false;
    const lastNotifiedAt = this.lastNotificationByIntent.get(intent) || 0;
    return now() - lastNotifiedAt >= policy.throttleMinutes * 60 * 1000;
  }

  private shouldAutoDispatchDecision(input: {
    settings: SubconsciousSettings;
    target: SubconsciousTargetSummary;
    dispatchKind?: SubconsciousDispatchKind;
    policy: ReflectionPolicyEvaluation;
    evidence: SubconsciousEvidence[];
  }): boolean {
    if (!input.settings.dispatchDefaults.autoDispatch) return false;
    if (!input.dispatchKind) return false;
    if (input.policy.permissionDecision !== "allowed") return false;
    if (input.policy.riskLevel !== "low") return false;
    const workspaceId = input.target.target.workspaceId;
    if (!workspaceId) return false;
    if (input.settings.trustedTargetKeys.includes(input.target.key)) return true;
    const acceptedPatternCount = this.countAcceptedSuggestionPatterns(workspaceId);
    const hasClearScope =
      input.target.target.kind === "workspace" ||
      input.target.target.kind === "pull_request" ||
      input.target.target.kind === "code_workspace";
    return acceptedPatternCount >= 2 && hasClearScope && input.evidence.length <= 8;
  }

  private countAcceptedSuggestionPatterns(workspaceId: string): number {
    try {
      return MemoryService.search(workspaceId, "[suggestion-feedback:acted_on]", 20).length;
    } catch {
      return 0;
    }
  }

  private async notifyForRun(
    target: SubconsciousTargetRef,
    run: SubconsciousRun,
    decision?: SubconsciousDecision,
    dispatchRecord?: SubconsciousDispatchRecord | null,
  ): Promise<void> {
    if (dispatchRecord?.kind === "suggestion") return;
    if (!run.notificationIntent || !this.shouldNotify(run.notificationIntent)) return;
    this.lastNotificationByIntent.set(run.notificationIntent, now());
    await this.appendJournal({
      runId: run.id,
      targetKey: target.key,
      kind: "notification",
      summary: `Notification emitted for ${target.label}.`,
      details: run.notificationIntent,
      outcome: run.outcome,
    });
    await this.deps.notify?.({
      type: run.outcome === "failed" ? "warning" : "info",
      title:
        run.notificationIntent === "input_needed"
          ? "Workflow Intelligence needs input"
          : run.notificationIntent === "completed_while_away"
            ? "Workflow Intelligence completed work while you were away"
            : "Workflow Intelligence took action",
      message: `${target.label}: ${decision?.winnerSummary || run.evidenceSummary}`,
      workspaceId: target.workspaceId,
      taskId: dispatchRecord?.taskId,
    });
    logger.info("Notification emitted", {
      runId: run.id,
      targetKey: target.key,
      intent: run.notificationIntent,
      taskId: dispatchRecord?.taskId || null,
    });
  }

  private async finalizeTargetAfterRun(
    target: SubconsciousTargetSummary,
    run: SubconsciousRun,
    decision: SubconsciousDecision | undefined,
    dispatchRecord: SubconsciousDispatchRecord | null,
    evidence: SubconsciousEvidence[],
  ): Promise<void> {
    const updated = {
      state: "idle" as const,
      health: run.stage === "failed" ? ("blocked" as const) : target.health,
      lastWinner: decision?.winnerSummary || target.lastWinner,
      lastRunAt: run.completedAt,
      lastEvidenceAt: pick(evidence)?.createdAt || target.lastEvidenceAt,
      lastObservedAt: pick(evidence)?.createdAt || now(),
      lastActionAt: run.completedAt || now(),
      backlogCount: this.backlogRepo.countOpenByTarget(target.key),
      lastDispatchKind: dispatchRecord?.kind,
      lastDispatchStatus: dispatchRecord?.status,
      nextEligibleAt: this.computeNextEligibleAt(target, run.completedAt || now()),
      expiresAt: this.computeExpiryAt(pick(evidence)?.createdAt || target.lastEvidenceAt),
      lastMeaningfulOutcome: run.outcome,
    };
    this.targetRepo.update(target.key, updated);
    const nextTarget = this.targetRepo.findByKey(target.key) || { ...target, ...updated };
    await this.appendJournal({
      runId: run.id,
      targetKey: target.key,
      kind: "action",
      summary: `Run ${run.outcome || "completed"} for ${target.target.label}.`,
      details: dispatchRecord?.summary || decision?.recommendation || run.blockedReason,
      outcome: run.outcome,
    });
    await this.artifactStore.writeTargetState(
      nextTarget,
      evidence,
      this.backlogRepo.listByTarget(target.key, 50),
    );
    await this.artifactStore.writeBrainState(this.getBrainSummary(), this.targetRepo.list());
  }

  private async maybeRunDream(target?: SubconsciousTargetRef): Promise<void> {
    const settings = this.getSettings();
    if (!settings.dreamsEnabled) return;
    const cadenceMs = settings.dreamCadenceHours * 60 * 60 * 1000;
    if (this.lastDreamAt && now() - this.lastDreamAt < cadenceMs) return;
    const journal = await this.artifactStore.readJournalEntries(target?.key, 80);
    if (!journal.length) return;
    const digest = uniqueBy(
      journal
        .filter((entry) => entry.kind !== "notification")
        .slice(0, 6)
        .map((entry) => entry.summary),
      (entry) => entry,
    );
    const memoryUpdates: SubconsciousMemoryItem[] = digest.map((summary, index) => ({
      id: randomUUID(),
      targetKey: target?.key,
      bucket:
        index === 0
          ? "open_thread"
          : /pattern|guardrail|repeat|again/i.test(summary)
            ? "reliable_pattern"
            : "project_state",
      summary,
      confidence: clamp(0.55 + index * 0.05, 0.55, 0.85),
      stale: false,
      sourceRunIds: uniqueBy(
        journal.map((entry) => entry.runId).filter((value): value is string => Boolean(value)),
        (value) => value,
      ).slice(0, 6),
      createdAt: now(),
      updatedAt: now(),
      lastValidatedAt: now(),
    }));
    const artifact: SubconsciousDreamArtifact = {
      id: randomUUID(),
      targetKey: target?.key,
      createdAt: now(),
      digest,
      backlogProposals: uniqueBy(
        journal
          .filter((entry) => entry.outcome === "defer" || entry.kind === "decision")
          .map((entry) => entry.summary),
        (entry) => entry,
      ).slice(0, 5),
      targetHealthSummary: target
        ? `${target.label} is currently ${this.targetRepo.findByKey(target.key)?.health || "healthy"}.`
        : `Global brain reviewed ${journal.length} journal entries.`,
      memoryUpdates,
    };
    await this.artifactStore.writeDreamArtifact(target || null, artifact);
    await this.appendJournal({
      targetKey: target?.key,
      kind: "dream",
      summary: target ? `Reflection distilled ${target.label}.` : "Reflection distilled workflow intelligence.",
      details: digest.join(" | "),
    });
    this.lastDreamAt = artifact.createdAt;
    await this.artifactStore.writeBrainState(this.getBrainSummary(), this.targetRepo.list());
    logger.info("Reflection distilled", {
      targetKey: target?.key || null,
      digestCount: artifact.digest.length,
      backlogProposalCount: artifact.backlogProposals.length,
      memoryUpdateCount: artifact.memoryUpdates.length,
    });
  }

  private resolveGlobalRoot(): string {
    const preferred = this.deps.getGlobalRoot?.();
    if (preferred) return preferred;
    const workspace = this.resolveDefaultWorkspace();
    return workspace?.path || getUserDataDir();
  }

  private resolveDefaultWorkspace() {
    return this.workspaceRepo
      .findAll()
      .find((workspace) => !workspace.isTemp && Boolean(workspace.path));
  }

  private resolveWorkspacePath(workspaceId?: string): string | undefined {
    if (workspaceId) {
      return this.workspaceRepo.findById(workspaceId)?.path;
    }
    return this.resolveDefaultWorkspace()?.path;
  }

  private choosePrimaryCodeWorkspace(
    candidates: CodeWorkspaceTargetCandidate[],
  ): CodeWorkspaceTargetCandidate {
    return [...candidates].sort((a, b) => {
      if (isCoworkRepoIdentity(a.repoIdentity) !== isCoworkRepoIdentity(b.repoIdentity)) {
        return isCoworkRepoIdentity(a.repoIdentity) ? -1 : 1;
      }
      const aAtRoot = a.workspaceAtRepoRoot;
      const bAtRoot = b.workspaceAtRepoRoot;
      if (aAtRoot !== bAtRoot) {
        return aAtRoot ? -1 : 1;
      }
      const lastUsedDiff = (b.workspace.lastUsedAt || 0) - (a.workspace.lastUsedAt || 0);
      if (lastUsedDiff !== 0) return lastUsedDiff;
      return a.workspace.path.length - b.workspace.path.length;
    })[0];
  }

  private async collectCodeWorkspaceTargets(
    workspaces: Workspace[],
  ): Promise<Map<string, SubconsciousTargetRef>> {
    const inspectedResults = await Promise.all(
      workspaces.map(async (workspace): Promise<CodeWorkspaceTargetCandidate | null> => {
        if (!workspace.path) return null;
        const isGitRepo = await GitService.isGitRepo(workspace.path).catch(() => false);
        if (!isGitRepo) return null;
        const repoRoot = await GitService.getRepoRoot(workspace.path).catch(() => workspace.path);
        const [normalizedWorkspacePath, normalizedRepoRoot] = await Promise.all([
          normalizeComparablePath(workspace.path),
          normalizeComparablePath(repoRoot),
        ]);
        const remotes = await GitService.getRemotes(repoRoot);
        const preferredRemote = remotes.find((remote) => remote.name === "origin") || remotes[0];
        return {
          workspace,
          repoRoot,
          workspaceAtRepoRoot: normalizedWorkspacePath === normalizedRepoRoot,
          remoteName: preferredRemote?.name,
          remoteUrl: preferredRemote?.url,
          repoIdentity: normalizeRepoIdentity(
            GitService.normalizeGithubRepoIdentity(preferredRemote?.url || ""),
          ),
        };
      }),
    );
    const inspected = inspectedResults.filter(
      (entry): entry is CodeWorkspaceTargetCandidate => entry !== null,
    );

    const grouped = new Map<string, CodeWorkspaceTargetCandidate[]>();
    for (const candidate of inspected) {
      const groupKey = candidate.repoIdentity
        ? `github:${candidate.repoIdentity.toLowerCase()}`
        : `repo:${candidate.repoRoot}`;
      const existing = grouped.get(groupKey) || [];
      existing.push(candidate);
      grouped.set(groupKey, existing);
    }

    const targetsByWorkspaceId = new Map<string, SubconsciousTargetRef>();
    for (const candidates of grouped.values()) {
      const primary = this.choosePrimaryCodeWorkspace(candidates);
      const canonicalRepoRoot = primary.workspaceAtRepoRoot ? primary.workspace.path : primary.repoRoot;
      const targetKey = buildCodeTargetKey(primary);
      const label = isCoworkRepoIdentity(primary.repoIdentity)
        ? "CoWork OS source code"
        : primary.repoIdentity
          ? `${primary.repoIdentity} source code`
          : `${primary.workspace.name} source code`;
      const target: SubconsciousTargetRef = {
        key: targetKey,
        kind: "code_workspace",
        workspaceId: primary.workspace.id,
        codeWorkspacePath: canonicalRepoRoot,
        label,
        metadata: {
          repoRoot: canonicalRepoRoot,
          repoIdentity: primary.repoIdentity,
          remoteName: primary.remoteName,
          remoteUrl: primary.remoteUrl,
          workspaceIds: candidates.map((candidate) => candidate.workspace.id),
        },
      };
      for (const candidate of candidates) {
        targetsByWorkspaceId.set(candidate.workspace.id, target);
      }
    }

    return targetsByWorkspaceId;
  }

  private mergeTargetSummaries(
    target: SubconsciousTargetRef,
    current: SubconsciousTargetSummary | undefined,
    legacy: SubconsciousTargetSummary | undefined,
  ): SubconsciousTargetSummary {
    if (!current && !legacy) {
      return this.buildTargetSummary(target, [], 0);
    }
    return {
      key: target.key,
      target,
      health:
        current?.health === "blocked" || legacy?.health === "blocked"
          ? "blocked"
          : current?.health === "watch" || legacy?.health === "watch"
            ? "watch"
            : current?.health || legacy?.health || "healthy",
      state: current?.state === "active" || legacy?.state === "active" ? "active" : current?.state || legacy?.state || "idle",
      persistence: current?.persistence || legacy?.persistence || "durable",
      missedRunPolicy: current?.missedRunPolicy || legacy?.missedRunPolicy || "catchUp",
      nextEligibleAt: current?.nextEligibleAt || legacy?.nextEligibleAt,
      lastObservedAt: Math.max(current?.lastObservedAt || 0, legacy?.lastObservedAt || 0) || undefined,
      lastActionAt: Math.max(current?.lastActionAt || 0, legacy?.lastActionAt || 0) || undefined,
      expiresAt: Math.max(current?.expiresAt || 0, legacy?.expiresAt || 0) || undefined,
      jitterMs: current?.jitterMs || legacy?.jitterMs,
      lastMeaningfulOutcome: current?.lastMeaningfulOutcome || legacy?.lastMeaningfulOutcome,
      lastWinner: current?.lastWinner || legacy?.lastWinner,
      lastRunAt: Math.max(current?.lastRunAt || 0, legacy?.lastRunAt || 0) || undefined,
      lastEvidenceAt: Math.max(current?.lastEvidenceAt || 0, legacy?.lastEvidenceAt || 0) || undefined,
      backlogCount: Math.max(current?.backlogCount || 0, legacy?.backlogCount || 0),
      evidenceFingerprint: current?.evidenceFingerprint || legacy?.evidenceFingerprint,
      lastDispatchKind: current?.lastDispatchKind || legacy?.lastDispatchKind,
      lastDispatchStatus: current?.lastDispatchStatus || legacy?.lastDispatchStatus,
    };
  }

  private rekeyTargetRecords(oldKey: string, nextTarget: SubconsciousTargetRef): void {
    if (oldKey === nextTarget.key) return;
    const legacySummary = this.targetRepo.findByKey(oldKey);
    if (!legacySummary) return;
    const currentSummary = this.targetRepo.findByKey(nextTarget.key);
    const merged = this.mergeTargetSummaries(nextTarget, currentSummary, legacySummary);

    const rekeyTx = this.db.transaction(() => {
      this.targetRepo.upsert({
        ...merged,
        backlogCount: Math.max(currentSummary?.backlogCount || 0, legacySummary.backlogCount || 0),
      });

      const updates = [
        "UPDATE subconscious_runs SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_hypotheses SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_critiques SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_decisions SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_backlog_items SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_dispatch_records SET target_key = ? WHERE target_key = ?",
      ];
      for (const sql of updates) {
        this.db.prepare(sql).run(nextTarget.key, oldKey);
      }

      this.db.prepare("DELETE FROM subconscious_targets WHERE target_key = ?").run(oldKey);

      this.targetRepo.upsert({
        ...merged,
        backlogCount: this.backlogRepo.countOpenByTarget(nextTarget.key),
      });
    });

    rekeyTx();
  }

  private async collectTargets(enabledKinds: SubconsciousTargetKind[]) {
    const collected = new Map<string, { target: SubconsciousTargetRef; evidence: SubconsciousEvidence[] }>();
    const ensure = (target: SubconsciousTargetRef) => {
      if (!enabledKinds.includes(target.kind)) return null;
      if (!collected.has(target.key)) {
        collected.set(target.key, { target, evidence: [] });
      }
      return collected.get(target.key)!;
    };
    const pushEvidence = (target: SubconsciousTargetRef, evidence: Omit<SubconsciousEvidence, "id" | "targetKey">) => {
      const entry = ensure(target);
      if (!entry) return;
      entry.evidence.push({
        id: randomUUID(),
        targetKey: target.key,
        ...evidence,
      });
    };

    const globalTarget: SubconsciousTargetRef = {
      key: "global:brain",
      kind: "global",
      label: "Global brain",
    };
    ensure(globalTarget);

    const workspaces = this.workspaceRepo.findAll().filter((item) => !item.isTemp && item.path);
    const codeTargetsByWorkspaceId = await this.collectCodeWorkspaceTargets(workspaces);

    for (const workspace of workspaces) {
      const workspaceTarget: SubconsciousTargetRef = {
        key: `workspace:${workspace.id}`,
        kind: "workspace",
        workspaceId: workspace.id,
        label: workspace.name,
      };
      ensure(workspaceTarget);
      const codeTarget = codeTargetsByWorkspaceId.get(workspace.id);
      if (codeTarget) {
        ensure(codeTarget);
        this.rekeyTargetRecords(`code_workspace:${workspace.id}`, codeTarget);
      }
    }

    if (this.hasTable("tasks")) {
      const taskRows = this.db
        .prepare(
          `SELECT id, workspace_id, title, status, failure_class, result_summary, updated_at, source
           FROM tasks
           ORDER BY updated_at DESC
           LIMIT 200`,
        )
        .all() as Any[];
      for (const row of taskRows) {
        if (isSelfGeneratedSubconsciousTask(row)) {
          continue;
        }
        const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : undefined;
        if (!workspaceId) continue;
        const workspace = this.workspaceRepo.findById(workspaceId);
        if (!workspace || workspace.isTemp) continue;
        pushEvidence(
          {
            key: `workspace:${workspaceId}`,
            kind: "workspace",
            workspaceId,
            label: workspace.name,
          },
          {
            type: "task_signal",
            summary: `${row.status}: ${row.title}`,
            details: row.result_summary || row.failure_class || undefined,
            fingerprint: stableHash(["task", row.id, row.status, row.failure_class]),
            createdAt: Number(row.updated_at || now()),
            metadata: {
              taskId: row.id,
              source: row.source,
            },
          },
        );
        if (row.failure_class || row.status === "failed") {
          const codeTarget = codeTargetsByWorkspaceId.get(workspaceId);
          if (codeTarget) {
            pushEvidence(codeTarget, {
              type: "code_failure",
              summary: `${row.title} failed`,
              details: row.failure_class || row.result_summary || undefined,
              fingerprint: stableHash(["code", row.id, row.failure_class, row.status]),
              createdAt: Number(row.updated_at || now()),
              metadata: { taskId: row.id },
            });
          }
        }
      }
    }

    if (this.hasTable("memory_markdown_files")) {
      const rows = this.db
        .prepare(
          `SELECT workspace_id, path, updated_at
           FROM memory_markdown_files
           WHERE path LIKE '%.cowork/%' OR path LIKE '%playbook%'
           ORDER BY updated_at DESC
           LIMIT 100`,
        )
        .all() as Any[];
      for (const row of rows) {
        const workspace = this.workspaceRepo.findById(String(row.workspace_id));
        if (!workspace || workspace.isTemp) continue;
        pushEvidence(
          {
            key: `workspace:${workspace.id}`,
            kind: "workspace",
            workspaceId: workspace.id,
            label: workspace.name,
          },
          {
            type: "memory_playbook",
            summary: `Updated durable context: ${row.path}`,
            fingerprint: stableHash(["memory", row.workspace_id, row.path, row.updated_at]),
            createdAt: Number(row.updated_at || now()),
          },
        );
      }
    }

    if (this.hasTable("mailbox_events")) {
      const rows = this.db
        .prepare(
          `SELECT thread_id, workspace_id, subject, summary_text, created_at, last_seen_at
           FROM mailbox_events
           WHERE thread_id IS NOT NULL
           ORDER BY last_seen_at DESC
           LIMIT 50`,
        )
        .all() as Any[];
      for (const row of rows) {
        const workspace = this.workspaceRepo.findById(String(row.workspace_id));
        const target: SubconsciousTargetRef = {
          key: workspace?.id ? `workspace:${workspace.id}` : "global:brain",
          kind: workspace?.id ? "workspace" : "global",
          workspaceId: workspace?.id,
          label: workspace?.name || "Global brain",
          metadata: { sourceType: "mailbox_thread", threadId: String(row.thread_id) },
        };
        pushEvidence(target, {
          type: "mailbox_event",
          summary: String(row.summary_text || row.subject || "Mailbox signal"),
          fingerprint: stableHash(["mailbox", row.thread_id, row.last_seen_at, row.summary_text]),
          createdAt: Number(row.last_seen_at || row.created_at || now()),
        });
      }
    }

    if (this.hasTable("automation_profiles") && this.hasTable("agent_roles")) {
      const rows = this.db
        .prepare(
          `SELECT ap.agent_role_id AS id,
                  ar.name,
                  ar.display_name,
                  ap.last_heartbeat_at,
                  ap.heartbeat_status,
                  ap.heartbeat_last_pulse_result
           FROM automation_profiles ap
           JOIN agent_roles ar ON ar.id = ap.agent_role_id
           WHERE ap.enabled = 1
             AND COALESCE(ar.is_active, 1) = 1
             AND COALESCE(ar.role_kind, 'custom') != 'persona_template'`,
        )
        .all() as Any[];
      for (const row of rows) {
        const label = String(row.display_name || row.name || row.id);
        const target: SubconsciousTargetRef = {
          key: `agent_role:${row.id}`,
          kind: "agent_role",
          agentRoleId: String(row.id),
          label,
        };
        ensure(target);
        const heartbeatStatus = String(row.heartbeat_status || "idle");
        const pulseResult = row.heartbeat_last_pulse_result;
        if (heartbeatStatus === "error" || isActionableHeartbeatPulseResult(pulseResult)) {
          pushEvidence(target, {
            type: "heartbeat_signal",
            summary: `Heartbeat ${heartbeatStatus} for ${label}`,
            details: typeof pulseResult === "string" ? pulseResult : undefined,
            fingerprint: stableHash(["heartbeat", row.id, row.last_heartbeat_at, row.heartbeat_status, pulseResult]),
            createdAt: Number(row.last_heartbeat_at || now()),
          });
        }
      }
    }

    if (this.hasTable("heartbeat_runs")) {
      const rows = this.db
        .prepare(
          `SELECT id, workspace_id, agent_role_id, run_type, dispatch_kind, reason, status, summary, error, updated_at
           FROM heartbeat_runs
           ORDER BY updated_at DESC
           LIMIT 50`,
        )
        .all() as Any[];
      for (const row of rows) {
        if (!isActionableHeartbeatRun(row)) {
          continue;
        }
        const key = row.agent_role_id ? `agent_role:${row.agent_role_id}` : `workspace:${row.workspace_id}`;
        const target = collected.get(key)?.target;
        if (!target) continue;
        pushEvidence(target, {
          type: "heartbeat_run",
          summary: row.summary
            ? `Heartbeat ${row.status || "unknown"}: ${row.summary}`
            : `Heartbeat run ${row.status || "unknown"}`,
          details: row.error || row.reason || undefined,
          fingerprint: stableHash([
            "heartbeat_run",
            row.id,
            row.status,
            row.summary,
            row.error,
            row.reason,
            row.dispatch_kind,
            row.updated_at,
          ]),
          createdAt: Number(row.updated_at || now()),
        });
      }
    }

    if (this.hasTable("event_triggers")) {
      const rows = this.db
        .prepare(
          `SELECT id, name, workspace_id, enabled, source, updated_at
           FROM event_triggers
           ORDER BY updated_at DESC`,
        )
        .all() as Any[];
      for (const row of rows) {
        const workspaceId =
          typeof row.workspace_id === "string" && row.workspace_id.trim().length > 0
            ? String(row.workspace_id)
            : undefined;
        const target: SubconsciousTargetRef = {
          key: workspaceId ? `workspace:${workspaceId}` : "global:brain",
          kind: workspaceId ? "workspace" : "global",
          workspaceId,
          label: workspaceId ? `Workspace ${workspaceId}` : "Global brain",
          metadata: { sourceType: "event_trigger", triggerId: String(row.id), source: row.source },
        };
        pushEvidence(target, {
          type: "event_trigger",
          summary: `${row.enabled ? "Enabled" : "Paused"} trigger: ${row.name}`,
          fingerprint: stableHash(["trigger", row.id, row.updated_at, row.enabled]),
          createdAt: Number(row.updated_at || now()),
        });
      }
    }

    const cronStore = loadCronStoreSync(getCronStorePath());
    for (const job of cronStore.jobs) {
      const target: SubconsciousTargetRef = {
        key: job.workspaceId ? `workspace:${job.workspaceId}` : "global:brain",
        kind: job.workspaceId ? "workspace" : "global",
        workspaceId: job.workspaceId,
        label: job.workspaceId ? `Workspace ${job.workspaceId}` : "Global brain",
        metadata: { sourceType: "scheduled_task", scheduledTaskId: job.id, jobName: job.name },
      };
      pushEvidence(target, {
        type: "scheduled_task",
        summary: `${job.enabled ? "Enabled" : "Paused"} scheduled task: ${job.name}`,
        details: job.taskTitle || job.taskPrompt,
        fingerprint: stableHash(["scheduled", job.id, job.updatedAtMs, job.enabled]),
        createdAt: Number(job.updatedAtMs || job.createdAtMs || now()),
      });
    }

    if (this.hasTable("briefing_config")) {
      const rows = this.db
        .prepare(
          `SELECT workspace_id, enabled, schedule_time, updated_at
           FROM briefing_config`,
        )
        .all() as Any[];
      for (const row of rows) {
        const workspace = this.workspaceRepo.findById(String(row.workspace_id));
        const target: SubconsciousTargetRef = {
          key: `workspace:${row.workspace_id}`,
          kind: "workspace",
          workspaceId: String(row.workspace_id),
          label: workspace ? workspace.name : `Workspace ${row.workspace_id}`,
          metadata: { sourceType: "briefing", briefingId: String(row.workspace_id) },
        };
        pushEvidence(target, {
          type: "briefing",
          summary: `${row.enabled ? "Enabled" : "Paused"} briefing at ${row.schedule_time || "08:00"}`,
          fingerprint: stableHash(["briefing", row.workspace_id, row.schedule_time, row.updated_at, row.enabled]),
          createdAt: Number(row.updated_at || now()),
        });
      }
    }

    if (this.hasTable("improvement_runs")) {
      const rows = this.db
        .prepare(
          `SELECT id, workspace_id, status, review_status, promotion_status, promotion_error, pull_request, completed_at, created_at
           FROM improvement_runs
           WHERE pull_request IS NOT NULL AND pull_request != ''
           ORDER BY COALESCE(completed_at, created_at) DESC
           LIMIT 50`,
        )
        .all() as Any[];
      for (const row of rows) {
        const pullRequest = this.safeJsonParseRecord(row.pull_request);
        const prNumber = pullRequest?.number || pullRequest?.url || row.id;
        const target: SubconsciousTargetRef = {
          key: `pull_request:${prNumber}`,
          kind: "pull_request",
          workspaceId: row.workspace_id || undefined,
          pullRequestId: String(prNumber),
          label: pullRequest?.title || `Pull request ${prNumber}`,
          metadata: {
            url: pullRequest?.url,
            branchName: pullRequest?.branchName,
            baseBranch: pullRequest?.baseBranch,
          },
        };
        const signals: string[] = [];
        if (row.review_status && row.review_status !== "accepted") signals.push("review requested");
        if (row.promotion_status === "promotion_failed") signals.push("CI failed");
        if (row.promotion_error) signals.push("comments unresolved");
        if (row.status === "running" || row.status === "queued") signals.push("inactivity timeout");
        pushEvidence(target, {
          type: "pull_request_activity",
          summary: `${signals.join(", ") || "pull request activity"}: ${target.label}`,
          details: pullRequest?.url || row.promotion_error || undefined,
          fingerprint: stableHash(["pull_request", prNumber, row.status, row.review_status, row.promotion_status, row.promotion_error]),
          createdAt: Number(row.completed_at || row.created_at || now()),
        });
      }
    }

    for (const [key, value] of collected.entries()) {
      if (key === globalTarget.key) continue;
      const newest = value.evidence.sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!newest) continue;
      pushEvidence(globalTarget, {
        type: value.target.kind,
        summary: `${value.target.label}: ${newest.summary}`,
        details: newest.details,
        fingerprint: stableHash(["global", key, newest.fingerprint]),
        createdAt: newest.createdAt,
      });
    }

    return collected;
  }

  private buildTargetSummary(
    target: SubconsciousTargetRef,
    evidence: SubconsciousEvidence[],
    backlogCount: number,
    current?: SubconsciousTargetSummary,
  ): SubconsciousTargetSummary {
    const lastDecision = this.decisionRepo.findLatestByTarget(target.key);
    const lastDispatch = pick(this.dispatchRepo.listByTarget(target.key, 1));
    const lastEvidenceAt = pick(evidence)?.createdAt || current?.lastEvidenceAt;
    const settings = this.getSettings();
    const persistence = settings.durableTargetKinds.includes(target.kind) ? "durable" : "sessionOnly";
    const jitterMs = current?.jitterMs ?? this.computeJitterMs(target.key, settings.cadenceMinutes);
    let health: SubconsciousHealth = "healthy";
    if (evidence.some((item) => item.type === "code_failure")) {
      health = "blocked";
    } else if (evidence.length >= 3) {
      health = "watch";
    } else if (current?.health) {
      health = current.health;
    }
    return {
      key: target.key,
      target,
      health,
      state: current?.state === "active" ? "active" : "idle",
      persistence,
      missedRunPolicy: settings.catchUpOnRestart ? "catchUp" : "skip",
      nextEligibleAt: current?.nextEligibleAt,
      lastObservedAt: lastEvidenceAt || current?.lastObservedAt,
      lastActionAt: current?.lastActionAt,
      expiresAt: this.computeExpiryAt(lastEvidenceAt) || current?.expiresAt,
      jitterMs,
      lastMeaningfulOutcome: current?.lastMeaningfulOutcome,
      lastWinner: lastDecision?.winnerSummary || current?.lastWinner,
      lastRunAt: this.runRepo.list({ targetKey: target.key, limit: 1 })[0]?.completedAt,
      lastEvidenceAt,
      backlogCount,
      evidenceFingerprint: evidence.length
        ? stableHash(evidence.map((item) => item.fingerprint))
        : current?.evidenceFingerprint,
      lastDispatchKind: lastDispatch?.kind,
      lastDispatchStatus: lastDispatch?.status,
    };
  }

  private isTargetActionable(target: SubconsciousTargetSummary): boolean {
    const evidence = this.latestEvidenceByTarget.get(target.key) || [];
    if (evidence.some(isActionableEvidenceSignal)) return true;
    if (target.backlogCount > 0) return this.hasFreshActionableEvidence(target);
    if (target.lastMeaningfulOutcome === "defer") return this.hasFreshActionableEvidence(target);
    return false;
  }

  private scoreTargetForRun(target: SubconsciousTargetSummary): number {
    const evidence = this.latestEvidenceByTarget.get(target.key) || [];
    const latestEvidenceAt = evidence[0]?.createdAt || target.lastEvidenceAt || 0;
    const freshnessHours = latestEvidenceAt ? (now() - latestEvidenceAt) / (60 * 60 * 1000) : 9999;
    const freshnessBonus = latestEvidenceAt ? Math.max(0, 3 - Math.min(3, freshnessHours / 12)) : 0;
    const actionableEvidenceCount = evidence.filter(isActionableEvidenceSignal).length;
    const usefulnessBonus = scoreEvidenceUsefulness(evidence) * 4;
    return (
      target.backlogCount * 3 +
      actionableEvidenceCount * 2 +
      usefulnessBonus +
      (target.health === "blocked" ? 4 : target.health === "watch" ? 1.5 : 0) +
      (target.lastMeaningfulOutcome === "defer" ? 1.5 : 0) +
      freshnessBonus
    );
  }

  private listEligibleTargetsForRun(workspaceId?: string): SubconsciousTargetSummary[] {
    const currentTime = now();
    return this.targetRepo
      .list()
      .filter((target) => target.key !== "global:brain")
      .filter((target) => !workspaceId || !target.target.workspaceId || target.target.workspaceId === workspaceId)
      .filter((target) => !target.expiresAt || target.expiresAt > currentTime)
      .filter((target) => !target.nextEligibleAt || target.nextEligibleAt <= currentTime)
      .filter((target) => this.isTargetActionable(target))
      .sort((a, b) => {
        const priorityA = this.scoreTargetForRun(a);
        const priorityB = this.scoreTargetForRun(b);
        if (priorityB !== priorityA) return priorityB - priorityA;
        return (b.lastEvidenceAt || 0) - (a.lastEvidenceAt || 0);
      });
  }

  private pickTargetForRun(workspaceId?: string): SubconsciousTargetSummary | undefined {
    return this.listEligibleTargetsForRun(workspaceId)[0];
  }

  private generateHypotheses(
    target: SubconsciousTargetRef,
    evidence: SubconsciousEvidence[],
    maxHypotheses: number,
  ): SubconsciousHypothesis[] {
    const seed = evidence.map((item) => item.summary).slice(0, 3).join("; ");
    const base: Array<Pick<SubconsciousHypothesis, "title" | "summary" | "rationale" | "confidence">> = [
      {
        title: `Respond directly to ${target.label}`,
        summary: `Turn the dominant signal into a concrete ${humanizeDispatchKind(this.resolveDispatchKind(target, evidence))}.`,
        rationale: `The latest evidence points to a specific recurring need: ${seed || "fresh evidence is limited but actionable."}`,
        confidence: 0.84,
      },
      {
        title: `Add a durable guardrail for ${target.label}`,
        summary: "Prevent the same failure or drift from resurfacing on the next run.",
        rationale: "A broader fix is justified when signals repeat or the blast radius spans multiple tasks.",
        confidence: 0.73,
      },
      {
        title: `Refine the operator backlog for ${target.label}`,
        summary: "Capture the lesson in backlog form even if direct dispatch is not the best immediate move.",
        rationale: "A namespaced backlog makes the next run start with explicit context instead of rediscovering the same lesson.",
        confidence: 0.67,
      },
      {
        title: `Tune workflow routing around ${target.label}`,
        summary: "Adjust cadence, executor choice, or automation shape so the workflow stops wasting turns.",
        rationale: "Some failures are orchestration mismatches rather than missing work.",
        confidence: 0.62,
      },
    ];
    return limit(base, maxHypotheses).map((item, index) => ({
      id: randomUUID(),
      runId: "",
      targetKey: target.key,
      title: item.title,
      summary: item.summary,
      rationale: item.rationale,
      confidence: item.confidence - index * 0.04,
      evidenceRefs: evidence.slice(0, 3).map((entry) => entry.id),
      status: "proposed",
      createdAt: now() + index,
    }));
  }

  private generateCritiques(
    target: SubconsciousTargetRef,
    evidence: SubconsciousEvidence[],
    hypotheses: SubconsciousHypothesis[],
  ): SubconsciousCritique[] {
    const executor = this.resolveDispatchKind(target, evidence);
    return hypotheses.map((hypothesis, index) => {
      const weakEvidence = evidence.length < 2 && index > 0;
      const noExecutor = !executor && /dispatch|task|workflow|automation/i.test(hypothesis.summary);
      const verdict = weakEvidence || noExecutor ? "reject" : index === 0 ? "support" : "mixed";
      return {
        id: randomUUID(),
        runId: "",
        targetKey: target.key,
        hypothesisId: hypothesis.id,
        verdict,
        objection: noExecutor
          ? "The target has no valid executor mapping, so a dispatch-shaped recommendation would not compound yet."
          : weakEvidence
            ? "Evidence is still thin, so this should stay narrower until another confirming signal lands."
            : "The idea is viable, but it must stay concrete and tied to the current evidence cluster.",
        response:
          verdict === "support"
            ? "The hypothesis matches both the evidence density and the target's executor boundary."
            : verdict === "mixed"
              ? "Keep the hypothesis, but cut the scope to the smallest durable move."
              : "Reject this path for now and keep it in the backlog instead of dispatching it.",
        evidenceRefs: hypothesis.evidenceRefs,
        createdAt: now() + index,
      };
    });
  }

  private synthesizeDecision(
    target: SubconsciousTargetRef,
    evidence: SubconsciousEvidence[],
    hypotheses: SubconsciousHypothesis[],
    critiques: SubconsciousCritique[],
  ): SubconsciousDecision {
    const scored = hypotheses.map((hypothesis) => {
      const critique = critiques.find((item) => item.hypothesisId === hypothesis.id);
      const verdictBoost =
        critique?.verdict === "support" ? 0.12 : critique?.verdict === "mixed" ? 0.03 : -0.2;
      return {
        hypothesis,
        score: hypothesis.confidence + verdictBoost + Math.min(evidence.length, 4) * 0.02,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0]?.hypothesis || hypotheses[0];
    const rejected = scored.slice(1).map((item) => item.hypothesis.id);
    const executor = this.resolveDispatchKind(target, evidence);
    const nextBacklog = [
      `Preserve the winner for ${target.label} and measure whether the next evidence cluster gets narrower.`,
      `Reject overly broad paths unless they earn more evidence or a clearer executor mapping.`,
      executor
        ? `Track dispatch results for ${executor} and fold the outcome back into the next run.`
        : `No executor exists yet; keep the recommendation durable and wait for a valid mapping.`,
    ];
    return {
      id: randomUUID(),
      runId: "",
      targetKey: target.key,
      winningHypothesisId: winner.id,
      winnerSummary: winner.summary,
      recommendation: `${winner.title}. ${winner.summary} Evidence: ${evidence
        .slice(0, 3)
        .map((item) => item.summary)
        .join(" | ")}`,
      rejectedHypothesisIds: rejected,
      rationale: critiques.find((item) => item.hypothesisId === winner.id)?.response || winner.rationale,
      nextBacklog,
      outcome: executor ? "dispatch" : "suggest",
      createdAt: now(),
    };
  }

  private materializeBacklog(
    targetKey: string,
    decision: SubconsciousDecision,
    executorKind?: SubconsciousDispatchKind,
  ): SubconsciousBacklogItem[] {
    const items = decision.nextBacklog.map((entry, index) =>
      this.backlogRepo.createOrRefreshOpen({
        targetKey,
        title: index === 0 ? "Keep the winner durable" : `Backlog step ${index + 1}`,
        summary: entry,
        status: "open",
        priority: Math.max(1, 100 - index * 10),
        executorKind,
        sourceRunId: decision.runId,
      }),
    );
    return items;
  }

  private resolveDispatchKind(
    target: SubconsciousTargetRef,
    evidence?: SubconsciousEvidence[],
  ): SubconsciousDispatchKind | undefined {
    const settings = this.getSettings();
    const configured = settings.dispatchDefaults.defaultKinds[target.kind];
    const usefulness = evidence ? scoreEvidenceUsefulness(evidence) : 1;
    if (configured === "task" && usefulness < 0.65) {
      return "suggestion";
    }
    if (
      target.kind === "agent_role" &&
      configured === "task" &&
      settings.autonomyMode !== "strong_autonomy"
    ) {
      return "suggestion";
    }
    return configured;
  }

  private async resolveDispatchWorkspace(target: SubconsciousTargetRef): Promise<Workspace | undefined> {
    if (target.kind !== "code_workspace") {
      return target.workspaceId
        ? this.workspaceRepo.findById(target.workspaceId)
        : this.resolveDefaultWorkspace();
    }

    const repoRoot =
      typeof target.metadata?.repoRoot === "string"
        ? target.metadata.repoRoot
        : target.codeWorkspacePath;
    const normalizedRepoRoot = repoRoot ? await normalizeComparablePath(repoRoot) : undefined;
    const workspaceIds = Array.isArray(target.metadata?.workspaceIds)
      ? target.metadata.workspaceIds.filter((value): value is string => typeof value === "string")
      : [];
    const candidates = [
      ...(target.workspaceId ? [target.workspaceId] : []),
      ...workspaceIds,
    ];
    for (const workspaceId of candidates) {
      const workspace = this.workspaceRepo.findById(workspaceId);
      if (!workspace || workspace.isTemp || !workspace.path) continue;
      if (!normalizedRepoRoot) return workspace;
      const resolvedRepoRoot = await GitService.getRepoRoot(workspace.path).catch(() => null);
      const normalizedWorkspaceRepoRoot = resolvedRepoRoot
        ? await normalizeComparablePath(resolvedRepoRoot)
        : null;
      if (normalizedWorkspaceRepoRoot === normalizedRepoRoot) {
        return workspace;
      }
    }

    if (normalizedRepoRoot) {
      for (const workspace of this.workspaceRepo.findAll()) {
        if (workspace.isTemp || !workspace.path) continue;
        const resolvedRepoRoot = await GitService.getRepoRoot(workspace.path).catch(() => null);
        const normalizedWorkspaceRepoRoot = resolvedRepoRoot
          ? await normalizeComparablePath(resolvedRepoRoot)
          : null;
        if (normalizedWorkspaceRepoRoot === normalizedRepoRoot) {
          return workspace;
        }
      }
    }

    return undefined;
  }

  private async dispatchSuggestionForReview(
    target: SubconsciousTargetRef,
    decision: SubconsciousDecision,
    evidence: SubconsciousEvidence[],
  ): Promise<SubconsciousDispatchRecord | null> {
    const policy = this.getSettings().perExecutorPolicy.suggestion;
    if (policy && policy.enabled === false) {
      return this.skippedDispatch(decision, target, "suggestion", "Suggestion policy is disabled.");
    }
    const workspace = await this.resolveDispatchWorkspace(target);
    const workspaceId = workspace?.id || target.workspaceId || this.resolveDefaultWorkspace()?.id;
    if (!workspaceId) {
      return this.skippedDispatch(decision, target, "suggestion", "Suggestion dispatch needs a workspace.");
    }
    const suggestion = await ProactiveSuggestionsService.createCompanionSuggestion(workspaceId, {
      title: `Workflow Intelligence: ${target.label}`,
      description: decision.winnerSummary,
      actionPrompt: decision.recommendation,
      confidence: 0.72,
      suggestionClass: "open_loop",
      sourceEntity: target.key,
      sourceSignals: Array.from(new Set(evidence.map((item) => item.type))).slice(0, 5),
      recommendedDelivery: "inbox",
      companionStyle: "note",
    });
    if (!suggestion) {
      return this.skippedDispatch(decision, target, "suggestion", "Suggestion deduplicated or unavailable.");
    }
    return this.completedDispatch(decision, target, "suggestion", {
      externalRefId: suggestion.id,
      summary: `Created review suggestion ${suggestion.id}.`,
    });
  }

  private async dispatchDecision(
    target: SubconsciousTargetRef,
    decision: SubconsciousDecision,
    evidence: SubconsciousEvidence[],
  ): Promise<SubconsciousDispatchRecord | null> {
    const dispatchKind = this.resolveDispatchKind(target, evidence);
    if (!dispatchKind) {
      return null;
    }
    const policyKey = toDispatchPolicyKey(dispatchKind);
    const policy = this.getSettings().perExecutorPolicy[policyKey as keyof SubconsciousSettings["perExecutorPolicy"]];
    if (policy && "enabled" in policy && policy.enabled === false) {
      return {
        id: randomUUID(),
        runId: decision.runId,
        targetKey: target.key,
        kind: dispatchKind,
        status: "skipped",
        summary: "Dispatch policy disabled this executor.",
        createdAt: now(),
      };
    }

    const workspace = await this.resolveDispatchWorkspace(target);
    const workspaceId = workspace?.id || target.workspaceId || this.resolveDefaultWorkspace()?.id;
    const prompt = `${decision.recommendation}\n\nEvidence:\n${evidence
      .slice(0, 5)
      .map((item) => `- ${item.summary}`)
      .join("\n")}`;
    try {
      switch (dispatchKind) {
        case "task": {
          if (!this.agentDaemon || !workspaceId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Task dispatch is unavailable.");
          }
          const task = await this.agentDaemon.createTask({
            title: `Workflow Intelligence: ${target.label}`,
            prompt,
            workspaceId,
            source: "subconscious",
            agentConfig: buildCoreAutomationAgentConfig(),
          });
          return this.completedDispatch(decision, target, dispatchKind, {
            taskId: task.id,
            summary: `Created task ${task.id}.`,
          });
        }
        case "suggestion": {
          if (!workspaceId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Suggestion dispatch needs a workspace.");
          }
          const suggestion = await ProactiveSuggestionsService.createCompanionSuggestion(workspaceId, {
            title: `Workflow Intelligence: ${target.label}`,
            description: decision.winnerSummary,
            actionPrompt: decision.recommendation,
            confidence: 0.78,
            suggestionClass: "general",
            sourceEntity: target.key,
            sourceSignals: Array.from(new Set(evidence.map((item) => item.type))).slice(0, 5),
            recommendedDelivery: "inbox",
            companionStyle: "note",
          });
          if (!suggestion) {
            return this.skippedDispatch(decision, target, dispatchKind, "Suggestion deduplicated or unavailable.");
          }
          return this.completedDispatch(decision, target, dispatchKind, {
            externalRefId: suggestion.id,
            summary: `Created suggestion ${suggestion.id}.`,
          });
        }
        case "notify": {
          await this.deps.notify?.({
            type: "info",
            title: `Workflow Intelligence: ${target.label}`,
            message: decision.winnerSummary,
            workspaceId,
          });
          return this.completedDispatch(decision, target, dispatchKind, {
            summary: "Delivered a notification-only workflow intelligence outcome.",
          });
        }
        case "code_change_task": {
          if (!this.agentDaemon || !workspaceId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Code dispatch is unavailable.");
          }
          const requireWorktree = this.getSettings().perExecutorPolicy.codeChangeTask.requireWorktree;
          if (!workspace) {
            return this.skippedDispatch(decision, target, dispatchKind, "Code workspace is unavailable.");
          }
          if (requireWorktree) {
            const canUseWorktree = await this.agentDaemon
              .getWorktreeManager()
              .shouldUseWorktree(workspace.path, workspace.isTemp, true);
            if (!canUseWorktree) {
              return this.skippedDispatch(
                decision,
                target,
                dispatchKind,
                "Worktree isolation is unavailable for this workspace, so the run stays recommendation-only.",
              );
            }
          }
          const task = await this.agentDaemon.createTask({
            title: `Workflow Intelligence code change: ${target.label}`,
            prompt: `${prompt}\n\nOperate with worktree isolation, strict review, and verification.`,
            workspaceId,
            source: "subconscious",
            taskOverrides: {
              workerRole: "implementer",
            },
            agentConfig: buildCoreAutomationAgentConfig(undefined, {
              llmProfile: "strong",
              requireWorktree: this.getSettings().perExecutorPolicy.codeChangeTask.requireWorktree,
              verificationAgent: this.getSettings().perExecutorPolicy.codeChangeTask.verificationRequired,
              reviewPolicy: this.getSettings().perExecutorPolicy.codeChangeTask.strictReview
                ? "strict"
                : "balanced",
            }),
          });
          return this.completedDispatch(decision, target, dispatchKind, {
            taskId: task.id,
            summary: `Created code change task ${task.id}.`,
          });
        }
      }
    } catch (error) {
      return {
        id: randomUUID(),
        runId: decision.runId,
        targetKey: target.key,
        kind: dispatchKind,
        status: "failed",
        summary: "Dispatch failed.",
        error: error instanceof Error ? error.message : String(error),
        createdAt: now(),
        completedAt: now(),
      };
    }
  }

  private completedDispatch(
    decision: SubconsciousDecision,
    target: SubconsciousTargetRef,
    kind: SubconsciousDispatchKind,
    input: { taskId?: string; externalRefId?: string; summary: string },
  ): SubconsciousDispatchRecord {
    return {
      id: randomUUID(),
      runId: decision.runId,
      targetKey: target.key,
      kind,
      status: input.taskId ? "dispatched" : "completed",
      taskId: input.taskId,
      externalRefId: input.externalRefId,
      summary: input.summary,
      createdAt: now(),
      completedAt: now(),
    };
  }

  private skippedDispatch(
    decision: SubconsciousDecision,
    target: SubconsciousTargetRef,
    kind: SubconsciousDispatchKind,
    summary: string,
  ): SubconsciousDispatchRecord {
    return {
      id: randomUUID(),
      runId: decision.runId,
      targetKey: target.key,
      kind,
      status: "skipped",
      summary,
      createdAt: now(),
      completedAt: now(),
    };
  }

  private async advanceRun(id: string, updates: Partial<SubconsciousRun>): Promise<SubconsciousRun> {
    this.runRepo.update(id, updates);
    return this.runRepo.findById(id)!;
  }

  private safeJsonParseRecord(value: unknown): Record<string, any> | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    try {
      return JSON.parse(value) as Record<string, any>;
    } catch {
      return undefined;
    }
  }

  private hasTable(name: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return Boolean(row);
  }
}
