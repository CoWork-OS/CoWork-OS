/**
 * Tests for SystemTools - specifically the run_applescript tool
 *
 * Tests the AppleScript execution functionality on macOS.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as childProcess from 'child_process';

// Mock electron modules
vi.mock('electron', () => ({
  clipboard: {
    readText: vi.fn(),
    readImage: vi.fn().mockReturnValue({ isEmpty: () => true }),
    availableFormats: vi.fn().mockReturnValue([]),
    writeText: vi.fn(),
  },
  desktopCapturer: {
    getSources: vi.fn(),
  },
  nativeImage: {},
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue('/mock/path'),
  },
}));

// Mock os module
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return {
    ...actual,
    platform: vi.fn().mockReturnValue('darwin'),
    homedir: vi.fn().mockReturnValue('/Users/testuser'),
    tmpdir: vi.fn().mockReturnValue('/tmp'),
    hostname: vi.fn().mockReturnValue('test-host'),
    cpus: vi.fn().mockReturnValue([{}, {}, {}, {}]),
    totalmem: vi.fn().mockReturnValue(16 * 1024 * 1024 * 1024),
    freemem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024),
    uptime: vi.fn().mockReturnValue(3600),
    release: vi.fn().mockReturnValue('23.0.0'),
    arch: vi.fn().mockReturnValue('arm64'),
    userInfo: vi.fn().mockReturnValue({ username: 'testuser' }),
  };
});

// Mock child_process
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof childProcess>('child_process');
  return {
    ...actual,
    exec: vi.fn(),
    execFile: vi.fn(),
  };
});

// Mock fs/promises
vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
}));

// Mock daemon
const mockDaemon = {
  logEvent: vi.fn(),
  registerArtifact: vi.fn(),
  requestApproval: vi.fn().mockResolvedValue(true),
};

// Mock workspace
const mockWorkspace = {
  id: 'test-workspace',
  name: 'Test Workspace',
  path: '/tmp/test-workspace',
  permissions: {
    shell: true,
    fileSystem: true,
    browser: true,
  },
};

// Import after mocks are set up
import { SystemTools } from '../../src/electron/agent/tools/system-tools';
import { AgentDaemon } from '../../src/electron/agent/daemon';
import { Workspace } from '../../src/shared/types';

describe('SystemTools - run_applescript', () => {
  let systemTools: SystemTools;
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup execFile mock with promisify support
    execFileMock = vi.fn();
    vi.mocked(childProcess.execFile).mockImplementation(execFileMock);

    // Create SystemTools instance
    systemTools = new SystemTools(
      mockWorkspace as unknown as Workspace,
      mockDaemon as unknown as AgentDaemon,
      'test-task-id'
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('successful execution', () => {
    it('should execute AppleScript and return output', async () => {
      const script = 'tell application "Finder" to get name of front window';
      const expectedOutput = 'Documents';

      // Mock successful execution
      execFileMock.mockImplementation((file: string, args: string[], opts: any, callback?: Function) => {
        expect(file).toBe('osascript');
        if (callback) {
          callback(null, { stdout: expectedOutput + '\n', stderr: '' });
        }
        return { stdout: expectedOutput + '\n', stderr: '' };
      });

      const result = await systemTools.runAppleScript(script);

      expect(result.success).toBe(true);
      expect(result.result).toBe(expectedOutput);
      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'tool_call', {
        tool: 'run_applescript',
        scriptLength: script.length,
      });
      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'tool_result', {
        tool: 'run_applescript',
        success: true,
        outputLength: expectedOutput.length,
      });
    });

    it('should handle empty output gracefully', async () => {
      const script = 'tell application "System Events" to click button "OK"';

      execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, callback?: Function) => {
        if (callback) {
          callback(null, { stdout: '', stderr: '' });
        }
        return { stdout: '', stderr: '' };
      });

      const result = await systemTools.runAppleScript(script);

      expect(result.success).toBe(true);
      expect(result.result).toBe('(no output)');
    });

    it('should use stderr as output when stdout is empty', async () => {
      const script = 'some script';
      const stderrOutput = 'Script completed';

      execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, callback?: Function) => {
        if (callback) {
          callback(null, { stdout: '', stderr: stderrOutput + '\n' });
        }
        return { stdout: '', stderr: stderrOutput + '\n' };
      });

      const result = await systemTools.runAppleScript(script);

      expect(result.success).toBe(true);
      expect(result.result).toBe(stderrOutput);
    });

    it('should properly escape script for shell execution', async () => {
      const script = 'tell application "Safari" to get URL of front document';

      execFileMock.mockImplementation((file: string, args: string[], _opts: any, callback?: Function) => {
        // Verify the execFile invocation contains proper args
        expect(file).toBe('osascript');
        expect(args).toEqual(['-e', script]);
        if (callback) {
          callback(null, { stdout: 'https://example.com\n', stderr: '' });
        }
        return { stdout: 'https://example.com\n', stderr: '' };
      });

      const result = await systemTools.runAppleScript(script);

      expect(result.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw error for empty script', async () => {
      await expect(systemTools.runAppleScript('')).rejects.toThrow(
        'Invalid script: must be a non-empty string'
      );
    });

    it('should throw error for null script', async () => {
      await expect(systemTools.runAppleScript(null as unknown as string)).rejects.toThrow(
        'Invalid script: must be a non-empty string'
      );
    });

    it('should throw error for non-string script', async () => {
      await expect(systemTools.runAppleScript(123 as unknown as string)).rejects.toThrow(
        'Invalid script: must be a non-empty string'
      );
    });

    it('should throw error on non-macOS platform', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');

      await expect(systemTools.runAppleScript('some script')).rejects.toThrow(
        'AppleScript is only available on macOS'
      );
    });

    it('should throw error on Windows platform', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');

      await expect(systemTools.runAppleScript('some script')).rejects.toThrow(
        'AppleScript is only available on macOS'
      );
    });

    it('should handle osascript execution errors', async () => {
      vi.mocked(os.platform).mockReturnValue('darwin');
      const script = 'invalid applescript syntax {{{';

      const errorMessage = 'syntax error: Expected expression but found unknown token.';
      execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, callback?: Function) => {
        const error = new Error('Command failed') as any;
        error.stderr = errorMessage;
        if (callback) {
          callback(error, null);
        }
        return undefined;
      });

      await expect(systemTools.runAppleScript(script)).rejects.toThrow(
        `AppleScript execution failed: ${errorMessage}`
      );

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'tool_error', {
        tool: 'run_applescript',
        error: expect.any(String),
      });
    });

    it('should handle timeout errors', async () => {
      vi.mocked(os.platform).mockReturnValue('darwin');
      const script = 'delay 60';

      execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, callback?: Function) => {
        const error = new Error('Command timed out') as any;
        error.killed = true;
        if (callback) {
          callback(error, null);
        }
        return undefined;
      });

      await expect(systemTools.runAppleScript(script)).rejects.toThrow(
        'AppleScript execution failed:'
      );
    });
  });

  describe('tool definition', () => {
    it('should include run_applescript in tool definitions', () => {
      const tools = SystemTools.getToolDefinitions();
      const appleScriptTool = tools.find((t) => t.name === 'run_applescript');

      expect(appleScriptTool).toBeDefined();
      expect(appleScriptTool!.description).toContain('AppleScript');
      expect(appleScriptTool!.description).toContain('macOS');
      expect(appleScriptTool!.input_schema.properties.script).toBeDefined();
      expect(appleScriptTool!.input_schema.required).toContain('script');
    });

    it('should have proper input schema for run_applescript', () => {
      const tools = SystemTools.getToolDefinitions();
      const appleScriptTool = tools.find((t) => t.name === 'run_applescript');

      expect(appleScriptTool!.input_schema).toEqual({
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: expect.stringContaining('AppleScript code'),
          },
        },
        required: ['script'],
      });
    });
  });

  describe('logging', () => {
    beforeEach(() => {
      vi.mocked(os.platform).mockReturnValue('darwin');
    });

    it('should log tool_call event with script length', async () => {
      const script = 'tell application "Finder" to activate';

      execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, callback?: Function) => {
        if (callback) {
          callback(null, { stdout: '', stderr: '' });
        }
        return { stdout: '', stderr: '' };
      });

      await systemTools.runAppleScript(script);

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'tool_call', {
        tool: 'run_applescript',
        scriptLength: script.length,
      });
    });

    it('should log tool_result event with output length on success', async () => {
      const script = 'return "hello"';
      const output = 'hello';

      execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, callback?: Function) => {
        if (callback) {
          callback(null, { stdout: output, stderr: '' });
        }
        return { stdout: output, stderr: '' };
      });

      await systemTools.runAppleScript(script);

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'tool_result', {
        tool: 'run_applescript',
        success: true,
        outputLength: output.length,
      });
    });

    it('should log tool_error event on failure', async () => {
      const script = 'invalid';

      execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, callback?: Function) => {
        const error = new Error('Execution failed');
        if (callback) {
          callback(error, null);
        }
        return undefined;
      });

      await expect(systemTools.runAppleScript(script)).rejects.toThrow();

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'tool_error', {
        tool: 'run_applescript',
        error: expect.any(String),
      });
    });
  });
});

describe('SystemTools - getToolDefinitions', () => {
  it('should return all expected system tools', () => {
    const tools = SystemTools.getToolDefinitions();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('system_info');
    expect(toolNames).toContain('read_clipboard');
    expect(toolNames).toContain('write_clipboard');
    expect(toolNames).toContain('take_screenshot');
    expect(toolNames).toContain('open_application');
    expect(toolNames).toContain('open_url');
    expect(toolNames).toContain('open_path');
    expect(toolNames).toContain('show_in_folder');
    expect(toolNames).toContain('get_env');
    expect(toolNames).toContain('get_app_paths');
    expect(toolNames).toContain('run_applescript');
    expect(toolNames).toContain('search_memories');
  });

  it('should include at least the stable core system tools', () => {
    const tools = SystemTools.getToolDefinitions();
    expect(tools.length).toBeGreaterThanOrEqual(12);
  });
});

describe('run_applescript category integration', () => {
  it('should be categorized as a system tool', async () => {
    // Import builtin settings to verify category mapping
    const { BuiltinToolsSettingsManager } = await import(
      '../../src/electron/agent/tools/builtin-settings'
    );
    const category = BuiltinToolsSettingsManager.getToolCategory('run_applescript');
    expect(category).toBe('system');
  });

  it('should be included in system tools list', async () => {
    const { BuiltinToolsSettingsManager } = await import(
      '../../src/electron/agent/tools/builtin-settings'
    );
    const toolsByCategory = BuiltinToolsSettingsManager.getToolsByCategory();
    expect(toolsByCategory.system).toContain('run_applescript');
  });
});
