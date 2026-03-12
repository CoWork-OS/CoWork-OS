import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type {
  ImprovementCampaign,
  ImprovementCandidate,
  ImprovementJudgeVerdict,
  ImprovementVariantRun,
  Task,
  Workspace,
} from "../../../shared/types";
import { ImprovementLoopService } from "../ImprovementLoopService";

const workspaces = new Map<string, Workspace>();
const tasks = new Map<string, Task>();
const candidates = new Map<string, ImprovementCandidate>();
const campaigns = new Map<string, ImprovementCampaign>();
const variants = new Map<string, ImprovementVariantRun>();
const verdicts = new Map<string, ImprovementJudgeVerdict>();

let mockSettings = {
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
  reviewRequired: false,
  judgeRequired: false,
  promotionMode: "github_pr" as const,
  evalWindowDays: 14,
  replaySetSize: 2,
  campaignTimeoutMinutes: 30,
  campaignTokenBudget: 60000,
  campaignCostBudget: 15,
};

vi.mock("../ImprovementSettingsManager", () => ({
  ImprovementSettingsManager: {
    loadSettings: () => mockSettings,
    saveSettings: vi.fn(),
  },
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
      if (params?.workspaceId) rows = rows.filter((item) => item.workspaceId === params.workspaceId);
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
      if (params?.workspaceId) rows = rows.filter((item) => item.workspaceId === params.workspaceId);
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
        regressionSignals: passed ? [] : ["Missing PR-ready verification evidence."],
        failureClassResolved: passed,
        replayPassRate: passed ? 1 : 0,
        diffSizePenalty: 0.02,
        summary: passed ? `Variant ${params.variant.lane} passed.` : `Variant ${params.variant.lane} failed.`,
        notes: [passed ? "passed" : "failed"],
      };
    }
    evaluateCampaign() {
      throw new Error("evaluateCampaign should not be used in staged self-improvement mode");
    }
  },
}));

describe("ImprovementLoopService", () => {
  beforeEach(() => {
    workspaces.clear();
    tasks.clear();
    candidates.clear();
    campaigns.clear();
    variants.clear();
    verdicts.clear();
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

  function makeWorkspace(): Workspace {
    return {
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
  }

  function completeVariantTask(taskId: string, summary: string, terminalStatus: Task["terminalStatus"] = "ok") {
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
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;

    const openPullRequest = vi.fn().mockResolvedValue({ success: true, number: 42, url: "https://example.test/pr/42" });
    const daemon = new EventEmitter() as Any;
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
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;

    const daemon = new EventEmitter() as Any;
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
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;

    const openPullRequest = vi.fn().mockResolvedValue({ success: false, error: "429 Too Many Requests" });
    const daemon = new EventEmitter() as Any;
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
  });
});
