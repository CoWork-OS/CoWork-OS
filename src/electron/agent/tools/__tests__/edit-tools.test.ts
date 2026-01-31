/**
 * Tests for EditTools - surgical file editing
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Import after mocking
import { EditTools } from '../edit-tools';
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

describe('EditTools', () => {
  let editTools: EditTools;

  beforeEach(() => {
    vi.clearAllMocks();
    editTools = new EditTools(mockWorkspace, mockDaemon as any, 'test-task-id');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getToolDefinitions', () => {
    it('should return edit_file tool definition', () => {
      const tools = EditTools.getToolDefinitions();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('edit_file');
      expect(tools[0].description).toContain('surgical');
      expect(tools[0].input_schema.required).toContain('file_path');
      expect(tools[0].input_schema.required).toContain('old_string');
      expect(tools[0].input_schema.required).toContain('new_string');
    });

    it('should have correct input schema properties', () => {
      const tools = EditTools.getToolDefinitions();
      const schema = tools[0].input_schema;

      expect(schema.properties).toHaveProperty('file_path');
      expect(schema.properties).toHaveProperty('old_string');
      expect(schema.properties).toHaveProperty('new_string');
      expect(schema.properties).toHaveProperty('replace_all');
    });
  });

  describe('input validation', () => {
    it('should reject empty old_string', async () => {
      const result = await editTools.editFile({
        file_path: 'test.ts',
        old_string: '',
        new_string: 'new',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    it('should reject identical strings', async () => {
      const result = await editTools.editFile({
        file_path: 'test.ts',
        old_string: 'same',
        new_string: 'same',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('identical');
    });
  });

  describe('path validation', () => {
    it('should reject paths outside workspace', async () => {
      const result = await editTools.editFile({
        file_path: '../../../etc/passwd',
        old_string: 'old',
        new_string: 'new',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('within workspace');
    });

    it('should return error for non-existent files', async () => {
      const result = await editTools.editFile({
        file_path: 'nonexistent-file-that-does-not-exist.ts',
        old_string: 'old',
        new_string: 'new',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('logging', () => {
    it('should log edit event', async () => {
      await editTools.editFile({
        file_path: 'test.ts',
        old_string: 'old content',
        new_string: 'new content',
      });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'log', {
        message: expect.stringContaining('Editing file'),
      });
    });

    it('should log tool result on error', async () => {
      await editTools.editFile({
        file_path: 'test.ts',
        old_string: '',
        new_string: 'new content',
      });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith(
        'test-task-id',
        'tool_result',
        expect.objectContaining({
          tool: 'edit_file',
          error: expect.stringContaining('cannot be empty'),
        })
      );
    });
  });
});
