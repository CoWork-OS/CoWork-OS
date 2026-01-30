/**
 * Tests for cron store operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CronStoreFile, CronJob } from '../types';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Import after mocking
import {
  resolveCronStorePath,
  loadCronStore,
  loadCronStoreSync,
  saveCronStore,
  saveCronStoreSync,
} from '../store';

describe('resolveCronStorePath', () => {
  it('should return default path when no path provided', () => {
    const result = resolveCronStorePath();
    expect(result).toBe('/mock/user/data/cron/jobs.json');
  });

  it('should return default path for empty string', () => {
    const result = resolveCronStorePath('');
    expect(result).toBe('/mock/user/data/cron/jobs.json');
  });

  it('should return default path for whitespace only', () => {
    const result = resolveCronStorePath('   ');
    expect(result).toBe('/mock/user/data/cron/jobs.json');
  });

  it('should expand ~ to home directory', () => {
    const result = resolveCronStorePath('~/my-cron/jobs.json');
    expect(result).toBe(path.resolve(os.homedir(), 'my-cron/jobs.json'));
  });

  it('should resolve relative paths', () => {
    const result = resolveCronStorePath('./data/jobs.json');
    expect(result).toBe(path.resolve('./data/jobs.json'));
  });

  it('should return absolute paths as-is', () => {
    const result = resolveCronStorePath('/absolute/path/jobs.json');
    expect(result).toBe('/absolute/path/jobs.json');
  });
});

describe('loadCronStore', () => {
  const testDir = path.join(os.tmpdir(), 'cron-store-test-' + process.pid);
  const testStorePath = path.join(testDir, 'jobs.json');

  beforeEach(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should return empty store when file does not exist', async () => {
    const result = await loadCronStore('/non/existent/path.json');
    expect(result).toEqual({ version: 1, jobs: [] });
  });

  it('should return empty store for invalid JSON', async () => {
    await fs.promises.writeFile(testStorePath, 'not valid json');
    const result = await loadCronStore(testStorePath);
    expect(result).toEqual({ version: 1, jobs: [] });
  });

  it('should return empty store for null content', async () => {
    await fs.promises.writeFile(testStorePath, 'null');
    const result = await loadCronStore(testStorePath);
    expect(result).toEqual({ version: 1, jobs: [] });
  });

  it('should return empty store when jobs is not an array', async () => {
    await fs.promises.writeFile(testStorePath, JSON.stringify({ version: 1, jobs: 'not-array' }));
    const result = await loadCronStore(testStorePath);
    expect(result).toEqual({ version: 1, jobs: [] });
  });

  it('should load valid jobs', async () => {
    const validJob: CronJob = {
      id: 'job-1',
      name: 'Test Job',
      enabled: true,
      workspaceId: 'ws-1',
      taskPrompt: 'Do something',
      schedule: { kind: 'every', everyMs: 60000 },
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      state: {},
    };
    const store: CronStoreFile = { version: 1, jobs: [validJob] };
    await fs.promises.writeFile(testStorePath, JSON.stringify(store));

    const result = await loadCronStore(testStorePath);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe('job-1');
    expect(result.jobs[0].name).toBe('Test Job');
  });

  it('should filter out invalid jobs', async () => {
    const validJob: CronJob = {
      id: 'job-1',
      name: 'Valid Job',
      enabled: true,
      workspaceId: 'ws-1',
      taskPrompt: 'Do something',
      schedule: { kind: 'every', everyMs: 60000 },
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      state: {},
    };
    const invalidJobs = [
      null,
      'string-job',
      { id: 'missing-fields' },
      { id: 'job-2', name: 'Missing enabled' },
      { id: 'job-3', name: 'Test', enabled: 'not-boolean', workspaceId: 'ws', taskPrompt: 'p', schedule: {} },
    ];

    const store = { version: 1, jobs: [validJob, ...invalidJobs] };
    await fs.promises.writeFile(testStorePath, JSON.stringify(store));

    const result = await loadCronStore(testStorePath);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe('job-1');
  });
});

describe('loadCronStoreSync', () => {
  const testDir = path.join(os.tmpdir(), 'cron-store-sync-test-' + process.pid);
  const testStorePath = path.join(testDir, 'jobs.json');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should return empty store when file does not exist', () => {
    const result = loadCronStoreSync('/non/existent/path.json');
    expect(result).toEqual({ version: 1, jobs: [] });
  });

  it('should load valid jobs synchronously', () => {
    const validJob: CronJob = {
      id: 'sync-job',
      name: 'Sync Test',
      enabled: true,
      workspaceId: 'ws-sync',
      taskPrompt: 'Sync task',
      schedule: { kind: 'at', atMs: Date.now() + 3600000 },
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      state: {},
    };
    fs.writeFileSync(testStorePath, JSON.stringify({ version: 1, jobs: [validJob] }));

    const result = loadCronStoreSync(testStorePath);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe('sync-job');
  });
});

describe('saveCronStore', () => {
  const testDir = path.join(os.tmpdir(), 'cron-save-test-' + process.pid);
  const testStorePath = path.join(testDir, 'jobs.json');

  beforeEach(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should create directory if it does not exist', async () => {
    const nestedPath = path.join(testDir, 'nested', 'deep', 'jobs.json');
    const store: CronStoreFile = { version: 1, jobs: [] };

    await saveCronStore(nestedPath, store);

    const exists = fs.existsSync(nestedPath);
    expect(exists).toBe(true);
  });

  it('should save jobs to file', async () => {
    const job: CronJob = {
      id: 'save-job',
      name: 'Save Test',
      enabled: false,
      workspaceId: 'ws-save',
      taskPrompt: 'Save this',
      schedule: { kind: 'cron', expr: '0 * * * *' },
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      state: {},
    };
    const store: CronStoreFile = { version: 1, jobs: [job] };

    await saveCronStore(testStorePath, store);

    const raw = await fs.promises.readFile(testStorePath, 'utf-8');
    const loaded = JSON.parse(raw);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0].id).toBe('save-job');
  });

  it('should create backup file', async () => {
    const store: CronStoreFile = { version: 1, jobs: [] };

    await saveCronStore(testStorePath, store);

    const backupExists = fs.existsSync(`${testStorePath}.bak`);
    expect(backupExists).toBe(true);
  });

  it('should format JSON with indentation', async () => {
    const store: CronStoreFile = { version: 1, jobs: [] };

    await saveCronStore(testStorePath, store);

    const raw = await fs.promises.readFile(testStorePath, 'utf-8');
    expect(raw).toContain('\n'); // Formatted JSON has newlines
    expect(raw).toContain('  '); // 2-space indentation
  });

  it('should not leave temp files after successful save', async () => {
    const store: CronStoreFile = { version: 1, jobs: [] };

    await saveCronStore(testStorePath, store);

    const files = await fs.promises.readdir(testDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('saveCronStoreSync', () => {
  const testDir = path.join(os.tmpdir(), 'cron-save-sync-test-' + process.pid);
  const testStorePath = path.join(testDir, 'jobs.json');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should save jobs synchronously', () => {
    const job: CronJob = {
      id: 'sync-save',
      name: 'Sync Save Test',
      enabled: true,
      workspaceId: 'ws-sync-save',
      taskPrompt: 'Sync save',
      schedule: { kind: 'every', everyMs: 30000 },
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      state: {},
    };
    const store: CronStoreFile = { version: 1, jobs: [job] };

    saveCronStoreSync(testStorePath, store);

    const raw = fs.readFileSync(testStorePath, 'utf-8');
    const loaded = JSON.parse(raw);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0].id).toBe('sync-save');
  });

  it('should create backup synchronously', () => {
    const store: CronStoreFile = { version: 1, jobs: [] };

    saveCronStoreSync(testStorePath, store);

    expect(fs.existsSync(`${testStorePath}.bak`)).toBe(true);
  });
});
