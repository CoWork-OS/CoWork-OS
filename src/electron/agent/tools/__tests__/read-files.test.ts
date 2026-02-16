import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Workspace } from '../../../../shared/types';
import { FileTools } from '../file-tools';
import { GlobTools } from '../glob-tools';
import { readFilesByPatterns } from '../read-files';

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

describe('readFilesByPatterns', () => {
  let tmpDir: string;
  let workspace: Workspace;
  let fileTools: FileTools;
  let globTools: GlobTools;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-read-files-'));
    workspace = {
      id: 'w1',
      name: 'Test',
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
      },
      isTemp: true,
    };

    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    } as any;

    fileTools = new FileTools(workspace, daemon, 'task-1');
    globTools = new GlobTools(workspace, daemon, 'task-1');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('reads matched files and returns their content', async () => {
    writeFile(path.join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFile(path.join(tmpDir, 'src', 'b.ts'), 'export const b = 2;\n');

    const res = await readFilesByPatterns(
      { patterns: ['src/**/*.ts'] },
      { globTools, fileTools }
    );

    expect(res.success).toBe(true);
    expect(res.totalMatched).toBe(2);
    expect(res.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(res.files[0].content).toContain('export const a');
    expect(res.files[1].content).toContain('export const b');
  });

  it('supports exclusion patterns with leading !', async () => {
    writeFile(path.join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFile(path.join(tmpDir, 'src', 'b.ts'), 'export const b = 2;\n');

    const res = await readFilesByPatterns(
      { patterns: ['src/**/*.ts', '!src/b.ts'] },
      { globTools, fileTools }
    );

    expect(res.success).toBe(true);
    expect(res.totalMatched).toBe(1);
    expect(res.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('truncates by maxFiles', async () => {
    writeFile(path.join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFile(path.join(tmpDir, 'src', 'b.ts'), 'export const b = 2;\n');

    const res = await readFilesByPatterns(
      { patterns: ['src/**/*.ts'], maxFiles: 1 },
      { globTools, fileTools }
    );

    expect(res.success).toBe(true);
    expect(res.files.length).toBe(1);
    expect(res.truncated).toBe(true);
  });

  it('truncates by maxTotalChars', async () => {
    const big = 'x'.repeat(1500);
    writeFile(path.join(tmpDir, 'src', 'big.txt'), big);
    writeFile(path.join(tmpDir, 'src', 'small.txt'), 'small\n');

    const res = await readFilesByPatterns(
      { patterns: ['src/*.txt'], maxTotalChars: 1000, maxFiles: 10 },
      { globTools, fileTools }
    );

    expect(res.success).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.files.length).toBeGreaterThan(0);
    expect(res.files[0].content.length).toBeLessThanOrEqual(1000);
  });

  it('remaps stale absolute paths that include the workspace folder name', async () => {
    const workspaceRoot = path.join(tmpDir, 'new-bitcoin2');
    const workspaceScoped: Workspace = {
      ...workspace,
      path: workspaceRoot,
      isTemp: false,
      permissions: {
        ...workspace.permissions,
        unrestrictedFileAccess: false,
      } as any,
    };
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    } as any;
    const scopedFileTools = new FileTools(workspaceScoped, daemon, 'task-2');

    const filename = 'research_step1_crypto_imperfections.md';
    const expectedContent = 'evidence in current workspace';
    writeFile(path.join(workspaceRoot, filename), expectedContent);

    const staleAbsolutePath = path.join(
      path.sep,
      'Users',
      'mesut',
      'Desktop',
      'new',
      'new-bitcoin2',
      filename
    );

    const out = await scopedFileTools.readFile(staleAbsolutePath);
    expect(out.content).toContain(expectedContent);
  });
});
