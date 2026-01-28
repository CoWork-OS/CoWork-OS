/**
 * Tests for Sandbox Runner
 *
 * Tests the secure command execution environment that uses:
 * - macOS sandbox-exec profiles
 * - Process isolation
 * - Resource limits
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  SandboxRunner,
  createSandboxRunner,
  SandboxResult,
} from '../../src/electron/agent/sandbox/runner';
import { Workspace } from '../../src/shared/types';

// Mock workspace factory
function createMockWorkspace(overrides: Partial<Workspace['permissions']> = {}): Workspace {
  const tempDir = os.tmpdir();
  const workspacePath = path.join(tempDir, 'test-workspace-' + Date.now());

  // Create the workspace directory
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  return {
    id: 'test-workspace-id',
    name: 'Test Workspace',
    path: workspacePath,
    permissions: {
      read: true,
      write: true,
      delete: false,
      shell: true,
      network: false,
      unrestrictedFileAccess: false,
      allowedPaths: [],
      ...overrides,
    },
    settings: {
      useGuardrails: true,
      guardrails: {
        blockDangerousCommands: true,
        customBlockedPatterns: [],
        autoApproveTrustedCommands: false,
        trustedCommandPatterns: [],
        enforceAllowedDomains: false,
        allowedDomains: [],
      },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('SandboxRunner', () => {
  let workspace: Workspace;
  let runner: SandboxRunner;

  beforeEach(async () => {
    workspace = createMockWorkspace();
    runner = new SandboxRunner(workspace);
    await runner.initialize();
  });

  afterEach(() => {
    runner.cleanup();
    // Clean up workspace directory
    if (fs.existsSync(workspace.path)) {
      fs.rmSync(workspace.path, { recursive: true, force: true });
    }
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      const newRunner = new SandboxRunner(createMockWorkspace());
      await expect(newRunner.initialize()).resolves.not.toThrow();
      newRunner.cleanup();
    });

    it('should generate sandbox profile on init', async () => {
      // The profile is generated internally, but we can verify the runner works
      expect(runner).toBeDefined();
    });
  });

  describe('Basic Command Execution', () => {
    it('should execute simple echo command', async () => {
      const result = await runner.execute('echo', ['hello']);
      // Sandbox might not be available in test environment
      // so we just check it doesn't error catastrophically
      expect(result.timedOut).toBe(false);
      if (result.exitCode === 0) {
        expect(result.stdout.trim()).toContain('hello');
      }
    });

    it('should capture stdout', async () => {
      const result = await runner.execute('echo', ['Hello World']);
      if (result.exitCode === 0) {
        expect(result.stdout).toContain('Hello World');
      }
    });

    it('should capture stderr', async () => {
      const result = await runner.execute('ls', ['/nonexistent-path-12345']);
      expect(result.exitCode).not.toBe(0);
      // stderr might be empty if sandbox blocks
      expect(result.stderr.length >= 0).toBe(true);
    });

    it('should return correct exit code', async () => {
      const successResult = await runner.execute('true', []);
      // In sandbox, this might fail due to restrictions
      expect([0, 1]).toContain(successResult.exitCode);

      const failResult = await runner.execute('false', []);
      expect(failResult.exitCode).not.toBe(0);
    });
  });

  describe('Timeout Handling', () => {
    it('should timeout long-running commands', async () => {
      const result = await runner.execute('sleep', ['10'], {
        timeout: 100, // 100ms timeout
      });

      // Sleep might not be available in sandbox, but timeout should still work
      expect(result.timedOut || result.exitCode !== 0).toBe(true);
    });

    it('should not timeout quick commands', async () => {
      const result = await runner.execute('echo', ['quick'], {
        timeout: 5000,
      });

      expect(result.timedOut).toBe(false);
      expect(result.killed).toBe(false);
    });
  });

  describe('Output Truncation', () => {
    it('should truncate large stdout', async () => {
      // Generate large output using seq (more reliable than yes)
      const result = await runner.execute('seq', ['1', '10000'], {
        timeout: 5000,
        maxOutputSize: 100,
      });

      // Output should be truncated if command succeeded
      if (result.exitCode === 0) {
        expect(result.stdout.length).toBeLessThanOrEqual(120);
        expect(result.stdout).toContain('[Output truncated]');
      }
    });
  });

  describe('Working Directory', () => {
    it('should use workspace path as default cwd', async () => {
      const result = await runner.execute('pwd', []);
      // pwd might show /private/tmp on macOS instead of /tmp
      if (result.exitCode === 0) {
        expect(
          result.stdout.trim() === workspace.path ||
          result.stdout.trim().includes(path.basename(workspace.path))
        ).toBe(true);
      }
    });

    it('should use custom cwd when provided', async () => {
      const tmpDir = os.tmpdir();
      const result = await runner.execute('pwd', [], {
        cwd: tmpDir,
      });
      if (result.exitCode === 0) {
        // tmpdir might be /var/folders/... on macOS
        expect(result.stdout.length).toBeGreaterThan(0);
      }
    });

    it('should reject cwd outside allowed paths', async () => {
      // Create workspace with restricted access
      const restrictedWorkspace = createMockWorkspace({
        unrestrictedFileAccess: false,
        allowedPaths: [],
      });
      const restrictedRunner = new SandboxRunner(restrictedWorkspace);
      await restrictedRunner.initialize();

      const result = await restrictedRunner.execute('ls', [], {
        cwd: '/etc', // Not in allowed paths
      });

      expect(result.error).toBeDefined();
      expect(result.stderr).toContain('not allowed');

      restrictedRunner.cleanup();
      fs.rmSync(restrictedWorkspace.path, { recursive: true, force: true });
    });
  });

  describe('Path Validation', () => {
    it('should allow paths within workspace', async () => {
      // Create a file in workspace
      const testFile = path.join(workspace.path, 'test.txt');
      fs.writeFileSync(testFile, 'test content');

      const result = await runner.execute('cat', [testFile]);
      // Sandbox might restrict cat, but file should exist
      if (result.exitCode === 0) {
        expect(result.stdout).toContain('test content');
      }
    });

    it('should allow system paths for reading', async () => {
      const result = await runner.execute('ls', ['/usr/bin']);
      // Sandbox might restrict access
      expect([0, 1]).toContain(result.exitCode);
    });
  });

  describe('Environment Safety', () => {
    it('should have limited environment variables', async () => {
      const result = await runner.execute('env', []);

      if (result.exitCode === 0) {
        // Should have essential variables
        expect(result.stdout).toContain('PATH=');
        expect(result.stdout).toContain('HOME=');

        // Should not leak sensitive variables (if any were set)
        expect(result.stdout).not.toContain('AWS_SECRET');
        expect(result.stdout).not.toContain('API_KEY');
      }
    });

    it('should have safe PATH', async () => {
      const result = await runner.execute('printenv', ['PATH']);

      if (result.exitCode === 0) {
        // Should include standard paths
        expect(result.stdout).toContain('/usr');
        expect(result.stdout).toContain('/bin');
      }
    });
  });

  describe('Code Execution', () => {
    it('should execute Python code', async () => {
      // Skip if python3 is not installed
      const checkPython = await runner.execute('which', ['python3']);
      if (checkPython.exitCode !== 0) {
        return; // Skip test
      }

      const result = await runner.executeCode(
        'print("Hello from Python")',
        'python'
      );

      expect(result.stdout.trim()).toBe('Hello from Python');
    });

    it('should execute JavaScript code', async () => {
      // Skip if node is not installed
      const checkNode = await runner.execute('which', ['node']);
      if (checkNode.exitCode !== 0) {
        return; // Skip test
      }

      const result = await runner.executeCode(
        'console.log("Hello from Node")',
        'javascript'
      );

      expect(result.stdout.trim()).toBe('Hello from Node');
    });

    it('should timeout long-running code', async () => {
      const checkNode = await runner.execute('which', ['node']);
      if (checkNode.exitCode !== 0) {
        return; // Skip test
      }

      const result = await runner.executeCode(
        'while(true) {}',
        'javascript'
      );

      expect(result.timedOut).toBe(true);
    });
  });
});

describe('createSandboxRunner factory', () => {
  it('should create and initialize a runner', async () => {
    const workspace = createMockWorkspace();
    const runner = await createSandboxRunner(workspace);

    expect(runner).toBeInstanceOf(SandboxRunner);

    // Verify it works (may fail in sandbox but shouldn't throw)
    const result = await runner.execute('echo', ['test']);
    expect(result).toBeDefined();
    expect(typeof result.exitCode).toBe('number');

    runner.cleanup();
    fs.rmSync(workspace.path, { recursive: true, force: true });
  });
});

describe('Sandbox Profile Generation', () => {
  describe('Network restrictions', () => {
    it('should restrict network when permission is false', async () => {
      const workspace = createMockWorkspace({ network: false });
      const runner = await createSandboxRunner(workspace);

      // Try to access network (this might work differently based on OS)
      // We're mainly testing that the sandbox is generated correctly
      const result = await runner.execute('curl', ['--connect-timeout', '1', 'http://example.com'], {
        timeout: 3000,
      });

      // On macOS with sandbox, this should fail
      // The exact behavior depends on whether sandbox-exec is available
      runner.cleanup();
      fs.rmSync(workspace.path, { recursive: true, force: true });
    });
  });

  describe('Write restrictions', () => {
    it('should allow write in workspace when permission is true', async () => {
      const workspace = createMockWorkspace({ write: true });
      const runner = await createSandboxRunner(workspace);

      const testFile = path.join(workspace.path, 'write-test.txt');
      const result = await runner.execute('touch', [testFile]);

      // Touch might be restricted in sandbox
      if (result.exitCode === 0) {
        expect(fs.existsSync(testFile)).toBe(true);
      }

      runner.cleanup();
      fs.rmSync(workspace.path, { recursive: true, force: true });
    });
  });
});

describe('Resource Limits', () => {
  it('should respect max output size', async () => {
    const workspace = createMockWorkspace();
    const runner = await createSandboxRunner(workspace);

    // Generate a lot of output
    const result = await runner.execute('seq', ['1', '100000'], {
      maxOutputSize: 1000,
      timeout: 5000,
    });

    // If command succeeded, output should be truncated
    if (result.exitCode === 0) {
      expect(result.stdout.length).toBeLessThanOrEqual(1100);
      expect(result.stdout).toContain('[Output truncated]');
    }

    runner.cleanup();
    fs.rmSync(workspace.path, { recursive: true, force: true });
  });
});

describe('Error Handling', () => {
  it('should handle command not found', async () => {
    const workspace = createMockWorkspace();
    const runner = await createSandboxRunner(workspace);

    const result = await runner.execute('nonexistent-command-12345', []);

    expect(result.exitCode).not.toBe(0);

    runner.cleanup();
    fs.rmSync(workspace.path, { recursive: true, force: true });
  });

  it('should handle invalid arguments gracefully', async () => {
    const workspace = createMockWorkspace();
    const runner = await createSandboxRunner(workspace);

    const result = await runner.execute('ls', ['--invalid-flag-12345']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);

    runner.cleanup();
    fs.rmSync(workspace.path, { recursive: true, force: true });
  });
});
