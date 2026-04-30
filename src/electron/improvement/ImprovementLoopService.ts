import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { AgentDaemon } from "../agent/daemon";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";
import type {
  ImprovementCampaign,
  ImprovementCandidate,
  ImprovementFailureClass,
  ImprovementHistoryResetResult,
  ImprovementLoopSettings,
  ImprovementReviewStatus,
  ImprovementVariantLane,
  ImprovementVariantRun,
  NotificationType,
  Task,
  Workspace,
} from "../../shared/types";
import {
  buildImprovementVariantPrompt,
  loadImprovementProgram,
} from "./ExperimentPromptBuilder";
import { getImprovementEligibility } from "./ImprovementEligibilityService";
import { ImprovementCandidateService } from "./ImprovementCandidateService";
import { ExperimentEvaluationService } from "./ExperimentEvaluationService";
import {
  ImprovementCampaignRepository,
  ImprovementCandidateRepository,
  ImprovementJudgeVerdictRepository,
  ImprovementRunRepository,
  ImprovementVariantRunRepository,
  clearImprovementHistoryData,
} from "./ImprovementRepositories";
import { saveImprovementResetBaselineAt } from "./ImprovementHistoryState";
import { ImprovementSettingsManager } from "./ImprovementSettingsManager";

type Any = any;
type ImprovementStageTransition = { stage: string; at: number; detail?: string };

interface ImprovementLoopServiceDeps {
  notify?: (params: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    workspaceId?: string;
  }) => Promise<void> | void;
}

const SCOUT_LANE: ImprovementVariantLane = "root_cause";
// Keep this list in sync with the bounded 1..3 variants-per-campaign setting.
// Multi-variant fan-out relies on worktree isolation so lanes never share a writable checkout.
const IMPLEMENTATION_LANES: ImprovementVariantLane[] = [
  "minimal_patch",
  "test_first",
  "guardrail_hardening",
];
const COWORK_WORKSPACE_SCORE_THRESHOLD = 18;

