import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import type { ImprovementCandidate } from "../../../shared/types";

const tasks = new Map<string, Any>();
const workspaces: Any[] = [];
const candidates = new Map<string, ImprovementCandidate>();
const runCandidateReassignments: Array<{ from: string; to: string }> = [];
let recentTaskRows: Array<{ id: string }> = [];
let recentEventRows: Any[] = [];
let logExists = true;
let jsonLogExists = false;
let logContents =
  "[10:00:01] Error: preload bridge exploded\n[10:00:02] uncaught exception while loading panel";
let jsonLogContents = "";

vi.mock("fs", () => {
  const mockFs = {
    existsSync: vi.fn((targetPath: string) =>
      String(targetPath).endsWith("dev-latest.jsonl") ? jsonLogExists : logExists,
    ),
    readFileSync: vi.fn((targetPath: string) =>
      String(targetPath).endsWith("dev-latest.jsonl") ? jsonLogContents : logContents,
    ),
  };
  return {
    default: mockFs,
    ...mockFs,
  };
});

vi.mock("../ImprovementSettingsManager", () => ({
  ImprovementSettingsManager: {
    loadSettings: () => ({
      enabled: true,
      autoRun: false,
      includeDevLogs: true,
      intervalMinutes: 1440,
      variantsPerCampaign: 1,
      maxConcurrentCampaigns: 1,
      maxConcurrentImprovementExecutors: 1,
      maxQueuedImprovementCampaigns: 1,
      maxOpenCandidatesPerWorkspace: 25,
      requireWorktree: true,
      reviewRequired: false,
      judgeRequired: false,
      evalWindowDays: 14,
      replaySetSize: 3,
      promotionMode: "github_pr",
      campaignTimeoutMinutes: 30,
      campaignTokenBudget: 60000,
      campaignCostBudget: 15,
    }),
  },
}));

vi.mock("../../database/repositories", () => ({
  TaskRepository: class {
    findById(id: string) {
      return tasks.get(id);
    }
  },
  WorkspaceRepository: class {
    findAll() {
      return [...workspaces];
    }
  },
}));

vi.mock("../ImprovementRepositories", () => ({
  ImprovementCandidateRepository: class {
    create(input: Any) {
      const candidate = {
        ...input,
        id: input.id || `candidate-${candidates.size + 1}`,
        firstSeenAt: input.firstSeenAt ?? Date.now(),
        lastSeenAt: input.lastSeenAt ?? Date.now(),
      };
      candidates.set(candidate.id, candidate);
      return candidate;
    }

    update(id: string, updates: Any) {
      const existing = candidates.get(id);
      if (!existing) return;
      candidates.set(id, { ...existing, ...updates });
    }

    findById(id: string) {
      return candidates.get(id);
    }

    findByFingerprint(workspaceId: string, fingerprint: string) {
      return [...candidates.values()].find(
        (candidate) =>
          candidate.workspaceId === workspaceId && candidate.fingerprint === fingerprint,
      );
    }

    delete(id: string) {
      candidates.delete(id);
    }

    list(params?: Any) {
      let rows = [...candidates.values()];
      if (params?.workspaceId) {
        rows = rows.filter((candidate) => candidate.workspaceId === params.workspaceId);
      }
      return rows.sort((a, b) => b.priorityScore - a.priorityScore);
    }

    getTopRunnableCandidate(workspaceId: string) {
      return [...candidates.values()]
        .filter((candidate) => candidate.workspaceId === workspaceId && candidate.status === "open")
        .sort((a, b) => b.priorityScore - a.priorityScore)[0];
    }
  },
  ImprovementRunRepository: class {
    reassignCandidate(fromCandidateId: string, toCandidateId: string) {
      runCandidateReassignments.push({ from: fromCandidateId, to: toCandidateId });
    }
  },
}));

import { ImprovementCandidateService } from "../ImprovementCandidateService";

