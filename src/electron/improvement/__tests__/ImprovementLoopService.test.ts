import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type {
  ImprovementCampaign,
  ImprovementCandidate,
  ImprovementJudgeVerdict,
  ImprovementRun,
  ImprovementVariantRun,
  Task,
  Workspace,
} from "../../../shared/types";
import { ImprovementLoopService } from "../ImprovementLoopService";

type Any = any;

const mockImprovementEligibility = vi.hoisted(() => vi.fn());

const workspaces = new Map<string, Workspace>();
const tasks = new Map<string, Task>();
const candidates = new Map<string, ImprovementCandidate>();
const campaigns = new Map<string, ImprovementCampaign>();
const variants = new Map<string, ImprovementVariantRun>();
const verdicts = new Map<string, ImprovementJudgeVerdict>();
const runs = new Map<string, ImprovementRun>();

const defaultMockSettings = {
  enabled: true,
  autoRun: false,
  includeDevLogs: false,
  intervalMinutes: 1440,
  variantsPerCampaign: 1,
  maxConcurrentCampaigns: 1,
  maxConcurrentImprovementExecutors: 1,
  maxQueuedImprovementCampaigns: 1,
  maxOpenCandidatesPerWorkspace: 25,
  requireWorktree: true,
  requireRepoChecks: true,
  enforcePatchScope: true,
  maxPatchFiles: 8,
  reviewRequired: false,
  judgeRequired: false,
  promotionMode: "github_pr" as const,
  evalWindowDays: 14,
  replaySetSize: 2,
  campaignTimeoutMinutes: 30,
  campaignTokenBudget: 60000,
  campaignCostBudget: 15,
};

let mockSettings = { ...defaultMockSettings };

vi.mock("../ImprovementSettingsManager", () => ({
  ImprovementSettingsManager: {
    loadSettings: () => mockSettings,
    saveSettings: (next: typeof mockSettings) => {
      mockSettings = { ...next };
    },
  },
}));

vi.mock("../ImprovementEligibilityService", () => ({
  getImprovementEligibility: mockImprovementEligibility,
}));

