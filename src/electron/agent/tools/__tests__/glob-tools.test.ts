/**
 * Tests for GlobTools - pattern-based file search
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Import after mocking
import { GlobTools } from '../glob-tools';
import { Workspace } from '../../../../shared/types';

// Mock daemon
const mockDaemon = {
  logEvent: vi.fn(),
  registerArtifact: vi.fn(),
};

// Mock workspace
const mockWorkspace: Workspace = {
  id: 'test-workspace',
  name: 'Test Workspace',
  path: '/test/workspace',
  permissions: {
    fileRead: true,
    fileWrite: true,
    shell: false,
  },
  createdAt: new Date().toISOString(),
  lastAccessed: new Date().toISOString(),
};

describe('GlobTools', () => {
  let globTools: GlobTools;

  beforeEach(() => {
    vi.clearAllMocks();
    globTools = new GlobTools(mockWorkspace, mockDaemon as any, 'test-task-id');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getToolDefinitions', () => {
    it('should return glob tool definition', () => {
      const tools = GlobTools.getToolDefinitions();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('glob');
      expect(tools[0].description).toContain('pattern matching');
      expect(tools[0].input_schema.required).toContain('pattern');
    });

    it('should have correct input schema properties', () => {
      const tools = GlobTools.getToolDefinitions();
      const schema = tools[0].input_schema;

      expect(schema.properties).toHaveProperty('pattern');
      expect(schema.properties).toHaveProperty('path');
      expect(schema.properties).toHaveProperty('maxResults');
    });
  });

  describe('path validation', () => {
    it('should reject paths outside workspace', async () => {
      const result = await globTools.glob({
        pattern: '*.ts',
        path: '../../../etc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('within workspace');
    });

    it('should return error for non-existent paths', async () => {
      const result = await globTools.glob({
        pattern: '*.ts',
        path: 'nonexistent-path-that-does-not-exist',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });

  describe('pattern handling', () => {
    it('should accept pattern with brace expansion syntax', async () => {
      // Just test that the pattern is accepted and logged
      await globTools.glob({ pattern: '*.{ts,tsx}' });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'log', {
        message: expect.stringContaining('*.{ts,tsx}'),
      });
    });

    it('should accept double asterisk patterns', async () => {
      await globTools.glob({ pattern: '**/*.ts' });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'log', {
        message: expect.stringContaining('**/*.ts'),
      });
    });
  });

  describe('logging', () => {
    it('should log glob search event', async () => {
      await globTools.glob({ pattern: '*.ts' });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'log', {
        message: expect.stringContaining('Glob search'),
      });
    });

    it('should log tool result', async () => {
      await globTools.glob({ pattern: '*.ts' });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith(
        'test-task-id',
        'tool_result',
        expect.objectContaining({
          tool: 'glob',
        })
      );
    });
  });
});