describe("ImprovementCandidateService", () => {
  let db: Any;

  beforeEach(() => {
    tasks.clear();
    candidates.clear();
    runCandidateReassignments.length = 0;
    workspaces.length = 0;
    recentTaskRows = [];
    recentEventRows = [];
    logExists = true;
    jsonLogExists = false;
    logContents =
      "[10:00:01] Error: preload bridge exploded\n[10:00:02] uncaught exception while loading panel";
    jsonLogContents = "";
    db = {
      transaction: vi.fn((fn: () => void) => fn),
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM tasks")) {
          return {
            all: vi.fn(() => recentTaskRows),
          };
        }
        if (sql.includes("FROM task_events")) {
          return {
            all: vi.fn(() => recentEventRows),
          };
        }
        return {
          all: vi.fn(() => []),
          get: vi.fn(() => undefined),
        };
      }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds candidates from failed tasks, user feedback, and dev logs without double-counting refreshes", async () => {
    workspaces.push({
      id: "workspace-1",
      path: "/tmp/workspace-1",
    });
    tasks.set("task-1", {
      id: "task-1",
      title: "Broken verification flow",
      prompt: "Fix the failing verification flow",
      status: "failed",
      workspaceId: "workspace-1",
      terminalStatus: "failed",
      failureClass: "contract_error",
      resultSummary: "Post-completion verifier still fails on missing report artifact.",
    });
    recentTaskRows = [{ id: "task-1" }];
    recentEventRows = [
      {
        task_id: "task-1",
        type: "user_feedback",
        payload: JSON.stringify({
          decision: "rejected",
          reason: "The verifier still fails after completion.",
        }),
        id: "event-1",
        timestamp: Date.now(),
      },
    ];

    const service = new ImprovementCandidateService(db);
    await service.refresh();
    const firstPass = service.listCandidates("workspace-1");

    expect(firstPass.some((candidate) => candidate.source === "task_failure")).toBe(true);
    expect(firstPass.some((candidate) => candidate.source === "user_feedback")).toBe(true);
    expect(firstPass.some((candidate) => candidate.source === "dev_log")).toBe(true);

    await service.refresh();
    const secondPass = service.listCandidates("workspace-1");
    const taskFailure = secondPass.find((candidate) => candidate.source === "task_failure");
    const userFeedback = secondPass.find((candidate) => candidate.source === "user_feedback");

    expect(secondPass).toHaveLength(firstPass.length);
    expect(taskFailure?.recurrenceCount).toBe(1);
    expect(userFeedback?.recurrenceCount).toBe(1);
  });

  it("ignores partial_success tasks that only report successful checkpoint output", async () => {
    tasks.set("task-1", {
      id: "task-1",
      title: "Define next deliverable for project: TypeScript Health",
      prompt: "Define the next deliverable",
      status: "completed",
      workspaceId: "workspace-1",
      terminalStatus: "partial_success",
      failureClass: "contract_error",
      resultSummary:
        "## ✅ Step Complete: Implement Smallest Safe Change **Analysis:** The deliverable is already defined.",
    });
    recentTaskRows = [{ id: "task-1" }];

    const service = new ImprovementCandidateService(db);
    await service.refresh();

    expect(
      service
        .listCandidates("workspace-1")
        .filter((candidate) => candidate.source === "task_failure"),
    ).toHaveLength(0);
  });

  it("ignores failure candidates produced by automated autonomy tasks", async () => {
    tasks.set("task-1", {
      id: "task-1",
      title: "Chief of Staff briefing",
      prompt: "Prepare the latest briefing",
      status: "completed",
      workspaceId: "workspace-1",
      source: "hook",
      terminalStatus: "partial_success",
      failureClass: "contract_error",
      resultSummary: "Verification failed: expected artifact file evidence was not detected.",
    });
    recentTaskRows = [{ id: "task-1" }];
    recentEventRows = [
      {
        task_id: "task-1",
        type: "verification_failed",
        payload: JSON.stringify({
          message: "Verification failed during routine automated briefing generation.",
        }),
        id: "event-1",
        timestamp: Date.now(),
      },
    ];

    const service = new ImprovementCandidateService(db);
    await service.refresh();

    expect(
      service.listCandidates("workspace-1").filter((candidate) => candidate.source !== "dev_log"),
    ).toHaveLength(0);
  });

  it("lowers fixability for quota and timeout-driven failures", async () => {
    tasks.set("task-1", {
      id: "task-1",
      title: "podcast-recap-watcher-hourly",
      prompt: "Create recap",
      status: "failed",
      workspaceId: "workspace-1",
      terminalStatus: "failed",
      failureClass: "provider_quota",
      resultSummary:
        "Azure OpenAI API error: 429 - The system is currently experiencing high demand.",
    });
    recentTaskRows = [{ id: "task-1" }];

    const service = new ImprovementCandidateService(db);
    await service.refresh();
    const [candidate] = service.listCandidates("workspace-1");

    expect(candidate?.fixabilityScore).toBe(0.35);
    expect(candidate?.priorityScore).toBeLessThan(0.65);
  });

  it("does not merge unrelated project-specific task failures into one candidate", async () => {
    tasks.set("task-1", {
      id: "task-1",
      title: "Define next deliverable for project: TypeScript Health",
      prompt: "Define the next deliverable",
      status: "failed",
      workspaceId: "workspace-1",
      terminalStatus: "failed",
      failureClass: "contract_error",
      resultSummary: "Completion blocked: unresolved failed step(s): 1",
    });
    tasks.set("task-2", {
      id: "task-2",
      title: "Define next deliverable for project: Partnership Outreach",
      prompt: "Define the next deliverable",
      status: "failed",
      workspaceId: "workspace-1",
      terminalStatus: "failed",
      failureClass: "contract_error",
      resultSummary: "Completion blocked: unresolved failed step(s): 1",
    });
    recentTaskRows = [{ id: "task-1" }, { id: "task-2" }];

    const service = new ImprovementCandidateService(db);
    await service.refresh();

    expect(
      service
        .listCandidates("workspace-1")
        .filter((candidate) => candidate.source === "task_failure"),
    ).toHaveLength(2);
  });

  it("deduplicates recurring dev-log candidates across timestamp-only changes", async () => {
    workspaces.push({
      id: "workspace-1",
      path: "/tmp/workspace-1",
    });
    const service = new ImprovementCandidateService(db);

    logContents =
      "[2026-03-11T13:00:00.000Z] [0] at emitErrorNT (node:net:1976:8)\n" +
      "[2026-03-11T13:00:01.000Z] [0] at emitErrorNT (node:net:1976:8)";
    await service.refresh();

    logContents =
      "[2026-03-11T14:00:00.000Z] [0] at emitErrorNT (node:net:1976:8)\n" +
      "[2026-03-11T14:00:01.000Z] [0] at emitErrorNT (node:net:1976:8)";
    await service.refresh();

    expect(
      service.listCandidates("workspace-1").filter((candidate) => candidate.source === "dev_log"),
    ).toHaveLength(1);
  });

  it("prefers structured JSONL dev logs over text fallback", async () => {
    workspaces.push({
      id: "workspace-1",
      path: "/tmp/workspace-1",
    });
    logContents = "[10:00:01] Error: text fallback should not be used";
    jsonLogExists = true;
    jsonLogContents =
      JSON.stringify({
        timestamp: "2026-04-28T10:00:00.000Z",
        runId: "20260428-100000",
        process: "electron",
        stream: "stderr",
        level: "error",
        component: "Main",
        message: "Structured failure from JSONL",
        rawLine: "[electron] [Main] Structured failure from JSONL",
      }) + "\n";

    const service = new ImprovementCandidateService(db);
    await service.refresh();

    const [candidate] = service
      .listCandidates("workspace-1")
      .filter((row) => row.source === "dev_log");
    expect(candidate?.summary).toContain("Structured failure from JSONL");
    expect(candidate?.summary).not.toContain("text fallback");
    expect(candidate?.evidence[0]?.metadata).toMatchObject({
      format: "jsonl",
      logPath: "/tmp/workspace-1/logs/dev-latest.jsonl",
    });
  });

  it("falls back to text dev logs when JSONL is unavailable", async () => {
    workspaces.push({
      id: "workspace-1",
      path: "/tmp/workspace-1",
    });
    jsonLogExists = false;
    logContents = "[10:00:01] Error: text fallback is still supported";

    const service = new ImprovementCandidateService(db);
    await service.refresh();

    const [candidate] = service
      .listCandidates("workspace-1")
      .filter((row) => row.source === "dev_log");
    expect(candidate?.summary).toContain("text fallback is still supported");
    expect(candidate?.evidence[0]?.metadata).toMatchObject({
      format: "text",
      logPath: "/tmp/workspace-1/logs/dev-latest.log",
    });
  });

  it("resolves stale success-only task_failure candidates during refresh", async () => {
    candidates.set("candidate-1", {
      id: "candidate-1",
      workspaceId: "workspace-1",
      fingerprint: "legacy-fingerprint",
      source: "task_failure",
      status: "open",
      title: "Fix repeated contract error failures",
      summary: "## ✅ Step Complete: Workspace Link File Written",
      severity: 0.9,
      recurrenceCount: 12,
      fixabilityScore: 0.95,
      priorityScore: 0.88,
      evidence: [
        {
          type: "task_failure",
          taskId: "task-1",
          summary: "## ✅ Step Complete: Workspace Link File Written",
          createdAt: Date.now(),
          metadata: {
            terminalStatus: "partial_success",
          },
        },
      ],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    const service = new ImprovementCandidateService(db);
    await service.refresh();

    expect(service.listCandidates("workspace-1")[0]?.status).toBe("resolved");
  });

  it("reassigns historical runs before deleting merged duplicate candidates", async () => {
    workspaces.push({
      id: "workspace-1",
      path: "/tmp/workspace-1",
    });
    const normalizedFingerprint = crypto
      .createHash("sha1")
      .update("dev_log:emiterrornt")
      .digest("hex");
    candidates.set("candidate-existing", {
      id: "candidate-existing",
      workspaceId: "workspace-1",
      fingerprint: normalizedFingerprint,
      source: "dev_log",
      status: "open",
      title: "Fix repeated dev log failures",
      summary: "[2026-03-11T13:00:00.000Z] emitErrorNT",
      severity: 0.7,
      recurrenceCount: 1,
      fixabilityScore: 0.8,
      priorityScore: 0.8,
      evidence: [],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    candidates.set("candidate-duplicate", {
      id: "candidate-duplicate",
      workspaceId: "workspace-1",
      fingerprint: "legacy-fingerprint",
      source: "dev_log",
      status: "open",
      title: "Fix repeated dev log failures",
      summary: "[2026-03-11T14:00:00.000Z] emitErrorNT",
      severity: 0.8,
      recurrenceCount: 2,
      fixabilityScore: 0.85,
      priorityScore: 0.82,
      evidence: [],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    const service = new ImprovementCandidateService(db);
    await service.refresh();

    expect(runCandidateReassignments).toEqual([
      { from: "candidate-duplicate", to: "candidate-existing" },
    ]);
    expect(candidates.has("candidate-duplicate")).toBe(false);
  });

  it("keeps runnable readiness while recording the latest skip reason", () => {
    candidates.set("candidate-1", {
      id: "candidate-1",
      workspaceId: "workspace-1",
      fingerprint: "fingerprint-1",
      source: "task_failure",
      status: "open",
      title: "Fix repeated contract error failures",
      summary: "Verifier still fails after completion.",
      severity: 0.9,
      recurrenceCount: 2,
      fixabilityScore: 0.95,
      priorityScore: 0.88,
      evidence: [
        {
          type: "task_failure",
          taskId: "task-1",
          summary: "Verifier still fails after completion.",
          createdAt: Date.now(),
        },
      ],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    const service = new ImprovementCandidateService(db);
    service.recordCandidateSkip(
      "candidate-1",
      "Skipped because no promotable worktree is available.",
    );

    expect(candidates.get("candidate-1")?.readiness).toBe("ready");
    expect(candidates.get("candidate-1")?.readinessReason).toBe(
      "Skipped because no promotable worktree is available.",
    );
    expect(candidates.get("candidate-1")?.lastSkipReason).toBe(
      "Skipped because no promotable worktree is available.",
    );
  });

  it("parks repeated provider failures with blocked_provider readiness", () => {
    candidates.set("candidate-1", {
      id: "candidate-1",
      workspaceId: "workspace-1",
      fingerprint: "fingerprint-1",
      source: "task_failure",
      status: "open",
      title: "Fix repeated provider failures",
      summary: "429 from provider",
      severity: 0.7,
      recurrenceCount: 1,
      fixabilityScore: 0.35,
      priorityScore: 0.5,
      evidence: [
        {
          type: "task_failure",
          taskId: "task-1",
          summary: "429 from provider",
          createdAt: Date.now(),
        },
      ],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    const service = new ImprovementCandidateService(db);
    for (let i = 0; i < 3; i += 1) {
      service.recordCampaignFailure("candidate-1", {
        failureClass: "provider_rate_limited",
        attemptFingerprint: "candidate-1:fingerprint-1:promotion",
        reason: "429 Too Many Requests",
      });
    }

    expect(candidates.get("candidate-1")?.status).toBe("parked");
    expect(candidates.get("candidate-1")?.readiness).toBe("blocked_provider");
    expect(candidates.get("candidate-1")?.parkReason).toBe("429 Too Many Requests");
  });
});