vi.mock("../../database/repositories", () => ({
  WorkspaceRepository: class {
    findAll() {
      return [...workspaces.values()];
    }
    findById(id: string) {
      return workspaces.get(id);
    }
  },
  TaskRepository: class {
    create(input: Any) {
      const task: Task = {
        id: `task-root-${tasks.size + 1}`,
        title: input.title,
        prompt: input.prompt,
        rawPrompt: input.rawPrompt,
        status: input.status,
        workspaceId: input.workspaceId,
        agentConfig: input.agentConfig,
        source: input.source,
        parentTaskId: input.parentTaskId,
        agentType: input.agentType,
        depth: input.depth,
        resultSummary: input.resultSummary,
        budgetTokens: input.budgetTokens,
        budgetCost: input.budgetCost,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    }
    update(id: string, updates: Partial<Task>) {
      const current = tasks.get(id);
      if (!current) return;
      tasks.set(id, { ...current, ...updates, updatedAt: Date.now() });
    }
    findById(id: string) {
      return tasks.get(id);
    }
  },
}));

vi.mock("../ImprovementRepositories", () => ({
  ImprovementCandidateRepository: class {
    list(params?: { workspaceId?: string }) {
      let rows = [...candidates.values()];
      if (params?.workspaceId)
        rows = rows.filter((item) => item.workspaceId === params.workspaceId);
      return rows;
    }
    findById(id: string) {
      return candidates.get(id);
    }
    findByFingerprint() {
      return undefined;
    }
  },
  ImprovementCampaignRepository: class {
    create(input: Any) {
      const campaign: ImprovementCampaign = {
        ...input,
        id: `campaign-${campaigns.size + 1}`,
        createdAt: input.createdAt ?? Date.now(),
        variants: [],
      };
      campaigns.set(campaign.id, campaign);
      return campaign;
    }
    update(id: string, updates: Partial<ImprovementCampaign>) {
      const current = campaigns.get(id);
      if (!current) return;
      campaigns.set(id, { ...current, ...updates });
    }
    findById(id: string) {
      return campaigns.get(id);
    }
    list(params?: { workspaceId?: string; status?: string[] | string }) {
      let rows = [...campaigns.values()];
      if (params?.workspaceId)
        rows = rows.filter((item) => item.workspaceId === params.workspaceId);
      if (params?.status) {
        const statuses = Array.isArray(params.status) ? params.status : [params.status];
        rows = rows.filter((item) => statuses.includes(item.status));
      }
      return rows;
    }
    countActive() {
      return [...campaigns.values()].filter((item) =>
        ["queued", "preflight", "reproducing", "implementing", "verifying"].includes(item.status),
      ).length;
    }
  },
  ImprovementRunRepository: class {
    list() {
      return [...runs.values()];
    }
  },
  ImprovementVariantRunRepository: class {
    create(input: Any) {
      const variant: ImprovementVariantRun = {
        ...input,
        id: `variant-${variants.size + 1}`,
        createdAt: input.createdAt ?? Date.now(),
      };
      variants.set(variant.id, variant);
      return variant;
    }
    update(id: string, updates: Partial<ImprovementVariantRun>) {
      const current = variants.get(id);
      if (!current) return;
      variants.set(id, { ...current, ...updates });
    }
    findById(id: string) {
      return variants.get(id);
    }
    findByTaskId(taskId: string) {
      return [...variants.values()].find((item) => item.taskId === taskId);
    }
    listByCampaignId(campaignId: string) {
      return [...variants.values()].filter((item) => item.campaignId === campaignId);
    }
    list(params?: { campaignId?: string; status?: string[] | string }) {
      let rows = [...variants.values()];
      if (params?.campaignId) rows = rows.filter((item) => item.campaignId === params.campaignId);
      if (params?.status) {
        const statuses = Array.isArray(params.status) ? params.status : [params.status];
        rows = rows.filter((item) => statuses.includes(item.status));
      }
      return rows;
    }
  },
  ImprovementJudgeVerdictRepository: class {
    upsert(input: ImprovementJudgeVerdict) {
      verdicts.set(input.campaignId, input);
      return input;
    }
    findByCampaignId(campaignId: string) {
      return verdicts.get(campaignId);
    }
  },
  clearImprovementHistoryData: () => {
    const deleted = {
      candidates: candidates.size,
      campaigns: campaigns.size,
      variantRuns: variants.size,
      judgeVerdicts: verdicts.size,
      legacyRuns: runs.size,
    };

    verdicts.clear();
    variants.clear();
    campaigns.clear();
    runs.clear();
    candidates.clear();

    return deleted;
  },
}));

vi.mock("../ExperimentEvaluationService", () => ({
  ExperimentEvaluationService: class {
    snapshot(windowDays: number) {
      return {
        generatedAt: Date.now(),
        windowDays,
        taskSuccessRate: 0.5,
        approvalDeadEndRate: 0.1,
        verificationPassRate: 0.6,
        retriesPerTask: 1,
        toolFailureRateByTool: [],
      };
    }
    evaluateVariant(params: Any) {
      const task = tasks.get(params.variant.taskId);
      const passed =
        task?.status === "completed" &&
        task?.terminalStatus === "ok" &&
        /reproduction method/i.test(String(task?.resultSummary || "")) &&
        /verification/i.test(String(task?.resultSummary || "")) &&
        /pr readiness/i.test(String(task?.resultSummary || ""));
      return {
        variantId: params.variant.id,
        lane: params.variant.lane,
        score: passed ? 0.91 : 0.1,
        targetedVerificationPassed: passed,
        verificationPassed: passed,
        promotable: passed,
        reproductionEvidenceFound: passed,
        verificationEvidenceFound: passed,
        prReadinessEvidenceFound: passed,
        regressionSignals: passed ? [] : ["Missing PR-ready verification evidence."],
        safetySignals: [],
        failureClassResolved: passed,
        replayPassRate: passed ? 1 : 0,
        diffSizePenalty: 0.02,
        artifactSummary: {
          reproductionMethod: passed ? "reproduced from logs" : undefined,
          changedFiles: passed ? ["src/app.ts"] : [],
          verificationCommands: passed ? ["npm test"] : [],
          prReadiness: passed ? "ready" : "not_ready",
          missingEvidence: passed ? [] : ["pr_readiness"],
        },
        summary: passed
          ? `Variant ${params.variant.lane} passed.`
          : `Variant ${params.variant.lane} failed.`,
        notes: [passed ? "passed" : "failed"],
      };
    }
    evaluateCampaign(params: Any) {
      const evaluations = params.variants.map((variant: Any) => this.evaluateVariant({ variant }));
      const winner = evaluations.find((item: Any) => item.promotable);
      return {
        verdict: {
          id: `judge-${params.campaign.id}`,
          campaignId: params.campaign.id,
          winnerVariantId: winner?.variantId,
          status: winner ? "passed" : "failed",
          summary: winner ? `Selected ${winner.lane} as the campaign winner.` : "No winner",
          notes: evaluations.flatMap((item: Any) => item.notes),
          comparedAt: Date.now(),
          variantRankings: evaluations.map((item: Any) => ({
            variantId: item.variantId,
            score: item.score,
            lane: item.lane,
          })),
          replayCases: params.campaign.replayCases || [],
        },
        outcomeMetrics: this.snapshot(params.evalWindowDays || 14),
        winner,
        evaluations,
      };
    }
  },
}));

describe("ImprovementLoopService", () => {
  beforeEach(() => {
    mockSettings = { ...defaultMockSettings };
    workspaces.clear();
    tasks.clear();
    candidates.clear();
    campaigns.clear();
    variants.clear();
    verdicts.clear();
    runs.clear();
    mockImprovementEligibility.mockReturnValue({
      eligible: true,
      reason: "Owner-only self-improvement is enabled.",
      enrolled: true,
      repoPath: process.cwd(),
      checks: {
        unpackagedApp: true,
        canonicalRepo: true,
        ownerEnrollment: true,
        ownerProofPresent: true,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeCandidate(): ImprovementCandidate {
    return {
      id: "candidate-1",
      workspaceId: "workspace-1",
      fingerprint: "candidate-fingerprint",
      source: "verification_failure",
      status: "open",
      title: "Fix verifier-detected regressions",
      summary: "Verifier fails because completion artifacts are missing.",
      severity: 0.95,
      recurrenceCount: 4,
      fixabilityScore: 0.9,
      priorityScore: 0.92,
      evidence: [
        {
          type: "verification_failure",
          taskId: "task-old-1",
          summary: "Verifier still fails after task completion.",
          createdAt: Date.now() - 1000,
        },
      ],
      firstSeenAt: Date.now() - 2000,
      lastSeenAt: Date.now(),
      failureStreak: 0,
    };
  }

  function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
    const base: Workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: process.cwd(),
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: true,
      },
    };
    return {
      ...base,
      ...overrides,
      permissions: overrides.permissions || base.permissions,
    };
  }

  function makeTempWorkspace(): Workspace {
    return {
      id: "__temp_workspace__:ui-session-test",
      name: "Temporary Workspace",
      path: "/tmp/cowork-os-temp/ui-session-test",
      createdAt: Date.now(),
      isTemp: true,
      permissions: {
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: true,
      },
    };
  }

  function completeVariantTask(
    taskId: string,
    summary: string,
    terminalStatus: Task["terminalStatus"] = "ok",
  ) {
    const task = tasks.get(taskId);
    tasks.set(taskId, {
      ...task!,
      status: terminalStatus === "ok" ? "completed" : "failed",
      completedAt: Date.now(),
      terminalStatus,
      worktreePath: `/tmp/${taskId}`,
      worktreeBranch: `codex/${taskId}`,
      resultSummary: summary,
    });
  }

  function attachCanonicalTaskLifecycle(daemon: Any): Any {
    daemon.completeTask = vi.fn(
      (taskId: string, summary: string, metadata?: { terminalStatus?: Task["terminalStatus"] }) => {
        const task = tasks.get(taskId);
        if (!task) return;
        tasks.set(taskId, {
          ...task,
          status: "completed",
          completedAt: Date.now(),
          terminalStatus: metadata?.terminalStatus ?? "ok",
          resultSummary: summary,
        });
      },
    );
    daemon.failTask = vi.fn(
      (
        taskId: string,
        message: string,
        metadata?: {
          terminalStatus?: Task["terminalStatus"];
          resultSummary?: string;
          failureClass?: Task["failureClass"];
        },
      ) => {
        const task = tasks.get(taskId);
        if (!task) return;
        tasks.set(taskId, {
          ...task,
          status: "failed",
          completedAt: Date.now(),
          terminalStatus: metadata?.terminalStatus ?? "failed",
          resultSummary: metadata?.resultSummary ?? message,
          error: message,
          failureClass: metadata?.failureClass,
        });
      },
    );
    return daemon;
  }

  it("runs scout then implementation sequentially and opens a draft PR", async () => {
    const workspace = makeWorkspace();
    const candidate = makeCandidate();
    workspaces.set(workspace.id, workspace);
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      markCandidateParked: vi.fn(),
      recordCampaignFailure: vi.fn(),
      recordCandidateSkip: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;

    const openPullRequest = vi
      .fn()
      .mockResolvedValue({ success: true, number: 42, url: "https://example.test/pr/42" });
    const daemon = attachCanonicalTaskLifecycle(new EventEmitter() as Any);
    daemon.createChildTask = vi.fn().mockImplementation(async (params: Any) => {
      const taskId = `task-${tasks.size + 1}`;
      const task: Task = {
        id: taskId,
        title: params.title,
        prompt: params.prompt,
        status: "executing",
        workspaceId: params.workspaceId,
        agentConfig: params.agentConfig,
        source: params.source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    });
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
      openPullRequest,
      mergeToBase: vi.fn(),
    }));

    const service = new ImprovementLoopService({} as Any, candidateService);
    await service.start(daemon);
    const campaign = await service.runNextExperiment();

    expect(campaign).toBeTruthy();
    expect(campaign?.status).toBe("reproducing");
    expect(campaign?.variants).toHaveLength(1);
    expect(daemon.createChildTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          bypassQueue: false,
          deepWorkMode: false,
          autoContinueOnTurnLimit: false,
          progressJournalEnabled: false,
        }),
      }),
    );

    const scout = campaign!.variants[0];
    completeVariantTask(
      scout.taskId!,
      "Reproduction method: reproduced from logs. Verification: scoped failure. PR readiness: not ready until fix is applied.",
    );
    daemon.emit("worktree_created", { taskId: scout.taskId, branch: `codex/${scout.id}` });
    daemon.emit("task_completed", { taskId: scout.taskId });

    await vi.waitFor(() => {
      expect(campaigns.get(campaign!.id)?.status).toBe("implementing");
      expect([...variants.values()]).toHaveLength(2);
    });

    const implement = [...variants.values()].find((variant) => variant.id !== scout.id)!;
    completeVariantTask(
      implement.taskId!,
      "Reproduction method: reproduced from logs. Changed files summary: src/app.ts. Verification: npm test passes. PR readiness: ready.",
    );
    daemon.emit("worktree_created", { taskId: implement.taskId, branch: `codex/${implement.id}` });
    daemon.emit("task_completed", { taskId: implement.taskId });

    await vi.waitFor(() => {
      const updated = campaigns.get(campaign!.id);
      expect(updated?.status).toBe("pr_opened");
      expect(updated?.promotionStatus).toBe("pr_opened");
      expect(updated?.pullRequest?.url).toBe("https://example.test/pr/42");
    });

    expect(openPullRequest).toHaveBeenCalledWith(
      implement.taskId,
      expect.objectContaining({
        title: expect.stringContaining(candidate.title),
      }),
    );
    expect(candidateService.markCandidateResolved).toHaveBeenCalledWith(candidate.id);
    expect(tasks.get(campaign!.rootTaskId!)?.status).toBe("completed");
    expect(tasks.get(campaign!.rootTaskId!)?.terminalStatus).toBe("ok");
  });

  it("fans out multiple implementation variants and chooses a winner via judge flow", async () => {
    mockSettings = { ...mockSettings, variantsPerCampaign: 3 };
    const workspace = makeWorkspace();
    const candidate = makeCandidate();
    workspaces.set(workspace.id, workspace);
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      markCandidateParked: vi.fn(),
      recordCampaignFailure: vi.fn(),
      reopenCandidate: vi.fn(),
      recordCandidateSkip: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;

    const openPullRequest = vi
      .fn()
      .mockResolvedValue({ success: true, number: 7, url: "https://example.test/pr/7" });
    const daemon = attachCanonicalTaskLifecycle(new EventEmitter() as Any);
    daemon.createChildTask = vi.fn().mockImplementation(async (params: Any) => {
      const taskId = `task-${tasks.size + 1}`;
      const task: Task = {
        id: taskId,
        title: params.title,
        prompt: params.prompt,
        status: "executing",
        workspaceId: params.workspaceId,
        agentConfig: params.agentConfig,
        source: params.source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    });
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
      openPullRequest,
      mergeToBase: vi.fn(),
    }));

    const service = new ImprovementLoopService({} as Any, candidateService);
    await service.start(daemon);
    const campaign = await service.runNextExperiment();
    const scout = campaign!.variants[0];

    completeVariantTask(
      scout.taskId!,
      "Reproduction method: reproduced from logs. Verification: scoped failure. PR readiness: not ready until fix is applied.",
    );
    daemon.emit("task_completed", { taskId: scout.taskId });

    await vi.waitFor(() => {
      expect(campaigns.get(campaign!.id)?.status).toBe("implementing");
      expect([...variants.values()]).toHaveLength(4);
    });

    const implementationVariants = [...variants.values()].filter((item) => item.id !== scout.id);
    for (const variant of implementationVariants) {
      completeVariantTask(
        variant.taskId!,
        `Reproduction method: reproduced from logs. Changed files summary: src/${variant.lane}.ts. Verification: npm test passes. PR readiness: ready.`,
      );
      daemon.emit("worktree_created", { taskId: variant.taskId, branch: `codex/${variant.id}` });
      daemon.emit("task_completed", { taskId: variant.taskId });
    }

    await vi.waitFor(() => {
      expect(campaigns.get(campaign!.id)?.status).toBe("pr_opened");
      expect(verdicts.get(campaign!.id)?.status).toBe("passed");
    });
  });

  it("fails closed when the implementation output is not promotable", async () => {
    const workspace = makeWorkspace();
    const candidate = makeCandidate();
    workspaces.set(workspace.id, workspace);
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      markCandidateParked: vi.fn(),
      recordCampaignFailure: vi.fn(),
      recordCandidateSkip: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;

    const daemon = attachCanonicalTaskLifecycle(new EventEmitter() as Any);
    daemon.createChildTask = vi.fn().mockImplementation(async (params: Any) => {
      const taskId = `task-${tasks.size + 1}`;
      const task: Task = {
        id: taskId,
        title: params.title,
        prompt: params.prompt,
        status: "executing",
        workspaceId: params.workspaceId,
        agentConfig: params.agentConfig,
        source: params.source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    });
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
      openPullRequest: vi.fn(),
      mergeToBase: vi.fn(),
    }));

    const service = new ImprovementLoopService({} as Any, candidateService);
    await service.start(daemon);
    const campaign = await service.runNextExperiment();

    const scout = campaign!.variants[0];
    completeVariantTask(
      scout.taskId!,
      "Reproduction method: reproduced from logs. Verification: scoped failure. PR readiness: not ready until fix is applied.",
    );
    daemon.emit("task_completed", { taskId: scout.taskId });

    await vi.waitFor(() => {
      expect(campaigns.get(campaign!.id)?.status).toBe("implementing");
      expect([...variants.values()]).toHaveLength(2);
    });

    const implement = [...variants.values()].find((variant) => variant.id !== scout.id)!;
    completeVariantTask(implement.taskId!, "Changed files summary only.", "failed");
    daemon.emit("task_completed", { taskId: implement.taskId });

    await vi.waitFor(() => {
      expect(campaigns.get(campaign!.id)?.status).toBe("failed");
    });
    expect(candidateService.recordCampaignFailure).toHaveBeenCalled();
    expect(campaigns.get(campaign!.id)?.promotionStatus).toBe("promotion_failed");
    expect(tasks.get(campaign!.rootTaskId!)?.status).toBe("failed");
    expect(tasks.get(campaign!.rootTaskId!)?.terminalStatus).toBe("failed");
  });

  it("parks the candidate when PR opening fails", async () => {
    const workspace = makeWorkspace();
    const candidate = makeCandidate();
    workspaces.set(workspace.id, workspace);
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      markCandidateParked: vi.fn(),
      recordCampaignFailure: vi.fn(),
      recordCandidateSkip: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;

    const openPullRequest = vi
      .fn()
      .mockResolvedValue({ success: false, error: "429 Too Many Requests" });
    const daemon = attachCanonicalTaskLifecycle(new EventEmitter() as Any);
    daemon.createChildTask = vi.fn().mockImplementation(async (params: Any) => {
      const taskId = `task-${tasks.size + 1}`;
      const task: Task = {
        id: taskId,
        title: params.title,
        prompt: params.prompt,
        status: "executing",
        workspaceId: params.workspaceId,
        agentConfig: params.agentConfig,
        source: params.source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    });
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
      openPullRequest,
      mergeToBase: vi.fn(),
    }));

    const service = new ImprovementLoopService({} as Any, candidateService);
    await service.start(daemon);
    const campaign = await service.runNextExperiment();

    const scout = campaign!.variants[0];
    completeVariantTask(
      scout.taskId!,
      "Reproduction method: reproduced from logs. Verification: scoped failure. PR readiness: not ready until fix is applied.",
    );
    daemon.emit("task_completed", { taskId: scout.taskId });

    await vi.waitFor(() => {
      expect(campaigns.get(campaign!.id)?.status).toBe("implementing");
      expect([...variants.values()]).toHaveLength(2);
    });

    const implement = [...variants.values()].find((variant) => variant.id !== scout.id)!;
    completeVariantTask(
      implement.taskId!,
      "Reproduction method: reproduced from logs. Changed files summary: src/app.ts. Verification: npm test passes. PR readiness: ready.",
    );
    daemon.emit("worktree_created", { taskId: implement.taskId, branch: `codex/${implement.id}` });
    daemon.emit("task_completed", { taskId: implement.taskId });

    await vi.waitFor(() => {
      expect(campaigns.get(campaign!.id)?.status).toBe("parked");
      expect(campaigns.get(campaign!.id)?.promotionStatus).toBe("promotion_failed");
    });
    expect(candidateService.recordCampaignFailure).toHaveBeenCalled();
    expect(tasks.get(campaign!.rootTaskId!)?.status).toBe("failed");
    expect(tasks.get(campaign!.rootTaskId!)?.terminalStatus).toBe("failed");
  });

  it("reroutes temporary-workspace candidates to the strongest promotable code workspace", async () => {
    const tempWorkspace = makeTempWorkspace();
    const realWorkspace = makeWorkspace({
      id: "workspace-real",
      name: "cowork",
      path: process.cwd(),
    });
    const candidate = makeCandidate();
    candidate.workspaceId = tempWorkspace.id;

    workspaces.set(tempWorkspace.id, tempWorkspace);
    workspaces.set(realWorkspace.id, realWorkspace);
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      markCandidateParked: vi.fn(),
      recordCampaignFailure: vi.fn(),
      recordCandidateSkip: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockImplementation((workspaceId: string) => {
        return workspaceId === tempWorkspace.id ? candidate : undefined;
      }),
    } as Any;

    const daemon = attachCanonicalTaskLifecycle(new EventEmitter() as Any);
    daemon.createChildTask = vi.fn().mockImplementation(async (params: Any) => {
      const taskId = `task-${tasks.size + 1}`;
      const task: Task = {
        id: taskId,
        title: params.title,
        prompt: params.prompt,
        status: "executing",
        workspaceId: params.workspaceId,
        agentConfig: params.agentConfig,
        source: params.source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    });
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
      openPullRequest: vi.fn(),
      mergeToBase: vi.fn(),
    }));

    const service = new ImprovementLoopService({} as Any, candidateService);
    await service.start(daemon);
    const campaign = await service.runNextExperiment();

    expect(campaign).toBeTruthy();
    expect(campaign?.executionWorkspaceId).toBe(realWorkspace.id);
    expect(tasks.get(campaign!.rootTaskId!)?.workspaceId).toBe(tempWorkspace.id);
    expect(tasks.get(campaign!.variants[0].taskId!)?.workspaceId).toBe(realWorkspace.id);
    expect(campaign?.status).toBe("reproducing");
  });

  it("always executes self-improvement inside the canonical CoWork repo while preserving the observed workspace", async () => {
    const observedWorkspace = makeWorkspace({
      id: "workspace-observed",
      name: "new",
      path: "/tmp/new",
    });
    const coworkWorkspace = makeWorkspace({
      id: "workspace-cowork",
      name: "cowork",
      path: process.cwd(),
    });
    const candidate = makeCandidate();
    candidate.workspaceId = observedWorkspace.id;
    candidate.title = "Fix repeated contract error failures";
    candidate.summary = "Failures are observed in the app, but the fix belongs in CoWork OS code.";

    workspaces.set(observedWorkspace.id, observedWorkspace);
    workspaces.set(coworkWorkspace.id, coworkWorkspace);
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      markCandidateParked: vi.fn(),
      recordCampaignFailure: vi.fn(),
      recordCandidateSkip: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockImplementation((workspaceId: string) => {
        return workspaceId === observedWorkspace.id ? candidate : undefined;
      }),
    } as Any;

    const daemon = attachCanonicalTaskLifecycle(new EventEmitter() as Any);
    daemon.createChildTask = vi.fn().mockImplementation(async (params: Any) => {
      const taskId = `task-${tasks.size + 1}`;
      const task: Task = {
        id: taskId,
        title: params.title,
        prompt: params.prompt,
        status: "executing",
        workspaceId: params.workspaceId,
        agentConfig: params.agentConfig,
        source: params.source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    });
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
      openPullRequest: vi.fn(),
      mergeToBase: vi.fn(),
    }));

    const service = new ImprovementLoopService({} as Any, candidateService);
    await service.start(daemon);
    const campaign = await service.runNextExperiment();

    expect(campaign).toBeTruthy();
    expect(campaign?.workspaceId).toBe(observedWorkspace.id);
    expect(campaign?.executionWorkspaceId).toBe(coworkWorkspace.id);
    expect(tasks.get(campaign!.rootTaskId!)?.workspaceId).toBe(observedWorkspace.id);

    const scoutTask = tasks.get(campaign!.variants[0].taskId!);
    expect(scoutTask?.workspaceId).toBe(coworkWorkspace.id);
    expect(scoutTask?.prompt).toContain(
      `Observed workspace: ${observedWorkspace.name} (${observedWorkspace.path})`,
    );
    expect(scoutTask?.prompt).toContain(
      `Execution workspace: ${coworkWorkspace.name} (${coworkWorkspace.path})`,
    );
    expect(scoutTask?.prompt).toContain(
      "Use the observed workspace for failure context and evidence, but inspect and modify code only in the execution workspace git repository.",
    );
  });

  it("fails temporary-workspace campaigns with a promotability message before git preflight", async () => {
    const tempWorkspace = makeTempWorkspace();
    const candidate = makeCandidate();
    candidate.workspaceId = tempWorkspace.id;

    workspaces.set(tempWorkspace.id, tempWorkspace);
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      markCandidateParked: vi.fn(),
      recordCampaignFailure: vi.fn(),
      recordCandidateSkip: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;

    const daemon = attachCanonicalTaskLifecycle(new EventEmitter() as Any);
    daemon.createChildTask = vi.fn();
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(false),
      openPullRequest: vi.fn(),
      mergeToBase: vi.fn(),
    }));

    const service = new ImprovementLoopService({} as Any, candidateService);
    await service.start(daemon);
    const campaign = await service.runNextExperiment();

    expect(campaign).toBeNull();
    expect(candidateService.recordCandidateSkip).toHaveBeenCalledWith(
      candidate.id,
      expect.stringContaining("cannot provide required git worktree isolation"),
    );
  });

  it("blocks campaign execution when owner-only eligibility is not satisfied", async () => {
    mockImprovementEligibility.mockReturnValue({
      eligible: false,
      reason:
        "Maintainer-signed owner enrollment is missing. Paste a valid signature into Settings → Self-Improvement, or set COWORK_SELF_IMPROVEMENT_OWNER_SIGNATURE.",
      enrolled: false,
      repoPath: process.cwd(),
      checks: {
        unpackagedApp: true,
        canonicalRepo: true,
        ownerEnrollment: false,
        ownerProofPresent: false,
      },
    });

    const workspace = makeWorkspace();
    const candidate = makeCandidate();
    workspaces.set(workspace.id, workspace);
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;

    const service = new ImprovementLoopService({} as Any, candidateService);

    await expect(service.runNextExperiment()).rejects.toThrow(
      "Maintainer-signed owner enrollment is missing. Paste a valid signature into Settings → Self-Improvement, or set COWORK_SELF_IMPROVEMENT_OWNER_SIGNATURE.",
    );
  });

  it("forces loop settings disabled when eligibility is not satisfied", () => {
    mockImprovementEligibility.mockReturnValue({
      eligible: false,
      reason: "Self-improvement is disabled in packaged end-user builds.",
      enrolled: false,
      repoPath: process.cwd(),
      checks: {
        unpackagedApp: false,
        canonicalRepo: true,
        ownerEnrollment: false,
        ownerProofPresent: false,
      },
    });

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 0 }),
    } as Any;

    const service = new ImprovementLoopService({} as Any, candidateService);
    const saved = service.saveSettings({
      ...mockSettings,
      enabled: true,
      autoRun: true,
    });

    expect(saved.enabled).toBe(false);
    expect(saved.autoRun).toBe(false);
    expect(service.getSettings().enabled).toBe(false);
    expect(service.getSettings().autoRun).toBe(false);
  });

  it("resets self-improvement history and cancels improvement tasks", async () => {
    const workspace = makeWorkspace();
    workspaces.set(workspace.id, workspace);

    const candidate = makeCandidate();
    candidates.set(candidate.id, candidate);

    const campaign: ImprovementCampaign = {
      id: "campaign-reset-1",
      candidateId: candidate.id,
      workspaceId: workspace.id,
      executionWorkspaceId: workspace.id,
      rootTaskId: "task-root-reset",
      status: "failed",
      stage: "completed",
      reviewStatus: "dismissed",
      promotionStatus: "promotion_failed",
      trainingEvidence: [],
      holdoutEvidence: [],
      replayCases: [],
      variants: [],
      createdAt: Date.now(),
    };
    campaigns.set(campaign.id, campaign);

    const variant: ImprovementVariantRun = {
      id: "variant-reset-1",
      campaignId: campaign.id,
      candidateId: candidate.id,
      workspaceId: workspace.id,
      lane: "minimal_patch",
      status: "failed",
      taskId: "task-variant-reset",
      createdAt: Date.now(),
    };
    variants.set(variant.id, variant);

    const verdict: ImprovementJudgeVerdict = {
      id: "verdict-reset-1",
      campaignId: campaign.id,
      status: "failed",
      summary: "dismissed",
      notes: [],
      comparedAt: Date.now(),
      variantRankings: [],
      replayCases: [],
    };
    verdicts.set(campaign.id, verdict);

    const legacyRun: ImprovementRun = {
      id: "run-reset-1",
      candidateId: candidate.id,
      workspaceId: workspace.id,
      status: "failed",
      reviewStatus: "dismissed",
      taskId: "task-run-reset",
      createdAt: Date.now(),
    };
    runs.set(legacyRun.id, legacyRun);

    const cancelTask = vi.fn().mockResolvedValue(undefined);
    const daemon = attachCanonicalTaskLifecycle(new EventEmitter() as Any);
    daemon.cancelTask = cancelTask;

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 0 }),
    } as Any;

    const service = new ImprovementLoopService({} as Any, candidateService);
    await service.start(daemon);

    const result = await service.resetHistory();

    expect(result.deleted).toEqual({
      candidates: 1,
      campaigns: 1,
      variantRuns: 1,
      judgeVerdicts: 1,
      legacyRuns: 1,
    });
    expect(result.cancelledTaskIds.sort()).toEqual(
      ["task-root-reset", "task-run-reset", "task-variant-reset"].sort(),
    );
    expect(cancelTask).toHaveBeenCalledTimes(3);
    expect(candidates.size).toBe(0);
    expect(campaigns.size).toBe(0);
    expect(variants.size).toBe(0);
    expect(verdicts.size).toBe(0);
    expect(runs.size).toBe(0);
    expect(result.resetAt).toBeGreaterThan(0);
  });
});
