/**
 * Tests for CronService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CronJob, CronJobCreate, CronServiceDeps, CronStoreFile, CronEvent } from '../types';

// Job ID counter for tests that need unique IDs
let jobIdCounter = 0;
const getNextJobId = () => `job-${++jobIdCounter}`;

// Mock dependencies
vi.mock('uuid', () => ({
  v4: vi.fn(() => getNextJobId()),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Create mock store module
const mockStore: CronStoreFile = { version: 1, jobs: [] };
vi.mock('../store', () => ({
  loadCronStore: vi.fn().mockResolvedValue({ version: 1, jobs: [] }),
  saveCronStore: vi.fn().mockResolvedValue(undefined),
  resolveCronStorePath: vi.fn().mockImplementation((p) => p || '/mock/cron/jobs.json'),
}));

vi.mock('../webhook', () => ({
  CronWebhookServer: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getAddress: vi.fn().mockReturnValue(null),
    setTriggerHandler: vi.fn(),
    setJobLookup: vi.fn(),
  })),
}));

// Import after mocking
import { CronService, getCronService, setCronService } from '../service';
import { loadCronStore, saveCronStore } from '../store';

describe('CronService', () => {
  let service: CronService;
  let mockCreateTask: CronServiceDeps['createTask'];
  let mockOnEvent: CronServiceDeps['onEvent'];
  let events: CronEvent[];

  const createService = (overrides: Partial<CronServiceDeps> = {}): CronService => {
    mockCreateTask = vi.fn().mockResolvedValue({ id: 'task-123' }) as CronServiceDeps['createTask'];
    mockOnEvent = vi.fn((evt: CronEvent) => events.push(evt)) as CronServiceDeps['onEvent'];

    return new CronService({
      cronEnabled: true,
      storePath: '/test/cron/jobs.json',
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
  });

  describe('start/stop lifecycle', () => {
    it('should start service and load jobs', async () => {
      service = createService();
      await service.start();

      expect(loadCronStore).toHaveBeenCalled();
    });

    it('should not start if cronEnabled is false', async () => {
      service = createService({ cronEnabled: false });
      await service.start();

      // Store should not be loaded when disabled
      const status = await service.status();
      expect(status.enabled).toBe(false);
    });

    it('should stop cleanly', async () => {
      service = createService();
      await service.start();
      await service.stop();

      // Service should be stopped
      const status = await service.status();
      expect(status.jobCount).toBe(0);
    });
  });

  describe('status', () => {
    it('should return service status', async () => {
      service = createService();
      await service.start();

      const status = await service.status();

      expect(status.enabled).toBe(true);
      expect(status.storePath).toBe('/test/cron/jobs.json');
      expect(status.jobCount).toBe(0);
      expect(status.enabledJobCount).toBe(0);
      expect(status.runningJobCount).toBe(0);
    });
  });

  describe('add', () => {
    it('should add a new job', async () => {
      service = createService();
      await service.start();

      const input: CronJobCreate = {
        name: 'Test Job',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Run test task',
        schedule: { kind: 'every', everyMs: 60000 },
      };

      const result = await service.add(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job).toBeDefined();
        expect(result.job.name).toBe('Test Job');
        expect(result.job.id).toBe('job-1');
      }
      expect(saveCronStore).toHaveBeenCalled();
    });

    it('should emit added event', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Event Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: 'job-1',
          action: 'added',
        })
      );
    });

    it('should compute next run time for enabled jobs', async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      const result = await service.add({
        name: 'Scheduled Job',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.state.nextRunAtMs).toBe(1060000); // nowMs + everyMs
      }
    });

    it('should not compute next run time for disabled jobs', async () => {
      service = createService();
      await service.start();

      const result = await service.add({
        name: 'Disabled Job',
        enabled: false,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.state.nextRunAtMs).toBeUndefined();
      }
    });
  });

  describe('get', () => {
    it('should get a job by ID', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Get Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const job = await service.get('job-1');

      expect(job).toBeDefined();
      expect(job?.name).toBe('Get Test');
    });

    it('should return null for non-existent job', async () => {
      service = createService();
      await service.start();

      const job = await service.get('non-existent');

      expect(job).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all enabled jobs', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Enabled Job',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      await service.add({
        name: 'Disabled Job',
        enabled: false,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const jobs = await service.list();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('Enabled Job');
    });

    it('should list all jobs when includeDisabled is true', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Enabled Job',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      await service.add({
        name: 'Disabled Job',
        enabled: false,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const jobs = await service.list({ includeDisabled: true });

      expect(jobs).toHaveLength(2);
    });
  });

  describe('update', () => {
    it('should update a job', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Original Name',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const result = await service.update('job-1', {
        name: 'Updated Name',
        taskPrompt: 'Updated prompt',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.name).toBe('Updated Name');
        expect(result.job.taskPrompt).toBe('Updated prompt');
      }
    });

    it('should return error for non-existent job', async () => {
      service = createService();
      await service.start();

      const result = await service.update('non-existent', { name: 'New Name' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Job not found');
      }
    });

    it('should emit updated event', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Event Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      events = []; // Clear events from add

      await service.update('job-1', { name: 'Updated' });

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: 'job-1',
          action: 'updated',
        })
      );
    });

    it('should recompute next run time when schedule changes', async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      await service.add({
        name: 'Schedule Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const result = await service.update('job-1', {
        schedule: { kind: 'every', everyMs: 120000 },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.state.nextRunAtMs).toBe(1120000); // nowMs + new everyMs
      }
    });

    it('should clear next run time when job is disabled', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Disable Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const result = await service.update('job-1', { enabled: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.state.nextRunAtMs).toBeUndefined();
      }
    });
  });

  describe('remove', () => {
    it('should remove a job', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Remove Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const result = await service.remove('job-1');

      expect(result.ok).toBe(true);
      expect(result.removed).toBe(true);

      const job = await service.get('job-1');
      expect(job).toBeNull();
    });

    it('should return removed: false for non-existent job', async () => {
      service = createService();
      await service.start();

      const result = await service.remove('non-existent');

      expect(result.ok).toBe(true);
      expect(result.removed).toBe(false);
    });

    it('should emit removed event', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Event Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      events = [];

      await service.remove('job-1');

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: 'job-1',
          action: 'removed',
        })
      );
    });
  });

  describe('run', () => {
    it('should run a job and create a task', async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      await service.add({
        name: 'Run Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Run this task',
        schedule: { kind: 'at', atMs: 900000 }, // Past time
        state: { nextRunAtMs: 900000 },
      });

      const result = await service.run('job-1', 'force');

      expect(result.ok).toBe(true);
      if (result.ok && 'ran' in result && result.ran) {
        expect(result.taskId).toBe('task-123');
      }
      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Run this task',
          workspaceId: 'ws-1',
        })
      );
    });

    it('should return not-found for non-existent job', async () => {
      service = createService();
      await service.start();

      const result = await service.run('non-existent');

      expect(result.ok).toBe(true);
      if (result.ok && 'ran' in result && !result.ran) {
        expect(result.reason).toBe('not-found');
      }
    });

    it('should return disabled for disabled job in due mode', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Disabled Job',
        enabled: false,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const result = await service.run('job-1', 'due');

      expect(result.ok).toBe(true);
      if (result.ok && 'ran' in result && !result.ran) {
        expect(result.reason).toBe('disabled');
      }
    });

    it('should run disabled job in force mode', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Disabled Job',
        enabled: false,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const result = await service.run('job-1', 'force');

      expect(result.ok).toBe(true);
      if (result.ok && 'ran' in result) {
        expect(result.ran).toBe(true);
      }
    });

    it('should return not-due if job is not due yet', async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      await service.add({
        name: 'Future Job',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'at', atMs: 2000000 }, // Future time
      });

      const result = await service.run('job-1', 'due');

      expect(result.ok).toBe(true);
      if (result.ok && 'ran' in result && !result.ran) {
        expect(result.reason).toBe('not-due');
      }
    });

    it('should emit started and finished events', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Event Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      events = [];

      await service.run('job-1', 'force');

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: 'job-1',
          action: 'started',
        })
      );

      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: 'job-1',
          action: 'finished',
          status: 'ok',
          taskId: 'task-123',
        })
      );
    });

    it('should handle createTask errors', async () => {
      const errorCreateTask = vi.fn().mockRejectedValue(new Error('Task creation failed')) as CronServiceDeps['createTask'];
      service = createService({ createTask: errorCreateTask });
      await service.start();

      await service.add({
        name: 'Error Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      const result = await service.run('job-1', 'force');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Task creation failed');
      }
    });

    it('should delete one-shot job after run', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'One-shot Job',
        enabled: true,
        deleteAfterRun: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'at', atMs: 900000 },
      });

      await service.run('job-1', 'force');

      const job = await service.get('job-1');
      expect(job).toBeNull();
    });
  });

  describe('run history', () => {
    it('should track run history', async () => {
      service = createService({ nowMs: () => 1000000 });
      await service.start();

      await service.add({
        name: 'History Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      await service.run('job-1', 'force');

      const history = await service.getRunHistory('job-1');

      expect(history).toBeDefined();
      expect(history?.entries).toHaveLength(1);
      expect(history?.entries[0].status).toBe('ok');
      expect(history?.entries[0].taskId).toBe('task-123');
      expect(history?.totalRuns).toBe(1);
      expect(history?.successfulRuns).toBe(1);
      expect(history?.failedRuns).toBe(0);
    });

    it('should return null for non-existent job', async () => {
      service = createService();
      await service.start();

      const history = await service.getRunHistory('non-existent');

      expect(history).toBeNull();
    });

    it('should limit history entries', async () => {
      service = createService({ maxHistoryEntries: 2 });
      await service.start();

      await service.add({
        name: 'Limited History',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      // Run multiple times
      await service.run('job-1', 'force');
      await service.run('job-1', 'force');
      await service.run('job-1', 'force');

      const history = await service.getRunHistory('job-1');

      expect(history?.entries).toHaveLength(2);
      expect(history?.totalRuns).toBe(3);
    });

    it('should clear run history', async () => {
      service = createService();
      await service.start();

      await service.add({
        name: 'Clear History Test',
        enabled: true,
        workspaceId: 'ws-1',
        taskPrompt: 'Test',
        schedule: { kind: 'every', everyMs: 60000 },
      });

      await service.run('job-1', 'force');

      const cleared = await service.clearRunHistory('job-1');
      expect(cleared).toBe(true);

      const history = await service.getRunHistory('job-1');
      expect(history?.entries).toHaveLength(0);
      expect(history?.totalRuns).toBe(0);
    });
  });
});

describe('singleton functions', () => {
  it('should get and set cron service singleton', () => {
    expect(getCronService()).toBeNull();

    const mockService = {} as CronService;
    setCronService(mockService);

    expect(getCronService()).toBe(mockService);

    setCronService(null);
    expect(getCronService()).toBeNull();
  });
});
