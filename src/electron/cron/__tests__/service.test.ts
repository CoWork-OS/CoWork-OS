/**
 * Tests for CronService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  CronJob as _CronJob,
  CronJobCreate,
  CronServiceDeps,
  CronStoreFile,
  CronEvent,
} from "../types";

// Job ID counter for tests that need unique IDs
let jobIdCounter = 0;
const getNextJobId = () => `job-${++jobIdCounter}`;

// Mock dependencies
vi.mock("uuid", () => ({
  v4: vi.fn(() => getNextJobId()),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Create mock store module
const _mockStore: CronStoreFile = { version: 1, jobs: [] };
vi.mock("../store", () => ({
  loadCronStore: vi.fn().mockResolvedValue({ version: 1, jobs: [] }),
  saveCronStore: vi.fn().mockResolvedValue(undefined),
  resolveCronStorePath: vi.fn().mockImplementation((p) => p || "/mock/cron/jobs.json"),
}));

vi.mock("../webhook", () => ({
  CronWebhookServer: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getAddress: vi.fn().mockReturnValue(null),
    setTriggerHandler: vi.fn(),
    setJobLookup: vi.fn(),
  })),
}));

// Import after mocking
import { CronService, getCronService, setCronService } from "../service";
import { loadCronStore, saveCronStore } from "../store";

describe("CronService", () => {
  let service: CronService;
  let mockCreateTask: CronServiceDeps["createTask"];
  let mockOnEvent: CronServiceDeps["onEvent"];
  let events: CronEvent[];

  const createService = (overrides: Partial<CronServiceDeps> = {}): CronService => {
    mockCreateTask = vi.fn().mockResolvedValue({ id: "task-123" }) as CronServiceDeps["createTask"];
    mockOnEvent = vi.fn((evt: CronEvent) => events.push(evt)) as CronServiceDeps["onEvent"];

    return new CronService({
      cronEnabled: true,
      storePath: "/test/cron/jobs.json",
      createTask: mockCreateTask,
      onEvent: mockOnEvent,
      nowMs: () => 1000000,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      ...overrides,
    });
  };

  beforeEach(() => {
    events = [];
    jobIdCounter = 0; // Reset counter for each test
    vi.clearAllMocks();
    (loadCronStore as ReturnType<typeof vi.fn>).mockResolvedValue({ version: 1, jobs: [] });
  });

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
    vi.useRealTimers();
  });

  describe("start/stop lifecycle", () => {
    it("should start service and load jobs", async () => {
      service = createService();
      await service.start();

      expect(loadCronStore).toHaveBeenCalled();
    });

    it("should not start if cronEnabled is false", async () => {
      service = createService({ cronEnabled: false });
      await service.start();

      // Store should not be loaded when disabled
      const status = await service.status();
      expect(status.enabled).toBe(false);
    });

    it("should stop cleanly", async () => {
      service = createService();
      await service.start();
      await service.stop();

      // Service should be stopped
      const status = await service.status();
      expect(status.jobCount).toBe(0);
    });

    it("keeps a missed overdue run due on startup so it can catch up", async () => {
      vi.useFakeTimers();
      (loadCronStore as ReturnType<typeof vi.fn>).mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: "job-stale",
            name: "Stale Job",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            workspaceId: "ws-1",
            taskPrompt: "Run stale work",
            schedule: { kind: "every", everyMs: 60000 },
            state: {
              nextRunAtMs: 900000,
              runHistory: [],
              totalRuns: 0,
              successfulRuns: 0,
              failedRuns: 0,
            },
          },
        ],
      } satisfies CronStoreFile);

      service = createService({ nowMs: () => 1000000, defaultTimeoutMs: 10000 });
      await service.start();

      const job = await service.get("job-stale");
      expect(job?.state.lastStatus).toBeUndefined();
      expect(job?.state.nextRunAtMs).toBe(900000);
      expect(job?.state.runHistory).toHaveLength(0);
      expect(mockCreateTask).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("preserves an active matching cron task on startup instead of creating a duplicate", async () => {
      (loadCronStore as ReturnType<typeof vi.fn>).mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: "job-active",
            name: "Active Job",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            workspaceId: "ws-1",
            taskPrompt: "Run active work",
            taskTitle: "Daily CoWork OS Project Brief",
            schedule: { kind: "every", everyMs: 60000 },
            state: {
              nextRunAtMs: 900000,
              runHistory: [],
              totalRuns: 0,
              successfulRuns: 0,
              failedRuns: 0,
            },
          },
        ],
      } satisfies CronStoreFile);

      service = createService({
        nowMs: () => 1000000,
        findActiveTaskForJob: async () => ({ id: "task-active", status: "interrupted" }),
      });
      await service.start();

      const job = await service.get("job-active");
      expect(job?.state.lastTaskId).toBe("task-active");
      expect(job?.state.runningAtMs).toBe(1000000);
      expect(job?.state.nextRunAtMs).toBe(1060000);

      const result = await service.run("job-active", "due");
      expect(result).toEqual({ ok: true, ran: false, reason: "not-due" });
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    it("does not use title fallback when multiple enabled jobs share a task title", async () => {
      const finder = vi.fn().mockResolvedValue(null);
      (loadCronStore as ReturnType<typeof vi.fn>).mockResolvedValue({
        version: 1,
        jobs: [
          {
            id: "job-a",
            name: "Shared A",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            workspaceId: "ws-1",
            taskPrompt: "Run A",
            taskTitle: "Shared Title",
            schedule: { kind: "every", everyMs: 60000 },
            state: { nextRunAtMs: 900000, runHistory: [] },
          },
          {
            id: "job-b",
            name: "Shared B",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            workspaceId: "ws-1",
            taskPrompt: "Run B",
            taskTitle: "Shared Title",
            schedule: { kind: "every", everyMs: 60000 },
            state: { nextRunAtMs: 1200000, runHistory: [] },
          },
        ],
      } satisfies CronStoreFile);

      service = createService({
        nowMs: () => 1000000,
        findActiveTaskForJob: finder,
      });
      await service.start();

      expect(finder).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "job-a",
          allowTitleFallback: false,
        }),
      );
    });
  });

  describe("status", () => {
    it("should return service status", async () => {
      service = createService();
      await service.start();

      const status = await service.status();

      expect(status.enabled).toBe(true);
      expect(status.storePath).toBe("/test/cron/jobs.json");
      expect(status.jobCount).toBe(0);
      expect(status.enabledJobCount).toBe(0);
      expect(status.runningJobCount).toBe(0);
    });
  });

  describe("add", () => {
    it("should add a new job", async () => {
      service = createService();
      await service.start();

      const input: CronJobCreate = {
        name: "Test Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Run test task",
        schedule: { kind: "every", everyMs: 60000 },
      };

      const result = await service.add(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job).toBeDefined();
        expect(result.job.name).toBe("Test Job");
        expect(result.job.id).toBe("job-1");
      }
      expect(saveCronStore).toHaveBeenCalled();
    });

    it("applies workspace resolution during add when resolver is provided", async () => {
      service = createService({
        resolveWorkspaceContext: async ({ phase }) =>
          phase === "add" ? { workspaceId: "ws-managed" } : null,
      });
      await service.start();

      const result = await service.add({
        name: "Resolved Job",
        enabled: true,
        workspaceId: "ws-temp",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.workspaceId).toBe("ws-managed");
      }
    });

    it("should emit added event", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Event Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: "job-1",
          action: "added",
        }),
      );
    });

    it("should compute next run time for enabled jobs", async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      const result = await service.add({
        name: "Scheduled Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.state.nextRunAtMs).toBe(1060000); // nowMs + everyMs
      }
    });

    it("should not compute next run time for disabled jobs", async () => {
      service = createService();
      await service.start();

      const result = await service.add({
        name: "Disabled Job",
        enabled: false,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.state.nextRunAtMs).toBeUndefined();
      }
    });
  });

  describe("get", () => {
    it("should get a job by ID", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Get Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const job = await service.get("job-1");

      expect(job).toBeDefined();
      expect(job?.name).toBe("Get Test");
    });

    it("should return null for non-existent job", async () => {
      service = createService();
      await service.start();

      const job = await service.get("non-existent");

      expect(job).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all enabled jobs", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Enabled Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      await service.add({
        name: "Disabled Job",
        enabled: false,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const jobs = await service.list();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("Enabled Job");
    });

    it("should list all jobs when includeDisabled is true", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Enabled Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      await service.add({
        name: "Disabled Job",
        enabled: false,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const jobs = await service.list({ includeDisabled: true });

      expect(jobs).toHaveLength(2);
    });
  });

  describe("update", () => {
    it("should update a job", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Original Name",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const result = await service.update("job-1", {
        name: "Updated Name",
        taskPrompt: "Updated prompt",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.name).toBe("Updated Name");
        expect(result.job.taskPrompt).toBe("Updated prompt");
      }
    });

    it("should return error for non-existent job", async () => {
      service = createService();
      await service.start();

      const result = await service.update("non-existent", { name: "New Name" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Job not found");
      }
    });

    it("should emit updated event", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Event Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      events = []; // Clear events from add

      await service.update("job-1", { name: "Updated" });

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: "job-1",
          action: "updated",
        }),
      );
    });

    it("should recompute next run time when schedule changes", async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      await service.add({
        name: "Schedule Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const result = await service.update("job-1", {
        schedule: { kind: "every", everyMs: 120000 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.state.nextRunAtMs).toBe(1120000); // nowMs + new everyMs
      }
    });

    it("should clear next run time when job is disabled", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Disable Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const result = await service.update("job-1", { enabled: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.state.nextRunAtMs).toBeUndefined();
      }
    });
  });

  describe("remove", () => {
    it("should remove a job", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Remove Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const result = await service.remove("job-1");

      expect(result.ok).toBe(true);
      expect(result.removed).toBe(true);

      const job = await service.get("job-1");
      expect(job).toBeNull();
    });

    it("should return removed: false for non-existent job", async () => {
      service = createService();
      await service.start();

      const result = await service.remove("non-existent");

      expect(result.ok).toBe(true);
      expect(result.removed).toBe(false);
    });

    it("should emit removed event", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Event Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      events = [];

      await service.remove("job-1");

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: "job-1",
          action: "removed",
        }),
      );
    });
  });

  describe("run", () => {
    it("should run a job and create a task", async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      await service.add({
        name: "Run Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Run this task",
        schedule: { kind: "at", atMs: 900000 }, // Past time
        state: { nextRunAtMs: 900000 },
      });

      const result = await service.run("job-1", "force");

      expect(result.ok).toBe(true);
      if (result.ok && "ran" in result && result.ran) {
        expect(result.taskId).toBe("task-123");
      }
      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Run this task"),
          workspaceId: "ws-1",
          allowUserInput: false,
        }),
      );
    });

    it("passes a named access profile without reapplying the legacy shell restriction", async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      await service.add({
        name: "Profiled Job",
        enabled: true,
        accessProfileId: "ask_for_approval",
        workspaceId: "ws-1",
        taskPrompt: "Run the profiled task",
        schedule: { kind: "at", atMs: 900000 },
        state: { nextRunAtMs: 900000 },
      });

      await service.run("job-1", "force");

      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          agentConfig: expect.objectContaining({ accessProfileId: "ask_for_approval" }),
        }),
      );
      const call = (mockCreateTask as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Any;
      expect(call.agentConfig.toolRestrictions).toBeUndefined();
    });

    it("persists the run lease before waiting for task creation", async () => {
      let resolveCreateTask: (value: { id: string }) => void = () => {};
      const snapshots: CronStoreFile[] = [];
      (saveCronStore as ReturnType<typeof vi.fn>).mockImplementation(async (_path, store) => {
        snapshots.push(JSON.parse(JSON.stringify(store)) as CronStoreFile);
      });
      const createTask = vi.fn(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveCreateTask = resolve;
          }),
      ) as CronServiceDeps["createTask"] & ReturnType<typeof vi.fn>;

      service = createService({
        nowMs: () => 1000000,
        createTask,
      });
      await service.start();

      await service.add({
        name: "Lease Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Run this task",
        schedule: { kind: "every", everyMs: 60000 },
        state: { nextRunAtMs: 900000 },
      });
      snapshots.length = 0;

      const runPromise = service.run("job-1", "force");

      await vi.waitFor(() => {
        expect(snapshots.length).toBeGreaterThan(0);
      });
      expect(snapshots[0].jobs[0].state.runningAtMs).toBe(1000000);
      expect(snapshots[0].jobs[0].state.lastRunAtMs).toBe(1000000);
      expect(snapshots[0].jobs[0].state.nextRunAtMs).toBe(1060000);
      expect(snapshots[0].jobs[0].state.lastTaskId).toBeUndefined();

      resolveCreateTask({ id: "task-created" });
      await runPromise;

      expect(createTask.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          jobId: "job-1",
          agentConfig: expect.objectContaining({ scheduledJobId: "job-1" }),
        }),
      );
      expect(
        snapshots.some((snapshot) => snapshot.jobs[0].state.lastTaskId === "task-created"),
      ).toBe(true);
    });

    it("does not create a due run when the previous cron task is still active", async () => {
      service = createService({
        nowMs: () => 1000000,
        getTaskStatus: async () => ({ status: "executing" }),
      });
      await service.start();

      await service.add({
        name: "Duplicate Guard",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Run this task",
        schedule: { kind: "at", atMs: 900000 },
      });
      await service.update("job-1", {
        state: {
          nextRunAtMs: 900000,
          runningAtMs: 900000,
          lastTaskId: "task-existing",
        },
      });

      const result = await service.run("job-1", "due");

      expect(result).toEqual({ ok: true, ran: false, reason: "already-running" });
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    it("persists thread follow-up lastTaskId immediately after sending", async () => {
      const snapshots: CronStoreFile[] = [];
      (saveCronStore as ReturnType<typeof vi.fn>).mockImplementation(async (_path, store) => {
        snapshots.push(JSON.parse(JSON.stringify(store)) as CronStoreFile);
      });
      const sendTaskMessage = vi
        .fn()
        .mockResolvedValue({ queued: true }) as CronServiceDeps["sendTaskMessage"];
      service = createService({ nowMs: () => 1000000, sendTaskMessage });
      await service.start();

      await service.add({
        name: "Follow-up Lease",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Continue",
        schedule: { kind: "every", everyMs: 60000 },
        runMode: "thread_follow_up",
        targetTaskId: "task-existing",
      });
      snapshots.length = 0;

      await service.run("job-1", "force");

      expect(sendTaskMessage).toHaveBeenCalledTimes(1);
      expect(
        snapshots.some((snapshot) => snapshot.jobs[0].state.lastTaskId === "task-existing"),
      ).toBe(true);
    });

    it("cleans the in-memory running marker when task creation fails", async () => {
      const errorCreateTask = vi
        .fn()
        .mockRejectedValue(new Error("Task creation failed")) as CronServiceDeps["createTask"];
      service = createService({ createTask: errorCreateTask });
      await service.start();

      await service.add({
        name: "Error Cleanup Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      await service.run("job-1", "force");

      expect((service as Any).state.runningJobIds.has("job-1")).toBe(false);
    });

    it("should render custom template variables", async () => {
      service = createService({
        nowMs: () => 1000000,
        resolveTemplateVariables: async () => ({ foo: "bar" }),
      });
      await service.start();

      await service.add({
        name: "Template Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Hello {{foo}}",
        schedule: { kind: "at", atMs: 900000 }, // Past time
        state: { nextRunAtMs: 900000 },
      });

      await service.run("job-1", "force");

      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Hello bar"),
        }),
      );
    });

    it("applies run workspace context and injects scheduled run paths", async () => {
      service = createService({
        nowMs: () => 1000000,
        resolveWorkspaceContext: async ({ phase }) =>
          phase === "run"
            ? {
                workspaceId: "ws-managed",
                workspacePath: "/managed/workspace",
                runWorkspacePath: "/managed/workspace/.cowork/scheduled-runs/run-1",
                runWorkspaceRelativePath: ".cowork/scheduled-runs/run-1",
              }
            : null,
      });
      await service.start();

      await service.add({
        name: "Run Context",
        enabled: true,
        workspaceId: "ws-temp",
        taskPrompt: "Write output into {{run_workspace_path}}",
        schedule: { kind: "at", atMs: 900000 },
        state: { nextRunAtMs: 900000 },
      });

      await service.run("job-1", "force");

      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-managed",
        }),
      );
      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("/managed/workspace/.cowork/scheduled-runs/run-1"),
        }),
      );

      const job = await service.get("job-1");
      expect(job?.workspaceId).toBe("ws-managed");

      const history = await service.getRunHistory("job-1");
      expect(history?.entries[0].workspaceId).toBe("ws-managed");
      expect(history?.entries[0].runWorkspacePath).toBe(
        "/managed/workspace/.cowork/scheduled-runs/run-1",
      );
    });

    it("should skip delivery when deliverOnlyIfResult is enabled and no result is available", async () => {
      const deliverToChannel = vi.fn().mockResolvedValue(undefined);
      service = createService({
        nowMs: () => 1000000,
        deliverToChannel,
      });
      await service.start();

      await service.add({
        name: "Delivery Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Do work",
        schedule: { kind: "at", atMs: 900000 }, // Past time
        state: { nextRunAtMs: 900000 },
        delivery: {
          enabled: true,
          channelType: "telegram" as Any,
          channelId: "chat-1",
          deliverOnlyIfResult: true,
        },
      });

      await service.run("job-1", "force");

      expect(deliverToChannel).not.toHaveBeenCalled();
    });

    it("should deliver when deliverOnlyIfResult is enabled and a non-empty result is available", async () => {
      const deliverToChannel = vi.fn().mockResolvedValue(undefined);
      service = createService({
        nowMs: () => 1000000,
        deliverToChannel,
        getTaskStatus: async () => ({ status: "completed" }),
        getTaskResultText: async () => "OK",
      });
      await service.start();

      await service.add({
        name: "Delivery Test 2",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Do work",
        schedule: { kind: "at", atMs: 900000 }, // Past time
        state: { nextRunAtMs: 900000 },
        delivery: {
          enabled: true,
          channelType: "telegram" as Any,
          channelId: "chat-1",
          deliverOnlyIfResult: true,
        },
      });

      await service.run("job-1", "force");

      expect(deliverToChannel).toHaveBeenCalledTimes(1);
    });

    it("marks run as partial_success when task completes with partial terminal status", async () => {
      service = createService({
        nowMs: () => 1000000,
        getTaskStatus: async () => ({
          status: "completed",
          terminalStatus: "partial_success",
          resultSummary: "Partial summary",
        }),
        getTaskResultText: async () => "Partial summary",
      });
      await service.start();

      await service.add({
        name: "Partial Status Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Do work",
        schedule: { kind: "at", atMs: 900000 },
        state: { nextRunAtMs: 900000 },
      });

      await service.run("job-1", "force");
      const history = await service.getRunHistory("job-1");
      expect(history?.entries[0]?.status).toBe("partial_success");
      expect(history?.successfulRuns).toBe(1);
      expect(history?.failedRuns).toBe(0);
    });

    it("maps a paused task at the polling deadline to needs_user_action", async () => {
      let nowMs = 1_000_000;
      service = createService({
        nowMs: () => {
          nowMs += 2;
          return nowMs;
        },
        defaultTimeoutMs: 1,
        getTaskStatus: async () => ({
          status: "paused",
          error: "Task paused for user input",
        }),
      });
      await service.start();

      await service.add({
        name: "Paused Deadline Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Do work",
        schedule: { kind: "at", atMs: 900000 },
        state: { nextRunAtMs: 900000 },
      });

      await service.run("job-1", "force");

      const history = await service.getRunHistory("job-1");
      expect(history?.entries[0]?.status).toBe("needs_user_action");
      expect(history?.entries[0]?.error).toBe("Task paused for user input");
      expect(history?.entries[0]?.taskStillRunning).toBeFalsy();
      expect(events).toContainEqual(
        expect.objectContaining({
          action: "finished",
          status: "needs_user_action",
          taskStillRunning: false,
        }),
      );
    });

    it("marks a still-running task at the polling deadline as timeout with taskStillRunning", async () => {
      let nowMs = 1_000_000;
      service = createService({
        nowMs: () => {
          nowMs += 2;
          return nowMs;
        },
        defaultTimeoutMs: 1,
        getTaskStatus: async () => ({
          status: "executing",
        }),
      });
      await service.start();

      await service.add({
        name: "Running Deadline Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Do work",
        schedule: { kind: "at", atMs: 900000 },
        state: { nextRunAtMs: 900000 },
      });

      await service.run("job-1", "force");

      const history = await service.getRunHistory("job-1");
      expect(history?.entries[0]?.status).toBe("timeout");
      expect(history?.entries[0]?.taskStillRunning).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({
          action: "finished",
          status: "timeout",
          taskStillRunning: true,
        }),
      );
    });

    it("queues delivery in outbox when direct delivery fails, then sends from outbox", async () => {
      const deliverToChannel = vi
        .fn()
        .mockRejectedValueOnce(new Error("down-1"))
        .mockResolvedValue(undefined);

      service = createService({
        nowMs: () => 1000000,
        deliverToChannel,
        getTaskStatus: async () => ({ status: "completed", terminalStatus: "ok" }),
        getTaskResultText: async () => "OK",
      });
      await service.start();

      await service.add({
        name: "Outbox Delivery Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Do work",
        schedule: { kind: "at", atMs: 900000 },
        state: { nextRunAtMs: 900000 },
        delivery: {
          enabled: true,
          channelType: "telegram" as Any,
          channelId: "chat-1",
        },
      });

      await service.run("job-1", "force");
      const queuedHistory = await service.getRunHistory("job-1");
      expect(queuedHistory?.entries[0]?.deliveryMode).toBe("outbox");
      expect(queuedHistory?.entries[0]?.deliverableStatus).toBe("queued");
      expect(queuedHistory?.entries[0]?.deliveryAttempts).toBe(1);

      const internalStore = (service as Any).state.store as CronStoreFile;
      expect(Array.isArray(internalStore.outbox)).toBe(true);
      expect(internalStore.outbox?.length).toBe(1);
      if (internalStore.outbox?.[0]) {
        internalStore.outbox[0].nextAttemptAtMs = 0;
      }

      await (service as Any).processOutboxQueue();

      const sentHistory = await service.getRunHistory("job-1");
      expect(sentHistory?.entries[0]?.deliverableStatus).toBe("sent");
      expect(sentHistory?.entries[0]?.deliveryAttempts).toBe(2);
      expect(deliverToChannel).toHaveBeenCalledTimes(2);
    });

    it("uses a per-run idempotency key for channel delivery", async () => {
      const deliverToChannel = vi.fn().mockResolvedValue(undefined);
      service = createService({
        nowMs: () => 1000000,
        deliverToChannel,
        getTaskStatus: async () => ({ status: "completed", terminalStatus: "ok" }),
        getTaskResultText: async () => "OK",
      });
      await service.start();

      await service.add({
        name: "Idempotency Key Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Do work",
        schedule: { kind: "at", atMs: 900000 },
        state: { nextRunAtMs: 900000 },
        delivery: {
          enabled: true,
          channelType: "telegram" as Any,
          channelId: "chat-1",
        },
      });

      await service.run("job-1", "force");

      expect(deliverToChannel).toHaveBeenCalledTimes(1);
      const call = deliverToChannel.mock.calls[0]?.[0] as Any;
      expect(call?.idempotencyKey).toBe("job-1:1000000:task-123:telegram:chat-1");
    });

    it("adds scheduled delivery guidance to the task prompt", async () => {
      service = createService({
        nowMs: () => 1000000,
        deliverToChannel: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
      });
      await service.start();

      await service.add({
        name: "Prompt Guidance Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Produce the report",
        schedule: { kind: "at", atMs: 900000 },
        state: { nextRunAtMs: 900000 },
        delivery: {
          enabled: true,
          channelType: "whatsapp" as Any,
          channelId: "chat-1",
        },
      });

      await service.run("job-1", "force");

      const call = (mockCreateTask as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Any;
      expect(call.prompt).toContain("Scheduled task delivery:");
      expect(call.prompt).toContain(
        "Do not call channel, messaging, or notification tools to message the user yourself.",
      );
      expect(call.prompt).toContain("Produce the report");
    });

    it("does not add delivery guidance when channel delivery is not configured", async () => {
      service = createService({
        nowMs: () => 1000000,
      });
      await service.start();

      await service.add({
        name: "Local Scheduled Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Write the local report",
        schedule: { kind: "at", atMs: 900000 },
        state: { nextRunAtMs: 900000 },
      });

      await service.run("job-1", "force");

      const call = (mockCreateTask as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Any;
      expect(call.prompt).not.toContain("Scheduled task delivery:");
      expect(call.prompt).toContain("Write the local report");
    });

    it("should return not-found for non-existent job", async () => {
      service = createService();
      await service.start();

      const result = await service.run("non-existent");

      expect(result.ok).toBe(true);
      if (result.ok && "ran" in result && !result.ran) {
        expect(result.reason).toBe("not-found");
      }
    });

    it("should return disabled for disabled job in due mode", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Disabled Job",
        enabled: false,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const result = await service.run("job-1", "due");

      expect(result.ok).toBe(true);
      if (result.ok && "ran" in result && !result.ran) {
        expect(result.reason).toBe("disabled");
      }
    });

    it("should run disabled job in force mode", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Disabled Job",
        enabled: false,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const result = await service.run("job-1", "force");

      expect(result.ok).toBe(true);
      if (result.ok && "ran" in result) {
        expect(result.ran).toBe(true);
      }
    });

    it("should return not-due if job is not due yet", async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      await service.add({
        name: "Future Job",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "at", atMs: 2000000 }, // Future time
      });

      const result = await service.run("job-1", "due");

      expect(result.ok).toBe(true);
      if (result.ok && "ran" in result && !result.ran) {
        expect(result.reason).toBe("not-due");
      }
    });

    it("should emit started and finished events", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Event Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      events = [];

      await service.run("job-1", "force");

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: "job-1",
          action: "started",
        }),
      );

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: "job-1",
          action: "finished",
          status: "ok",
          taskId: "task-123",
        }),
      );
    });

    it("should send thread follow-up jobs to the target task instead of creating a new task", async () => {
      const sendTaskMessage = vi
        .fn()
        .mockResolvedValue({ queued: true }) as CronServiceDeps["sendTaskMessage"];
      service = createService({ sendTaskMessage });
      await service.start();

      await service.add({
        name: "Continue Existing Task",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Check the latest status.",
        schedule: { kind: "every", everyMs: 60000 },
        runMode: "thread_follow_up",
        targetTaskId: "task-existing",
        threadAutomation: {
          sourceTaskId: "task-existing",
          sourceTaskTitle: "Original Work",
          wakeObjective: "Follow up on open loops",
        },
      });

      const result = await service.run("job-1", "force");

      expect(result.ok).toBe(true);
      expect(mockCreateTask).not.toHaveBeenCalled();
      expect(sendTaskMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-existing",
          message: expect.stringContaining("Scheduled thread wake:"),
        }),
      );
      expect(sendTaskMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Check the latest status."),
        }),
      );
      const history = await service.getRunHistory("job-1");
      expect(history?.entries[0]).toMatchObject({
        status: "ok",
        taskId: "task-existing",
        runMode: "thread_follow_up",
      });
    });

    it("should handle createTask errors", async () => {
      const errorCreateTask = vi
        .fn()
        .mockRejectedValue(new Error("Task creation failed")) as CronServiceDeps["createTask"];
      service = createService({ createTask: errorCreateTask });
      await service.start();

      await service.add({
        name: "Error Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      const result = await service.run("job-1", "force");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Task creation failed");
      }
    });

    it("should delete one-shot job after run", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "One-shot Job",
        enabled: true,
        deleteAfterRun: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "at", atMs: 900000 },
      });

      await service.run("job-1", "force");

      const job = await service.get("job-1");
      expect(job).toBeNull();
    });
  });

  describe("run history", () => {
    it("should track run history", async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      await service.add({
        name: "History Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      await service.run("job-1", "force");

      const history = await service.getRunHistory("job-1");

      expect(history).toBeDefined();
      expect(history?.entries).toHaveLength(1);
      expect(history?.entries[0].status).toBe("ok");
      expect(history?.entries[0].taskId).toBe("task-123");
      expect(history?.totalRuns).toBe(1);
      expect(history?.successfulRuns).toBe(1);
      expect(history?.failedRuns).toBe(0);
    });

    it("should return null for non-existent job", async () => {
      service = createService();
      await service.start();

      const history = await service.getRunHistory("non-existent");

      expect(history).toBeNull();
    });

    it("should limit history entries", async () => {
      service = createService({ maxHistoryEntries: 2 });
      await service.start();

      await service.add({
        name: "Limited History",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      // Run multiple times
      await service.run("job-1", "force");
      await service.run("job-1", "force");
      await service.run("job-1", "force");

      const history = await service.getRunHistory("job-1");

      expect(history?.entries).toHaveLength(2);
      expect(history?.totalRuns).toBe(3);
    });

    it("should clear run history", async () => {
      service = createService();
      await service.start();

      await service.add({
        name: "Clear History Test",
        enabled: true,
        workspaceId: "ws-1",
        taskPrompt: "Test",
        schedule: { kind: "every", everyMs: 60000 },
      });

      await service.run("job-1", "force");

      const cleared = await service.clearRunHistory("job-1");
      expect(cleared).toBe(true);

      const history = await service.getRunHistory("job-1");
      expect(history?.entries).toHaveLength(0);
      expect(history?.totalRuns).toBe(0);
    });
  });
});

describe("singleton functions", () => {
  it("should get and set cron service singleton", () => {
    expect(getCronService()).toBeNull();

    const mockService = {} as CronService;
    setCronService(mockService);

    expect(getCronService()).toBe(mockService);

    setCronService(null);
    expect(getCronService()).toBeNull();
  });
});
