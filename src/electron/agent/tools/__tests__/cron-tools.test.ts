import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { CronService, setCronService } from '../../../cron';
import { CronTools } from '../cron-tools';
import { TEMP_WORKSPACE_ID, type Workspace } from '../../../../shared/types';

describe('CronTools.schedule_create workspace behavior', () => {
  let tmpUserDataDir: string;
  let prevUserDataDirOverride: string | undefined;
  let service: CronService;

  const makeDaemonStub = () => {
    return {
      logEvent: vi.fn(),
      createWorkspace: vi.fn((name: string, p: string) => {
        const now = Date.now();
        const ws: Workspace = {
          id: uuidv4(),
          name,
          path: p,
          createdAt: now,
          lastUsedAt: now,
          permissions: { read: true, write: true, delete: false, network: true, shell: false },
        };
        return ws;
      }),
    } as any;
  };

  beforeEach(() => {
    prevUserDataDirOverride = process.env.COWORK_USER_DATA_DIR;
    tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-cron-tools-test-'));
    process.env.COWORK_USER_DATA_DIR = tmpUserDataDir;

    service = new CronService({
      cronEnabled: true,
      storePath: path.join(tmpUserDataDir, 'cron', 'jobs.json'),
      createTask: async () => ({ id: 'task-123' }),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => 1000,
    });
    setCronService(service);
  });

  afterEach(async () => {
    setCronService(null);
    await service.stop();

    // Best-effort cleanup
    try {
      fs.rmSync(tmpUserDataDir, { recursive: true, force: true });
    } catch {}

    if (prevUserDataDirOverride === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = prevUserDataDirOverride;
    }
  });

  it('auto-creates a dedicated workspace when scheduling from the global temp workspace', async () => {
    const daemon = makeDaemonStub();
    const tempWorkspace: Workspace = {
      id: TEMP_WORKSPACE_ID,
      name: 'Temporary Workspace',
      path: path.join(os.tmpdir(), 'cowork-os-temp'),
      createdAt: 0,
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: false,
        unrestrictedFileAccess: true,
      },
      isTemp: true,
    };

    const tools = new CronTools(tempWorkspace, daemon, 'task-1');
    const result = await tools.createJob({
      name: 'Daily Briefing',
      prompt: '/brief',
      schedule: { type: 'interval', every: '1h' },
    });

    expect(result.success).toBe(true);
    expect(result.job?.workspaceId).not.toBe(TEMP_WORKSPACE_ID);
    expect(daemon.createWorkspace).toHaveBeenCalledTimes(1);

    const createdWs = daemon.createWorkspace.mock.results[0].value as Workspace;
    expect(result.job?.workspaceId).toBe(createdWs.id);
    expect(createdWs.name).toBe('Scheduled: Daily Briefing');
    expect(fs.existsSync(createdWs.path)).toBe(true);
    expect(createdWs.path.startsWith(path.join(tmpUserDataDir, 'scheduled-workspaces') + path.sep)).toBe(true);
  });

  it('uses the existing workspace when scheduling from a normal workspace', async () => {
    const daemon = makeDaemonStub();
    const workspaceId = uuidv4();
    const normalWorkspace: Workspace = {
      id: workspaceId,
      name: 'My Workspace',
      path: '/tmp/my-workspace',
      createdAt: 0,
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    };

    const tools = new CronTools(normalWorkspace, daemon, 'task-2');
    const result = await tools.createJob({
      name: 'Ping',
      prompt: 'Say hello',
      schedule: { type: 'interval', every: '1h' },
    });

    expect(result.success).toBe(true);
    expect(result.job?.workspaceId).toBe(workspaceId);
    expect(daemon.createWorkspace).not.toHaveBeenCalled();
  });
});