export class ImprovementLoopService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly taskRepo: TaskRepository;
  private readonly candidateRepo: ImprovementCandidateRepository;
  private readonly runRepo: ImprovementRunRepository;
  private readonly campaignRepo: ImprovementCampaignRepository;
  private readonly variantRepo: ImprovementVariantRunRepository;
  private readonly judgeVerdictRepo: ImprovementJudgeVerdictRepository;
  private readonly evaluationService: ExperimentEvaluationService;
  private agentDaemon: AgentDaemon | null = null;
  private intervalHandle?: ReturnType<typeof setInterval>;
  private worktreeCreatedListener?: (evt: Any) => void;
  private taskCompletedListener?: (evt: Any) => void;
  private taskStatusListener?: (evt: Any) => void;
  private started = false;

  constructor(
    private readonly db: Database.Database,
    private readonly candidateService: ImprovementCandidateService,
    private readonly deps: ImprovementLoopServiceDeps = {},
  ) {
    this.workspaceRepo = new WorkspaceRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.candidateRepo = new ImprovementCandidateRepository(db);
    this.runRepo = new ImprovementRunRepository(db);
    this.campaignRepo = new ImprovementCampaignRepository(db);
    this.variantRepo = new ImprovementVariantRunRepository(db);
    this.judgeVerdictRepo = new ImprovementJudgeVerdictRepository(db);
    this.evaluationService = new ExperimentEvaluationService(db);
  }

  async start(agentDaemon: AgentDaemon): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.agentDaemon = agentDaemon;

    this.worktreeCreatedListener = (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      const variant = this.variantRepo.findByTaskId(taskId);
      if (!variant) return;
      const branch =
        typeof evt?.payload?.branch === "string"
          ? evt.payload.branch
          : typeof evt?.branch === "string"
            ? evt.branch
            : "";
      if (branch) {
        this.variantRepo.update(variant.id, { branchName: branch });
      }
    };
    agentDaemon.on("worktree_created", this.worktreeCreatedListener);

    const finalize = (taskId: string) => {
      const variant = this.variantRepo.findByTaskId(taskId);
      if (!variant || (variant.status !== "queued" && variant.status !== "running")) return;
      void this.finalizeVariant(variant.id, taskId);
    };

    this.taskCompletedListener = (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (taskId) finalize(taskId);
    };
    agentDaemon.on("task_completed", this.taskCompletedListener);

    this.taskStatusListener = (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (taskId) finalize(taskId);
    };
    agentDaemon.on("task_status", this.taskStatusListener);

    await this.refreshCandidates();
    await this.reconcileActiveCampaigns();
    this.resetInterval();
    const settings = this.getSettings();
    if (settings.enabled && settings.autoRun) {
      await this.runNextExperiment();
    }
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    if (this.agentDaemon && this.worktreeCreatedListener) {
      this.agentDaemon.removeListener("worktree_created", this.worktreeCreatedListener);
    }
    if (this.agentDaemon && this.taskCompletedListener) {
      this.agentDaemon.removeListener("task_completed", this.taskCompletedListener);
    }
    if (this.agentDaemon && this.taskStatusListener) {
      this.agentDaemon.removeListener("task_status", this.taskStatusListener);
    }
    this.worktreeCreatedListener = undefined;
    this.taskCompletedListener = undefined;
    this.taskStatusListener = undefined;
    this.agentDaemon = null;
    this.started = false;
  }

  getSettings(): ImprovementLoopSettings {
    return this.applyEligibilityGuard(this.normalizeSettings(ImprovementSettingsManager.loadSettings()));
  }

  saveSettings(settings: ImprovementLoopSettings): ImprovementLoopSettings {
    ImprovementSettingsManager.saveSettings(this.applyEligibilityGuard(this.normalizeSettings(settings)));
    const next = ImprovementSettingsManager.loadSettings();
    this.resetInterval();
    return this.applyEligibilityGuard(this.normalizeSettings(next));
  }

  listCandidates(workspaceId?: string): ImprovementCandidate[] {
    return this.candidateRepo.list({ workspaceId });
  }

  listCampaigns(workspaceId?: string): ImprovementCampaign[] {
    return this.enrichCampaigns(this.campaignRepo.list({ workspaceId }));
  }

  async listCampaignsFresh(workspaceId?: string): Promise<ImprovementCampaign[]> {
    await this.reconcileActiveCampaigns();
    return this.listCampaigns(workspaceId);
  }

  async refreshCandidates(): Promise<{ candidateCount: number }> {
    return this.candidateService.refresh();
  }

  dismissCandidate(candidateId: string): ImprovementCandidate | undefined {
    return this.candidateService.dismissCandidate(candidateId);
  }

  async resetHistory(): Promise<ImprovementHistoryResetResult> {
    const cancelledTaskIds = await this.cancelImprovementTasksForReset();
    const deleted = clearImprovementHistoryData(this.db);
    const resetAt = Date.now();
    saveImprovementResetBaselineAt(resetAt);
    return {
      resetAt,
      deleted,
      cancelledTaskIds,
    };
  }

  async reviewCampaign(
    campaignId: string,
    reviewStatus: ImprovementReviewStatus,
  ): Promise<ImprovementCampaign | undefined> {
    if (reviewStatus === "accepted") {
      this.assertImprovementEligible();
    }

    const campaign = this.campaignRepo.findById(campaignId);
    if (!campaign) return undefined;

    if (reviewStatus === "dismissed") {
      this.campaignRepo.update(campaignId, {
        reviewStatus,
        status: "parked",
        stage: "completed",
        promotionStatus: "promotion_failed",
        promotionError: campaign.promotionError || "Campaign was dismissed before opening a PR.",
        stopReason: "dismissed_from_review",
        completedAt: campaign.completedAt || Date.now(),
      });
      this.candidateService.markCandidateParked(
        campaign.candidateId,
        campaign.promotionError || "Campaign was dismissed before opening a PR.",
      );
      void this.notify({
        type: "info",
        title: "Improvement campaign dismissed",
        message: campaign.verdictSummary || "A self-improvement campaign was dismissed from review.",
        workspaceId: campaign.workspaceId,
      });
      return this.getCampaign(campaignId);
    }

    if (campaign.status === "pr_opened") {
      return this.getCampaign(campaignId);
    }

    if (!["verifying", "ready_for_review", "promoted"].includes(campaign.status)) {
      this.campaignRepo.update(campaignId, {
        promotionStatus: "promotion_failed",
        promotionError: "Only promotable campaigns can open a PR.",
      });
      return this.getCampaign(campaignId);
    }

    const winner = campaign.winnerVariantId ? this.variantRepo.findById(campaign.winnerVariantId) : undefined;
    if (!winner?.taskId) {
      this.campaignRepo.update(campaignId, {
        promotionStatus: "promotion_failed",
        promotionError: "No promotable winner variant is linked to this campaign.",
      });
      return this.getCampaign(campaignId);
    }

    const task = this.taskRepo.findById(winner.taskId);
    if (!this.canPromoteVariant(winner, task)) {
      this.campaignRepo.update(campaignId, {
        reviewStatus: "dismissed",
        status: "failed",
        stage: "completed",
        promotionStatus: "promotion_failed",
        promotionError: "Winner did not satisfy PR promotion gates.",
        stopReason: "winner_not_promotable",
        completedAt: Date.now(),
      });
      this.candidateService.recordCampaignFailure(campaign.candidateId, {
        failureClass: "non_promotable_result",
        attemptFingerprint: this.buildAttemptFingerprint(
          this.candidateRepo.findById(campaign.candidateId),
          "review",
        ),
        reason: "Winner did not satisfy PR promotion gates.",
      });
      return this.getCampaign(campaignId);
    }

    return await this.promoteCampaign(campaignId, winner, reviewStatus);
  }

  async runNextExperiment(): Promise<ImprovementCampaign | null> {
    this.assertImprovementEligible();
    const settings = this.getSettings();
    if (!settings.enabled) return null;
    await this.reconcileActiveCampaigns();
    if (this.campaignRepo.countActive() >= settings.maxConcurrentCampaigns) {
      return null;
    }

    const candidate = await this.pickNextCandidate(settings.requireWorktree);
    if (!candidate) return null;
    return await this.startCampaignForCandidate(candidate, settings);
  }

  async retryCampaign(campaignId: string): Promise<ImprovementCampaign | null> {
    this.assertImprovementEligible();
    const settings = this.getSettings();
    if (!settings.enabled) {
      throw new Error("Retry could not start because the self-improvement loop is disabled.");
    }
    await this.reconcileActiveCampaigns();
    if (this.campaignRepo.countActive() >= settings.maxConcurrentCampaigns) {
      throw new Error("Retry could not start because the maximum number of active campaigns is already in progress.");
    }
    const prior = this.campaignRepo.findById(campaignId);
    if (!prior) throw new Error("Retry could not start because the previous campaign no longer exists.");
    if (prior.status !== "failed") throw new Error("Retry is only available for failed campaigns.");

    const candidate = this.candidateRepo.findById(prior.candidateId);
    if (!candidate) throw new Error("Retry could not start because the candidate no longer exists.");
    if (candidate.status !== "open") {
      throw new Error(`Retry could not start because the candidate is now ${candidate.status.replace(/_/g, " ")}.`);
    }
    return await this.startCampaignForCandidate(candidate, settings);
  }

  private async startCampaignForCandidate(
    candidate: ImprovementCandidate,
    settings: ImprovementLoopSettings,
  ): Promise<ImprovementCampaign | null> {
    const sourceWorkspace = this.workspaceRepo.findById(candidate.workspaceId);
    if (!sourceWorkspace) return null;
    const executionWorkspace = this.resolveExecutionWorkspace(candidate, sourceWorkspace);
    const baselineMetrics = this.evaluationService.snapshot(settings.evalWindowDays);
    const { trainingEvidence, holdoutEvidence, replayCases } = this.buildReplaySet(candidate, settings);

    const rootTask = this.taskRepo.create({
      title: `Improve campaign: ${candidate.title}`,
      prompt: `Failure-closed self-improvement campaign for candidate "${candidate.title}" that must end in a draft pull request candidate or fail quickly.`,
      rawPrompt: `Failure-closed self-improvement campaign for candidate "${candidate.title}" that must end in a draft pull request candidate or fail quickly.`,
      status: "queued",
      workspaceId: sourceWorkspace.id,
      source: "improvement",
      agentType: "main",
      depth: 0,
      budgetTokens: settings.campaignTokenBudget,
      budgetCost: settings.campaignCostBudget,
      agentConfig: {
        autonomousMode: true,
        allowUserInput: false,
        executionMode: "verified",
        taskDomain: "code",
        reviewPolicy: "strict",
        gatewayContext: "private",
        maxTokens: settings.campaignTokenBudget,
      },
      resultSummary: "Preparing staged self-improvement campaign.",
    });

    const campaign = this.campaignRepo.create({
      candidateId: candidate.id,
      workspaceId: candidate.workspaceId,
      executionWorkspaceId: executionWorkspace.id,
      rootTaskId: rootTask.id,
      status: "queued",
      stage: "queued",
      reviewStatus: "pending",
      promotionStatus: "idle",
      baselineMetrics,
      trainingEvidence,
      holdoutEvidence,
      replayCases,
      prRequired: true,
      providerHealthSnapshot: {},
      stageBudget: {
        preflight: { maxMinutes: 2, maxLlmCalls: 2 },
        reproduce: { maxMinutes: 10, maxLlmCalls: 10 },
        implement: { maxMinutes: 15, maxLlmCalls: 16 },
        verifyAndPr: { maxMinutes: 5, maxLlmCalls: 6 },
        wholeCampaign: {
          maxMinutes: settings.campaignTimeoutMinutes,
          tokenBudget: settings.campaignTokenBudget,
          costBudget: settings.campaignCostBudget,
        },
      },
      observability: {
        selectedAt: Date.now(),
        candidateSelectionReason: "Top runnable candidate selected for bounded self-improvement campaign.",
        candidateSelectionScore: candidate.priorityScore,
        variantCount: Math.max(1, settings.variantsPerCampaign),
        verificationCommands: [],
        stageTransitions: [
          {
            stage: "queued",
            at: Date.now(),
            detail: `Candidate ${candidate.id} selected for execution workspace ${executionWorkspace.id}.`,
          },
        ],
        promotionAttempts: 0,
      },
    });

    this.candidateService.markCandidateRunning(candidate.id);

    try {
      const preflight = await this.runPreflightChecks(candidate, sourceWorkspace, executionWorkspace, settings);
      if (!preflight.ok) {
        await this.failCampaign(campaign.id, candidate, {
          failureClass: preflight.failureClass,
          message: preflight.message,
        });
        return this.getCampaign(campaign.id) || null;
      }

      this.campaignRepo.update(campaign.id, {
        status: "reproducing",
        stage: "reproducing",
        startedAt: Date.now(),
        providerHealthSnapshot: preflight.providerHealthSnapshot,
        observability: this.appendStageTransition(campaign, "reproducing", "Preflight passed. Starting scout variant."),
      });
      this.taskRepo.update(rootTask.id, {
        status: "executing",
        resultSummary: "Running scout stage to reproduce and scope the failure.",
      });
      await this.startScoutVariant(campaign.id, candidate, sourceWorkspace, executionWorkspace, settings);

      void this.notify({
        type: "info",
        title: "Improvement campaign started",
        message: `Started staged self-improvement campaign for "${candidate.title}".`,
        workspaceId: candidate.workspaceId,
      });
    } catch (error) {
      await this.failCampaign(campaign.id, candidate, {
        failureClass: "preflight_failed",
        message: String((error as Error)?.message || error),
      });
      void this.notify({
        type: "task_failed",
        title: "Improvement campaign failed to start",
        message: String((error as Error)?.message || error),
        workspaceId: candidate.workspaceId,
      });
    }

    return this.getCampaign(campaign.id) || null;
  }

  private markRootTaskCompleted(taskId: string, summary: string): void {
    if (this.agentDaemon) {
      this.agentDaemon.completeTask(taskId, summary, {
        terminalStatus: "ok",
      });
      return;
    }
    this.taskRepo.update(taskId, {
      status: "completed",
      terminalStatus: "ok",
      completedAt: Date.now(),
      resultSummary: summary,
    });
  }

  private markRootTaskFailed(
    taskId: string,
    message: string,
    failureClass?: Task["failureClass"],
  ): void {
    if (this.agentDaemon) {
      this.agentDaemon.failTask(taskId, message, {
        terminalStatus: "failed",
        resultSummary: message,
        ...(failureClass ? { failureClass } : {}),
      });
      return;
    }
    this.taskRepo.update(taskId, {
      status: "failed",
      terminalStatus: "failed",
      completedAt: Date.now(),
      resultSummary: message,
      ...(failureClass ? { failureClass } : {}),
    });
  }

  private async finalizeVariant(variantId: string, taskId: string): Promise<void> {
    const variant = this.variantRepo.findById(variantId);
    if (!variant) return;
    const task = this.taskRepo.findById(taskId);
    if (!task || !["completed", "failed", "cancelled"].includes(task.status)) return;

    const settings = this.getSettings();
    const campaign = this.campaignRepo.findById(variant.campaignId);
    if (!campaign) return;

    const evaluation = this.evaluationService.evaluateVariant({
      variant,
      baselineMetrics: campaign.baselineMetrics || this.evaluationService.snapshot(settings.evalWindowDays),
      evalWindowDays: settings.evalWindowDays,
      replayCases: campaign.replayCases,
      maxPatchFiles: settings.maxPatchFiles,
    });

    this.variantRepo.update(variant.id, {
      status:
        task.status === "cancelled"
          ? "cancelled"
          : evaluation.targetedVerificationPassed
            ? "passed"
            : "failed",
      completedAt: Date.now(),
      outcomeMetrics: this.evaluationService.snapshot(settings.evalWindowDays),
      verdictSummary: evaluation.summary,
      evaluationNotes: evaluation.notes.join("\n"),
      branchName: variant.branchName || task.worktreeBranch,
      observability: {
        ...variant.observability,
        stage: campaign.stage,
        executionMode: variant.observability?.executionMode,
        artifactSummary: evaluation.artifactSummary,
        evaluation: {
          targetedVerificationPassed: evaluation.targetedVerificationPassed,
          verificationPassed: evaluation.verificationPassed,
          promotable: evaluation.promotable,
          reproductionEvidenceFound: evaluation.reproductionEvidenceFound,
          verificationEvidenceFound: evaluation.verificationEvidenceFound,
          prReadinessEvidenceFound: evaluation.prReadinessEvidenceFound,
          replayPassRate: evaluation.replayPassRate,
          diffSizePenalty: evaluation.diffSizePenalty,
          regressionSignals: evaluation.regressionSignals,
          safetySignals: evaluation.safetySignals,
        },
      },
    });
    const updatedVariant = this.variantRepo.findById(variant.id);
    const enriched = this.getCampaign(campaign.id);
    const candidate = this.candidateRepo.findById(campaign.candidateId);
    if (!updatedVariant || !enriched || !candidate) return;

    if (campaign.stage === "reproducing") {
      if (!evaluation.targetedVerificationPassed) {
        await this.failCampaign(campaign.id, candidate, {
          failureClass: this.classifyFailureFromTask(task),
          message: evaluation.summary,
        });
        return;
      }
      await this.startImplementationVariant(campaign.id, candidate, settings);
      return;
    }

    if (campaign.stage === "implementing") {
      const implementationVariants = this.variantRepo
        .listByCampaignId(campaign.id)
        .filter((item) => item.lane !== SCOUT_LANE);
      const pendingVariants = implementationVariants.filter(
        (item) => item.status === "queued" || item.status === "running",
      );
      if (pendingVariants.length > 0) {
        return;
      }

      const judged = this.evaluationService.evaluateCampaign({
        campaign: enriched,
        variants: implementationVariants,
        evalWindowDays: settings.evalWindowDays,
      });
      this.judgeVerdictRepo.upsert(judged.verdict);

      const allVerificationCommands = judged.evaluations.flatMap(
        (item) => item.artifactSummary.verificationCommands,
      );

      if (!judged.winner) {
        this.campaignRepo.update(campaign.id, {
          winnerVariantId: undefined,
          verdictSummary: judged.verdict.summary,
          evaluationNotes: judged.verdict.notes.join("\n"),
          outcomeMetrics: judged.outcomeMetrics,
          verificationCommands: [...new Set(allVerificationCommands)],
          observability: this.appendStageTransition(
            campaign,
            "implementing",
            "All implementation variants completed, but no winner cleared promotion gates.",
          ),
        });
        await this.failCampaign(campaign.id, candidate, {
          failureClass: "non_promotable_result",
          message: judged.verdict.summary,
        });
        return;
      }

      const winnerVariant = this.variantRepo.findById(judged.winner.variantId) || updatedVariant;
      this.campaignRepo.update(campaign.id, {
        status: settings.reviewRequired ? "ready_for_review" : "verifying",
        stage: "verifying",
        winnerVariantId: winnerVariant.id,
        verdictSummary: judged.verdict.summary,
        evaluationNotes: judged.verdict.notes.join("\n"),
        outcomeMetrics: judged.outcomeMetrics,
        verificationCommands: [...new Set(judged.winner.artifactSummary.verificationCommands)],
        observability: this.appendStageTransition(
          campaign,
          "verifying",
          `Selected ${winnerVariant.lane} as campaign winner after ${implementationVariants.length} implementation variant(s).`,
        ),
      });

      if (settings.reviewRequired) {
        this.candidateService.markCandidateReview(campaign.candidateId);
        return;
      }

      await this.promoteCampaign(campaign.id, winnerVariant, "accepted");
    }
  }

  private async promoteCampaign(
    campaignId: string,
    winner: ImprovementVariantRun,
    reviewStatus: ImprovementReviewStatus = "accepted",
  ): Promise<ImprovementCampaign | undefined> {
    const campaign = this.campaignRepo.findById(campaignId);
    if (!campaign) return undefined;
    const candidate = this.candidateRepo.findById(campaign.candidateId);
    const promotionMode = "github_pr";
    const eligibility = getImprovementEligibility();

    if (!eligibility.eligible) {
      await this.failPromotion(campaignId, candidate, eligibility.reason);
      return this.getCampaign(campaignId);
    }

    this.campaignRepo.update(campaignId, {
      reviewStatus,
      promotionStatus: "promoting",
      promotionError: undefined,
      status: "verifying",
      stage: "verifying",
      observability: {
        ...campaign.observability,
        promotionAttempts: (campaign.observability?.promotionAttempts || 0) + 1,
        lastPromotionError: undefined,
        stageTransitions: [
            ...this.getStageTransitions(campaign.observability),
          {
            stage: "verifying",
            at: Date.now(),
            detail: `Promoting winner ${winner.lane}.`,
          },
        ],
      },
    });
    if (campaign.rootTaskId) {
      this.taskRepo.update(campaign.rootTaskId, {
        resultSummary: `Promoting winner ${winner.lane}.`,
      });
    }

    if (!this.agentDaemon || !winner.taskId) {
      await this.failPromotion(campaignId, candidate, "Agent daemon unavailable");
      return this.getCampaign(campaignId);
    }

    if (promotionMode !== "github_pr") {
      await this.failPromotion(campaignId, candidate, "Self-improvement campaigns only support GitHub PR promotion.");
      return this.getCampaign(campaignId);
    }

    const pullRequest = await this.agentDaemon.getWorktreeManager().openPullRequest(winner.taskId, {
      title: this.buildPullRequestTitle(candidate, campaign),
      body: this.buildPullRequestBody(candidate, campaign, winner),
    });
    if (pullRequest.success) {
      this.campaignRepo.update(campaignId, {
        status: "pr_opened",
        stage: "completed",
        reviewStatus,
        promotionStatus: "pr_opened",
        pullRequest,
        promotionError: undefined,
        promotedAt: Date.now(),
        promotedTaskId: winner.taskId,
        promotedBranchName: winner.branchName,
        completedAt: Date.now(),
        observability: {
          ...campaign.observability,
          promotionAttempts: (campaign.observability?.promotionAttempts || 0) + 1,
          lastPromotionError: undefined,
          stageTransitions: [
            ...this.getStageTransitions(campaign.observability),
            {
              stage: "completed",
              at: Date.now(),
              detail: `Draft PR opened successfully for ${winner.lane}.`,
            },
          ],
        },
      });
      this.candidateService.markCandidateResolved(campaign.candidateId);
      if (campaign.rootTaskId) {
        this.markRootTaskCompleted(campaign.rootTaskId, `Draft PR opened from ${winner.lane}.`);
      }
      void this.notify({
        type: "task_completed",
        title: "Improvement PR created",
        message: `Opened a PR for "${candidate?.title || campaign.verdictSummary || "self-improvement campaign"}".`,
        taskId: winner.taskId,
        workspaceId: campaign.workspaceId,
      });
      return this.getCampaign(campaignId);
    }

    await this.failPromotion(campaignId, candidate, pullRequest.error || "Failed to open pull request", pullRequest);
    return this.getCampaign(campaignId);
  }

  private async reconcileActiveCampaigns(): Promise<void> {
    const activeCampaigns = this.campaignRepo.list({
      status: ["queued", "preflight", "reproducing", "implementing", "verifying", "planning", "running_variants", "judging"],
    });
    for (const campaign of activeCampaigns) {
      const variants = this.variantRepo.listByCampaignId(campaign.id);
      if (variants.length === 0) {
        const candidate = this.candidateRepo.findById(campaign.candidateId);
        if (candidate) {
          await this.failCampaign(campaign.id, candidate, {
            failureClass: "missing_resumable_state",
            message: "Campaign had no linked variants and was marked failed during reconciliation.",
          });
        }
        continue;
      }
      for (const variant of variants) {
        if (!variant.taskId) {
          this.variantRepo.update(variant.id, {
            status: "failed",
            completedAt: Date.now(),
            verdictSummary: "Variant had no linked task and was marked failed during reconciliation.",
          });
          continue;
        }
        const task = this.taskRepo.findById(variant.taskId);
        if (!task) {
          this.variantRepo.update(variant.id, {
            status: "failed",
            completedAt: Date.now(),
            verdictSummary: "Variant task record was missing during reconciliation.",
          });
          const candidate = this.candidateRepo.findById(campaign.candidateId);
          if (candidate) {
            await this.failCampaign(campaign.id, candidate, {
              failureClass: "missing_resumable_state",
              message: "Variant task record was missing during reconciliation.",
            });
          }
          continue;
        }
        if (["completed", "failed", "cancelled"].includes(task.status) && (variant.status === "queued" || variant.status === "running")) {
          await this.finalizeVariant(variant.id, variant.taskId);
        }
      }
    }
  }

  private async pickNextCandidate(requireWorktree: boolean): Promise<ImprovementCandidate | undefined> {
    const workspaces = this.workspaceRepo.findAll();
    const ranked: Array<{ candidate: ImprovementCandidate; promotable: boolean; score: number }> = [];
    const worktreeManager = this.agentDaemon?.getWorktreeManager();
    for (const workspace of workspaces) {
      const candidate = this.candidateService.getTopCandidateForWorkspace(workspace.id);
      if (!candidate) continue;
      const executionWorkspace = this.resolveExecutionWorkspace(candidate, workspace);
      const score = this.scoreExecutionWorkspace(executionWorkspace, candidate);
      const promotable =
        !!executionWorkspace &&
        (!requireWorktree ||
          (!!worktreeManager &&
            (await worktreeManager.shouldUseWorktree(
              executionWorkspace.path,
              executionWorkspace.isTemp,
              requireWorktree,
            ))));
      if (!promotable) {
        this.candidateService.recordCandidateSkip(
          candidate.id,
          requireWorktree
            ? `Skipped because execution workspace ${executionWorkspace.name} cannot provide required git worktree isolation.`
            : `Skipped because execution workspace ${executionWorkspace.name} is not promotable.`,
        );
        continue;
      }
      ranked.push({ candidate, promotable, score });
    }
    ranked.sort(
      (a, b) =>
        Number(b.promotable) - Number(a.promotable) ||
        b.score - a.score ||
        b.candidate.priorityScore - a.candidate.priorityScore ||
        b.candidate.lastSeenAt - a.candidate.lastSeenAt,
    );
    return ranked[0]?.candidate;
  }

  private resolveExecutionWorkspace(candidate: ImprovementCandidate, sourceWorkspace: Workspace): Workspace {
    const canonicalCoworkWorkspace = this.findCanonicalCoworkWorkspace();
    if (canonicalCoworkWorkspace) return canonicalCoworkWorkspace;
    if (this.isLikelyCoworkCodeWorkspace(sourceWorkspace)) return sourceWorkspace;
    const alternatives = this.workspaceRepo
      .findAll()
      .filter((workspace) => workspace.id !== sourceWorkspace.id)
      .map((workspace) => ({ workspace, score: this.scoreExecutionWorkspace(workspace, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    const bestAlternative = alternatives[0];

    if (sourceWorkspace.isTemp && bestAlternative && bestAlternative.score >= COWORK_WORKSPACE_SCORE_THRESHOLD) {
      return bestAlternative.workspace;
    }

    if (!this.candidateExplicitlyTargetsCowork(candidate)) return sourceWorkspace;

    return bestAlternative?.workspace || sourceWorkspace;
  }

  private findCanonicalCoworkWorkspace(): Workspace | undefined {
    const workspaces = this.workspaceRepo.findAll();
    const preferredPath = this.getPreferredCoworkRepoPath();

    if (preferredPath) {
      const exactMatch = workspaces.find(
        (workspace) => this.pathsMatch(workspace.path, preferredPath),
      );
      if (exactMatch) return exactMatch;
    }

    return workspaces
      .map((workspace) => ({ workspace, score: this.scoreExecutionWorkspace(workspace, this.buildWorkspaceScoringCandidate(workspace)) }))
      .filter((entry) => entry.score >= COWORK_WORKSPACE_SCORE_THRESHOLD)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(Boolean(b.workspace.lastUsedAt)) - Number(Boolean(a.workspace.lastUsedAt)) ||
          (b.workspace.lastUsedAt || 0) - (a.workspace.lastUsedAt || 0),
      )[0]?.workspace;
  }

  private getPreferredCoworkRepoPath(): string | undefined {
    const explicit = process.env.COWORK_SELF_IMPROVEMENT_REPO;
    if (typeof explicit === "string" && explicit.trim().length > 0) {
      return path.resolve(explicit.trim());
    }
    const cwd = typeof process.cwd === "function" ? process.cwd() : "";
    return cwd ? path.resolve(cwd) : undefined;
  }

  private pathsMatch(left: string, right: string): boolean {
    return path.resolve(left) === path.resolve(right);
  }

  private buildWorkspaceScoringCandidate(workspace: Workspace): ImprovementCandidate {
    return {
      id: `workspace-score:${workspace.id}`,
      workspaceId: workspace.id,
      fingerprint: "",
      source: "task_failure",
      status: "open",
      title: "CoWork OS self-improvement",
      summary: "CoWork OS source workspace for PR-based self-improvement.",
      severity: 0,
      recurrenceCount: 0,
      fixabilityScore: 0,
      priorityScore: 0,
      evidence: [],
      firstSeenAt: 0,
      lastSeenAt: 0,
    };
  }

  private scoreExecutionWorkspace(workspace: Workspace, candidate: ImprovementCandidate): number {
    let score = 0;
    if (workspace.isTemp) score -= 5;

    const workspaceName = workspace.name.toLowerCase();
    const workspacePath = workspace.path.toLowerCase();
    const candidateText = `${candidate.title} ${candidate.summary}`.toLowerCase();
    const packageJson = this.readPackageMetadata(workspace.path);
    const packageName = packageJson?.name?.toLowerCase?.() || "";

    if (workspaceName.includes("cowork")) score += 6;
    if (workspacePath.includes("/cowork")) score += 6;
    if (packageName.includes("cowork")) score += 10;
    if (fs.existsSync(path.join(workspace.path, "src", "electron"))) score += 4;
    if (fs.existsSync(path.join(workspace.path, "src", "renderer"))) score += 4;
    if (fs.existsSync(path.join(workspace.path, "logs", "dev-latest.log"))) score += 2;
    if (fs.existsSync(path.join(workspace.path, ".git"))) score += 1;
    if (candidateText.includes("cowork") && (workspaceName.includes("cowork") || packageName.includes("cowork"))) {
      score += 4;
    }

    return score;
  }

  private candidateExplicitlyTargetsCowork(candidate: ImprovementCandidate): boolean {
    const parts = [
      candidate.title,
      candidate.summary,
      ...candidate.evidence.flatMap((evidence) => [evidence.summary, evidence.details]),
    ];
    const text = parts
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ")
      .toLowerCase();
    if (!text) return false;
    return /\bcowork\b|\bcowork os\b|src\/electron|src\/renderer|dev-latest\.log|electron app|renderer\b/.test(text);
  }

  private isLikelyCoworkCodeWorkspace(workspace: Workspace): boolean {
    const score = this.scoreExecutionWorkspace(workspace, this.buildWorkspaceScoringCandidate(workspace));
    return score >= COWORK_WORKSPACE_SCORE_THRESHOLD;
  }

  private buildReplaySet(candidate: ImprovementCandidate, settings: ImprovementLoopSettings) {
    const evidence = [...candidate.evidence].sort((a, b) => a.createdAt - b.createdAt);
    const replayCount = Math.min(settings.replaySetSize, Math.max(1, evidence.length - 1));
    const holdoutEvidence = replayCount > 0 ? evidence.slice(-replayCount) : [];
    const trainingEvidence = evidence.slice(0, Math.max(1, evidence.length - holdoutEvidence.length));
    const replayCases = holdoutEvidence.map((item, index) => ({
      id: `${candidate.id}-replay-${index + 1}`,
      candidateId: candidate.id,
      source: item.type,
      summary: item.summary,
      details: item.details,
      createdAt: item.createdAt,
      taskId: item.taskId,
      eventType: item.eventType,
      metadata: item.metadata,
    }));
    return { trainingEvidence, holdoutEvidence, replayCases };
  }

  private async runPreflightChecks(
    candidate: ImprovementCandidate,
    sourceWorkspace: Workspace,
    executionWorkspace: Workspace,
    settings: ImprovementLoopSettings,
  ): Promise<
    | { ok: true; providerHealthSnapshot: Record<string, unknown> }
    | { ok: false; failureClass: ImprovementFailureClass; message: string }
  > {
    if (!this.agentDaemon) {
      return { ok: false, failureClass: "preflight_failed", message: "Agent daemon unavailable." };
    }
    const eligibility = getImprovementEligibility();
    if (!eligibility.eligible) {
      return { ok: false, failureClass: "preflight_failed", message: eligibility.reason };
    }
    if (executionWorkspace.isTemp) {
      return {
        ok: false,
        failureClass: "preflight_failed",
        message: "Temporary execution workspace is not eligible for PR-based self-improvement.",
      };
    }
    if (candidate.status === "parked") {
      return { ok: false, failureClass: "preflight_failed", message: "Candidate is parked." };
    }
    if (candidate.cooldownUntil && candidate.cooldownUntil > Date.now()) {
      return {
        ok: false,
        failureClass: "preflight_failed",
        message: `Candidate is cooling down until ${new Date(candidate.cooldownUntil).toISOString()}.`,
      };
    }
    const worktreeRequired = await this.shouldRequireWorktreeForWorkspace(
      executionWorkspace.path,
      executionWorkspace.isTemp,
      settings.requireWorktree,
    );
    if (!fs.existsSync(path.join(executionWorkspace.path, ".git"))) {
      return {
        ok: false,
        failureClass: "preflight_failed",
        message: "No git repository found for PR-based self-improvement.",
      };
    }
    return {
      ok: true,
      providerHealthSnapshot: {
        sourceWorkspaceId: sourceWorkspace.id,
        executionWorkspaceId: executionWorkspace.id,
        requireWorktree: worktreeRequired,
        automationEligible: true,
        ownerEnrollment: eligibility.enrolled,
        canonicalRepo: eligibility.checks.canonicalRepo,
        repoPath: eligibility.repoPath,
      },
    };
  }

  private async startScoutVariant(
    campaignId: string,
    candidate: ImprovementCandidate,
    sourceWorkspace: Workspace,
    executionWorkspace: Workspace,
    settings: ImprovementLoopSettings,
  ): Promise<void> {
    await this.startVariantTask({
      campaignId,
      candidate,
      lane: SCOUT_LANE,
      stage: "reproducing",
      sourceWorkspace,
      executionWorkspace,
      settings,
      executionMode: "analyze",
      verificationAgent: false,
      maxTurns: 8,
      maxTokens: 12000,
    });
  }

  private async startImplementationVariant(
    campaignId: string,
    candidate: ImprovementCandidate,
    settings: ImprovementLoopSettings,
  ): Promise<void> {
    const campaign = this.campaignRepo.findById(campaignId);
    if (!campaign) return;
    const sourceWorkspace = this.workspaceRepo.findById(candidate.workspaceId);
    const executionWorkspace = campaign.executionWorkspaceId
      ? this.workspaceRepo.findById(campaign.executionWorkspaceId)
      : sourceWorkspace;
    if (!sourceWorkspace || !executionWorkspace) {
      await this.failCampaign(campaignId, candidate, {
        failureClass: "missing_resumable_state",
        message: "Campaign workspace context was missing before implementation.",
      });
      return;
    }
    this.campaignRepo.update(campaignId, {
      status: "implementing",
      stage: "implementing",
      verdictSummary: "Scout stage passed. Starting implementation stage.",
      observability: this.appendStageTransition(
        campaign,
        "implementing",
        `Scout stage passed. Starting ${Math.max(1, settings.variantsPerCampaign)} implementation variant(s).`,
      ),
    });
    const lanes = IMPLEMENTATION_LANES.slice(0, Math.max(1, settings.variantsPerCampaign));
    for (const lane of lanes) {
      await this.startVariantTask({
        campaignId,
        candidate,
        lane,
        stage: "implementing",
        sourceWorkspace,
        executionWorkspace,
        settings,
        executionMode: "verified",
        verificationAgent: true,
        maxTurns: 12,
        maxTokens: 24000,
      });
    }
  }

  private async startVariantTask(params: {
    campaignId: string;
    candidate: ImprovementCandidate;
    lane: ImprovementVariantLane;
    stage: "reproducing" | "implementing";
    sourceWorkspace: Workspace;
    executionWorkspace: Workspace;
    settings: ImprovementLoopSettings;
    executionMode: "analyze" | "verified";
    verificationAgent: boolean;
    maxTurns: number;
    maxTokens: number;
  }): Promise<void> {
    if (!this.agentDaemon) throw new Error("Agent daemon unavailable");
    const campaign = this.campaignRepo.findById(params.campaignId);
    if (!campaign?.rootTaskId) throw new Error("Campaign root task missing");
    const shouldRequireWorktree = await this.shouldRequireWorktreeForWorkspace(
      params.executionWorkspace.path,
      params.executionWorkspace.isTemp,
      params.settings.requireWorktree,
    );
    const program = loadImprovementProgram(params.executionWorkspace, params.settings.improvementProgramPath);
    const variant = this.variantRepo.create({
      campaignId: params.campaignId,
      candidateId: params.candidate.id,
      workspaceId: params.candidate.workspaceId,
      executionWorkspaceId: params.executionWorkspace.id,
      lane: params.lane,
      status: "queued",
      baselineMetrics: campaign.baselineMetrics,
      observability: {
        stage: params.stage,
        executionMode: params.executionMode,
      },
    });
    const stageInstruction =
      params.stage === "reproducing"
        ? "Do not make repository changes. Reproduce or tightly validate the failure, collect evidence, and produce a concrete fix plan."
        : "Implement the smallest viable fix, verify it, and explicitly state PR readiness.";
    const task = await this.agentDaemon.createChildTask({
      title: `Improve (${params.lane}): ${params.candidate.title}`,
      prompt: `${buildImprovementVariantPrompt(params.candidate, params.lane, {
        sourceWorkspace: params.sourceWorkspace,
        executionWorkspace: params.executionWorkspace,
        relevantLogPaths: this.collectRelevantLogPaths(params.sourceWorkspace, params.executionWorkspace),
        trainingEvidence: campaign.trainingEvidence,
        holdoutEvidence: campaign.holdoutEvidence,
        replayCases: campaign.replayCases,
        program,
      })}\n\nSTAGE REQUIREMENTS:\n- ${stageInstruction}\n- Final response must include: reproduction method, changed files summary, verification commands and result, PR readiness decision.`,
      workspaceId: params.executionWorkspace.id,
      parentTaskId: campaign.rootTaskId,
      agentType: "sub",
      depth: 1,
      agentConfig: {
        autonomousMode: true,
        allowUserInput: false,
        requireWorktree: params.stage === "implementing" ? shouldRequireWorktree : false,
        autoApproveTypes: ["run_command"],
        pauseForRequiredDecision: false,
        executionMode: params.executionMode,
        taskDomain: "code",
        reviewPolicy: "strict",
        verificationAgent: params.verificationAgent,
        deepWorkMode: false,
        autoContinueOnTurnLimit: false,
        progressJournalEnabled: false,
        gatewayContext: "private",
        maxTurns: params.maxTurns,
        maxTokens: params.maxTokens,
        bypassQueue: false,
      },
    });
    this.variantRepo.update(variant.id, {
      taskId: task.id,
      status: "running",
      startedAt: Date.now(),
      observability: {
        ...variant.observability,
        stage: params.stage,
        executionMode: params.executionMode,
      },
    });
  }

  private async failCampaign(
    campaignId: string,
    candidate: ImprovementCandidate,
    params: { failureClass: ImprovementFailureClass; message: string },
  ): Promise<void> {
    const campaign = this.campaignRepo.findById(campaignId);
    if (!campaign) return;
    this.campaignRepo.update(campaignId, {
      status: params.failureClass.startsWith("provider_") ? "parked" : "failed",
      stage: "completed",
      reviewStatus: "dismissed",
      promotionStatus: "promotion_failed",
      promotionError: params.message,
      stopReason: params.failureClass,
      verdictSummary: params.message,
      completedAt: Date.now(),
      observability: this.appendStageTransition(
        campaign,
        "completed",
        `Campaign failed: ${params.message}`,
      ),
    });
    if (campaign.rootTaskId) {
      this.markRootTaskFailed(campaign.rootTaskId, params.message);
    }
    this.candidateService.recordCampaignFailure(candidate.id, {
      failureClass: params.failureClass,
      attemptFingerprint: this.buildAttemptFingerprint(candidate, campaign.stage || campaign.status),
      reason: params.message,
    });
    void this.notify({
      type: "task_failed",
      title: params.failureClass.startsWith("provider_")
        ? "Improvement campaign parked"
        : "Improvement campaign failed",
      message: params.message,
      workspaceId: campaign.workspaceId,
    });
  }

  private async failPromotion(
    campaignId: string,
    candidate: ImprovementCandidate | undefined,
    message: string,
    pullRequest?: { success?: boolean; error?: string; url?: string; number?: number },
  ): Promise<void> {
    const campaign = this.campaignRepo.findById(campaignId);
    if (!campaign) return;
    this.campaignRepo.update(campaignId, {
      status: "parked",
      stage: "completed",
      reviewStatus: "dismissed",
      promotionStatus: "promotion_failed",
      promotionError: message,
      pullRequest: pullRequest as Any,
      stopReason: "promotion_failed",
      completedAt: Date.now(),
      observability: {
        ...campaign.observability,
        lastPromotionError: message,
        promotionAttempts: (campaign.observability?.promotionAttempts || 0) + 1,
        stageTransitions: [
          ...this.getStageTransitions(campaign.observability),
          {
            stage: "completed",
            at: Date.now(),
            detail: `Promotion failed: ${message}`,
          },
        ],
      },
    });
    if (campaign.rootTaskId) {
      this.markRootTaskFailed(campaign.rootTaskId, message);
    }
    if (candidate) {
      this.candidateService.recordCampaignFailure(candidate.id, {
        failureClass: this.classifyFailureFromText(message),
        attemptFingerprint: this.buildAttemptFingerprint(candidate, "promotion"),
        reason: message,
      });
    }
  }

  private readPackageMetadata(workspacePath: string): { name?: string } | null {
    const packageJsonPath = path.join(workspacePath, "package.json");
    if (!fs.existsSync(packageJsonPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
    } catch {
      return null;
    }
  }

  private collectRelevantLogPaths(sourceWorkspace: Workspace, executionWorkspace: Workspace): string[] {
    const logPaths = new Set<string>();
    for (const workspace of [executionWorkspace, sourceWorkspace]) {
      const logPath = path.join(workspace.path, "logs", "dev-latest.log");
      if (fs.existsSync(logPath)) logPaths.add(logPath);
    }
    return [...logPaths];
  }

  private enrichCampaigns(campaigns: ImprovementCampaign[]): ImprovementCampaign[] {
    return campaigns.map((campaign) => this.enrichCampaign(campaign));
  }

  private enrichCampaign(campaign: ImprovementCampaign): ImprovementCampaign {
    return {
      ...campaign,
      variants: this.variantRepo.listByCampaignId(campaign.id).map((variant) => {
        if (!variant.taskId) return variant;
        const task = this.taskRepo.findById(variant.taskId);
        return {
          ...variant,
          executionWorkspaceId: task?.workspaceId || variant.executionWorkspaceId,
        };
      }),
      judgeVerdict: this.judgeVerdictRepo.findByCampaignId(campaign.id),
    };
  }

  private getCampaign(campaignId: string): ImprovementCampaign | undefined {
    const campaign = this.campaignRepo.findById(campaignId);
    return campaign ? this.enrichCampaign(campaign) : undefined;
  }

  private async shouldRequireWorktreeForWorkspace(
    workspacePath: string,
    isTemp: boolean | undefined,
    requireWorktree: boolean,
  ): Promise<boolean> {
    if (!requireWorktree) return false;
    const worktreeManager = this.agentDaemon?.getWorktreeManager();
    if (!worktreeManager) return false;
    return await worktreeManager.shouldUseWorktree(workspacePath, isTemp, true);
  }

  private canPromoteVariant(variant: ImprovementVariantRun, task: Task | undefined): boolean {
    if (!task) return false;
    if (task.status !== "completed" || task.terminalStatus !== "ok") return false;
    if (!variant.taskId || !variant.branchName || !task.worktreePath) return false;
    const summary = `${task.resultSummary || ""}\n${variant.evaluationNotes || ""}`;
    return /reproduction method/i.test(summary) && /verification/i.test(summary) && /pr readiness/i.test(summary);
  }

  private buildAttemptFingerprint(candidate: ImprovementCandidate | undefined, stage: string): string {
    if (!candidate) return `missing:${stage}`;
    return `${candidate.id}:${candidate.fingerprint}:${stage}`;
  }

  private classifyFailureFromTask(task: Task | undefined): ImprovementFailureClass {
    if (!task) return "missing_resumable_state";
    if (/mutation-required|contract unmet/i.test(`${task.failureClass || ""} ${String(task.resultSummary || "")}`)) {
      return "mutation_contract_unmet";
    }
    return this.classifyFailureFromText(`${task.failureClass || ""} ${task.error || ""} ${task.resultSummary || ""}`);
  }

  private classifyFailureFromText(text: string): ImprovementFailureClass {
    const normalized = text.toLowerCase();
    if (/429|rate limit|too many requests|free-models-per-min/.test(normalized)) return "provider_rate_limited";
    if (/tool.+mismatch|tool protocol|tool call.+400|malformed json|failed to parse tool arguments/.test(normalized)) {
      return "provider_tool_protocol_error";
    }
    if (/model.+not found|does not exist|unknown model/.test(normalized)) return "provider_model_missing";
    if (/fetch failed|network|econn|socket hang up/.test(normalized)) return "provider_network_failure";
    if (/api key|auth|insufficient balance|quota|billing/.test(normalized)) return "provider_config_error";
    if (/artifact.*missing|missing artifact evidence/.test(normalized)) return "artifact_contract_unmet";
    if (/verification failed|review quality failure/.test(normalized)) return "verification_failed";
    if (/timed out|timeout/.test(normalized)) return "task_timeout";
    return "unknown";
  }

  private resetInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    const settings = this.getSettings();
    if (!settings.enabled || !settings.autoRun) return;
    this.intervalHandle = setInterval(() => {
      void this.refreshCandidates().then(() => this.runNextExperiment());
    }, settings.intervalMinutes * 60 * 1000);
  }

  private buildPullRequestTitle(candidate: ImprovementCandidate | undefined, campaign: ImprovementCampaign): string {
    if (candidate?.title?.trim()) return `Self-improvement: ${candidate.title.trim()}`;
    return `Self-improvement campaign ${campaign.id.slice(0, 8)}`;
  }

  private applyEligibilityGuard(settings: ImprovementLoopSettings): ImprovementLoopSettings {
    const eligibility = getImprovementEligibility();
    if (eligibility.eligible) {
      return settings;
    }
    return {
      ...settings,
      enabled: false,
      autoRun: false,
    };
  }

  private normalizeSettings(settings: ImprovementLoopSettings): ImprovementLoopSettings {
    const variantsPerCampaign = Math.max(
      1,
      Math.min(IMPLEMENTATION_LANES.length, Math.floor(settings.variantsPerCampaign || 1)),
    );

    return {
      ...settings,
      variantsPerCampaign,
      requireWorktree: variantsPerCampaign > 1 ? true : settings.requireWorktree,
    };
  }

  private assertImprovementEligible(): void {
    const eligibility = getImprovementEligibility();
    if (!eligibility.eligible) {
      throw new Error(eligibility.reason);
    }
  }

  private buildPullRequestBody(
    candidate: ImprovementCandidate | undefined,
    campaign: ImprovementCampaign,
    winner: ImprovementVariantRun,
  ): string {
    const lines = [
      "## Summary",
      `- ${candidate?.summary?.trim() || campaign.verdictSummary || "Autonomous improvement campaign."}`,
      campaign.verdictSummary ? `- Judge verdict: ${campaign.verdictSummary}` : "",
      `- Winning lane: ${winner.lane}`,
      candidate?.recurrenceCount ? `- Recurrence count: ${candidate.recurrenceCount}` : "",
      "",
      "## Context",
      `- Campaign: ${campaign.id}`,
      `- Variant: ${winner.id}`,
      winner.taskId ? `- Task: ${winner.taskId}` : "",
    ];
    return lines.filter(Boolean).join("\n");
  }

  private appendStageTransition(
    campaign: ImprovementCampaign,
    stage: string,
    detail?: string,
  ): ImprovementCampaign["observability"] {
    const prior = campaign.observability || {};
    const transitions = [
      ...this.getStageTransitions(prior),
      {
        stage,
        at: Date.now(),
        detail,
      },
    ];
    return {
      ...prior,
      stageTransitions: transitions,
    };
  }

  private getStageTransitions(
    observability: ImprovementCampaign["observability"] | undefined,
  ): ImprovementStageTransition[] {
    return [...((observability?.stageTransitions || []) as ImprovementStageTransition[])];
  }

  private async notify(params: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    workspaceId?: string;
  }): Promise<void> {
    try {
      await this.deps.notify?.(params);
    } catch (error) {
      console.error("[ImprovementLoopService] Failed to emit notification:", error);
    }
  }

  private async cancelImprovementTasksForReset(): Promise<string[]> {
    const taskIds = new Set<string>();

    for (const run of this.runRepo.list()) {
      if (run.taskId) taskIds.add(run.taskId);
    }

    for (const campaign of this.campaignRepo.list()) {
      if (campaign.rootTaskId) taskIds.add(campaign.rootTaskId);
      if (campaign.promotedTaskId) taskIds.add(campaign.promotedTaskId);
      for (const variant of this.variantRepo.listByCampaignId(campaign.id)) {
        if (variant.taskId) taskIds.add(variant.taskId);
      }
    }

    const cancelledTaskIds: string[] = [];
    if (!this.agentDaemon) {
      return cancelledTaskIds;
    }

    for (const taskId of taskIds) {
      try {
        await this.agentDaemon.cancelTask(taskId);
        cancelledTaskIds.push(taskId);
      } catch (error) {
        console.warn(`[ImprovementLoopService] Failed to cancel improvement task ${taskId} during reset:`, error);
      }
    }

    return cancelledTaskIds;
  }
}
