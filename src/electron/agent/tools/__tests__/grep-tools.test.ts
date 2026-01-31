/**
 * Tests for GrepTools - regex content search
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Import after mocking
import { GrepTools } from '../grep-tools';
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

describe('GrepTools', () => {
  let grepTools: GrepTools;

  beforeEach(() => {
    vi.clearAllMocks();
    grepTools = new GrepTools(mockWorkspace, mockDaemon as any, 'test-task-id');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getToolDefinitions', () => {
    it('should return grep tool definition', () => {
      const tools = GrepTools.getToolDefinitions();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('grep');
      expect(tools[0].description).toContain('regex');
      expect(tools[0].input_schema.required).toContain('pattern');
    });

    it('should have correct input schema properties', () => {
      const tools = GrepTools.getToolDefinitions();
      const schema = tools[0].input_schema;

      expect(schema.properties).toHaveProperty('pattern');
      expect(schema.properties).toHaveProperty('path');
      expect(schema.properties).toHaveProperty('glob');
      expect(schema.properties).toHaveProperty('ignoreCase');
      expect(schema.properties).toHaveProperty('contextLines');
      expect(schema.properties).toHaveProperty('maxResults');
      expect(schema.properties).toHaveProperty('outputMode');
    });
  });

  describe('regex validation', () => {
    it('should reject invalid regex patterns', async () => {
      const result = await grepTools.grep({
        pattern: '[invalid(regex',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid regex');
    });

    it('should accept valid regex patterns', async () => {
      await grepTools.grep({ pattern: 'async\\s+function' });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'log', {
        message: expect.stringContaining('async\\s+function'),
      });
    });
  });

  describe('path validation', () => {
    it('should reject paths outside workspace', async () => {
      const result = await grepTools.grep({
        pattern: 'test',
        path: '../../../etc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('within workspace');
    });

    it('should return error for non-existent paths', async () => {
      const result = await grepTools.grep({
        pattern: 'test',
        path: 'nonexistent-path-that-does-not-exist',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });

  describe('parameter handling', () => {
    it('should accept ignoreCase parameter', async () => {
      await grepTools.grep({
        pattern: 'test',
        ignoreCase: true,
      });

      expect(mockDaemon.logEvent).toHaveBeenCalled();
    });

    it('should accept contextLines parameter', async () => {
      await grepTools.grep({
        pattern: 'test',
        contextLines: 3,
      });

      expect(mockDaemon.logEvent).toHaveBeenCalled();
    });

    it('should accept outputMode parameter', async () => {
      await grepTools.grep({
        pattern: 'test',
        outputMode: 'files_only',
      });

      expect(mockDaemon.logEvent).toHaveBeenCalled();
    });

    it('should accept glob filter parameter', async () => {
      await grepTools.grep({
        pattern: 'test',
        glob: '*.ts',
      });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'log', {
        message: expect.stringContaining('*.ts'),
      });
    });
  });

  describe('logging', () => {
    it('should log grep search event', async () => {
      await grepTools.grep({ pattern: 'test' });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'log', {
        message: expect.stringContaining('Grep search'),
      });
    });

    it('should log tool result', async () => {
      await grepTools.grep({ pattern: 'test' });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith(
        'test-task-id',
        'tool_result',
        expect.objectContaining({
          tool: 'grep',
        })
      );
    });
  });
});
