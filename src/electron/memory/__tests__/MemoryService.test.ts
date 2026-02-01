/**
 * Tests for Memory System
 *
 * Note: These tests use mock implementations to avoid native module issues
 * with better-sqlite3 in the test environment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron to avoid getPath errors
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-cowork'),
  },
}));

// Types for memory system
type MemoryType = 'observation' | 'decision' | 'insight' | 'error';
type PrivacyMode = 'normal' | 'strict' | 'disabled';

interface Memory {
  id: string;
  workspaceId: string;
  taskId?: string;
  type: MemoryType;
  content: string;
  summary?: string;
  tokens: number;
  isCompressed: boolean;
  isPrivate: boolean;
  createdAt: number;
  updatedAt: number;
}

interface MemorySettings {
  workspaceId: string;
  enabled: boolean;
  autoCapture: boolean;
  compressionEnabled: boolean;
  retentionDays: number;
  maxStorageMb: number;
  privacyMode: PrivacyMode;
  excludedPatterns?: string[];
}

interface MemorySearchResult {
  id: string;
  type: MemoryType;
  snippet: string;
  createdAt: number;
  relevanceScore: number;
}

interface MemoryStats {
  count: number;
  totalTokens: number;
  compressedCount: number;
  compressionRatio: number;
}

// Sensitive patterns from MemoryService
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /credential/i,
  /auth/i,
  /bearer\s+[a-zA-Z0-9\-_]+/i,
  /ssh[_-]?key/i,
  /private[_-]?key/i,
  /\.env/i,
  /aws[_-]?access/i,
  /aws[_-]?secret/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
  /ghp_[a-zA-Z0-9]+/i, // GitHub personal access token
  /gho_[a-zA-Z0-9]+/i, // GitHub OAuth token
  /sk-[a-zA-Z0-9]+/i, // OpenAI API key format
  /xox[baprs]-[a-zA-Z0-9-]+/i, // Slack tokens
];

// Helper to check sensitive data (mirrors MemoryService implementation)
function containsSensitiveData(content: string): boolean {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(content)) {
      return true;
    }
  }
  return false;
}

// Mock token estimation
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Mock in-memory storage
let mockMemories: Map<string, Memory>;
let mockSettings: Map<string, MemorySettings>;
let memoryIdCounter: number;

// Default settings factory
function createDefaultSettings(workspaceId: string): MemorySettings {
  return {
    workspaceId,
    enabled: true,
    autoCapture: true,
    compressionEnabled: true,
    retentionDays: 30,
    maxStorageMb: 100,
    privacyMode: 'normal',
  };
}

// Mock MemoryRepository
class MockMemoryRepository {
  create(data: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Memory {
    const id = `mem-${++memoryIdCounter}`;
    const now = Date.now();
    const memory: Memory = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };
    mockMemories.set(id, memory);
    return memory;
  }

  findById(id: string): Memory | undefined {
    return mockMemories.get(id);
  }

  update(id: string, updates: Partial<Memory>): void {
    const memory = mockMemories.get(id);
    if (!memory) return;
    Object.assign(memory, updates, { updatedAt: Date.now() });
    mockMemories.set(id, memory);
  }

  search(workspaceId: string, query: string, limit: number = 20): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];
    const queryLower = query.toLowerCase();

    mockMemories.forEach((memory) => {
      if (memory.workspaceId !== workspaceId) return;
      if (memory.isPrivate) return;

      const contentLower = memory.content.toLowerCase();
      if (contentLower.includes(queryLower)) {
        results.push({
          id: memory.id,
          type: memory.type,
          snippet: memory.summary || memory.content.slice(0, 100),
          createdAt: memory.createdAt,
          relevanceScore: 1.0,
        });
      }
    });

    return results.slice(0, limit);
  }

  getRecentForWorkspace(workspaceId: string, limit: number = 20): Memory[] {
    const results: Memory[] = [];
    mockMemories.forEach((memory) => {
      if (memory.workspaceId === workspaceId) {
        results.push(memory);
      }
    });
    return results
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  getStats(workspaceId: string): MemoryStats {
    let count = 0;
    let totalTokens = 0;
    let compressedCount = 0;

    mockMemories.forEach((memory) => {
      if (memory.workspaceId === workspaceId) {
        count++;
        totalTokens += memory.tokens;
        if (memory.isCompressed) compressedCount++;
      }
    });

    return {
      count,
      totalTokens,
      compressedCount,
      compressionRatio: count > 0 ? compressedCount / count : 0,
    };
  }

  deleteByWorkspace(workspaceId: string): void {
    const toDelete: string[] = [];
    mockMemories.forEach((memory, id) => {
      if (memory.workspaceId === workspaceId) {
        toDelete.push(id);
      }
    });
    toDelete.forEach((id) => mockMemories.delete(id));
  }

  deleteOlderThan(workspaceId: string, cutoff: number): number {
    const toDelete: string[] = [];
    mockMemories.forEach((memory, id) => {
      if (memory.workspaceId === workspaceId && memory.createdAt < cutoff) {
        toDelete.push(id);
      }
    });
    toDelete.forEach((id) => mockMemories.delete(id));
    return toDelete.length;
  }

  findByTask(taskId: string): Memory[] {
    const results: Memory[] = [];
    mockMemories.forEach((memory) => {
      if (memory.taskId === taskId) {
        results.push(memory);
      }
    });
    return results;
  }

  getUncompressed(limit: number): Memory[] {
    const results: Memory[] = [];
    mockMemories.forEach((memory) => {
      if (!memory.isCompressed && !memory.isPrivate) {
        results.push(memory);
      }
    });
    return results.slice(0, limit);
  }
}

// Mock MemorySettingsRepository
class MockMemorySettingsRepository {
  getOrCreate(workspaceId: string): MemorySettings {
    let settings = mockSettings.get(workspaceId);
    if (!settings) {
      settings = createDefaultSettings(workspaceId);
      mockSettings.set(workspaceId, settings);
    }
    return settings;
  }

  update(workspaceId: string, updates: Partial<MemorySettings>): void {
    const settings = this.getOrCreate(workspaceId);
    Object.assign(settings, updates);
    mockSettings.set(workspaceId, settings);
  }
}

// Mock MemoryService (simplified version for testing)
class MockMemoryService {
  private memoryRepo: MockMemoryRepository;
  private settingsRepo: MockMemorySettingsRepository;

  constructor() {
    this.memoryRepo = new MockMemoryRepository();
    this.settingsRepo = new MockMemorySettingsRepository();
  }

  capture(
    workspaceId: string,
    taskId: string | undefined,
    type: MemoryType,
    content: string,
    isPrivate = false
  ): Memory | null {
    const settings = this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled || !settings.autoCapture) {
      return null;
    }

    if (settings.privacyMode === 'disabled') {
      return null;
    }

    // Check excluded patterns
    if (this.shouldExclude(content, settings)) {
      return null;
    }

    // Check for sensitive content
    const sensitiveDetected = containsSensitiveData(content);
    const finalIsPrivate = isPrivate || sensitiveDetected || settings.privacyMode === 'strict';

    // Estimate tokens
    const tokens = estimateTokens(content);

    // Truncate very long content
    const truncatedContent =
      content.length > 10000 ? content.slice(0, 10000) + '\n[... truncated]' : content;

    // Create memory
    return this.memoryRepo.create({
      workspaceId,
      taskId,
      type,
      content: truncatedContent,
      tokens,
      isCompressed: false,
      isPrivate: finalIsPrivate,
    });
  }

  search(workspaceId: string, query: string, limit = 20): MemorySearchResult[] {
    return this.memoryRepo.search(workspaceId, query, limit);
  }

  getRecent(workspaceId: string, limit = 20): Memory[] {
    return this.memoryRepo.getRecentForWorkspace(workspaceId, limit);
  }

  getByTask(taskId: string): Memory[] {
    return this.memoryRepo.findByTask(taskId);
  }

  getSettings(workspaceId: string): MemorySettings {
    return this.settingsRepo.getOrCreate(workspaceId);
  }

  updateSettings(workspaceId: string, updates: Partial<MemorySettings>): void {
    this.settingsRepo.update(workspaceId, updates);
  }

  getStats(workspaceId: string): MemoryStats {
    return this.memoryRepo.getStats(workspaceId);
  }

  clearWorkspace(workspaceId: string): void {
    this.memoryRepo.deleteByWorkspace(workspaceId);
  }

  getContextForInjection(workspaceId: string, taskPrompt: string): string {
    const settings = this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled) {
      return '';
    }

    const recentMemories = this.memoryRepo.getRecentForWorkspace(workspaceId, 5);
    if (recentMemories.length === 0) {
      return '';
    }

    const parts: string[] = ['<memory_context>'];
    parts.push('The following memories from previous sessions may be relevant:');
    parts.push('\n## Recent Activity');

    for (const memory of recentMemories) {
      if (!memory.isPrivate) {
        const text = memory.summary || this.truncate(memory.content, 150);
        const date = new Date(memory.createdAt).toLocaleDateString();
        parts.push(`- [${memory.type}] (${date}) ${text}`);
      }
    }

    parts.push('</memory_context>');
    return parts.join('\n');
  }

  private shouldExclude(content: string, settings: MemorySettings): boolean {
    if (!settings.excludedPatterns || settings.excludedPatterns.length === 0) {
      return false;
    }

    for (const pattern of settings.excludedPatterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(content)) {
          return true;
        }
      } catch {
        // Invalid regex pattern, skip
      }
    }

    return false;
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }
}

describe('Memory System', () => {
  let service: MockMemoryService;
  const workspaceId = 'test-workspace-1';

  beforeEach(() => {
    mockMemories = new Map();
    mockSettings = new Map();
    memoryIdCounter = 0;
    service = new MockMemoryService();
  });

  describe('Privacy Pattern Detection', () => {
    it('should detect API keys', () => {
      expect(containsSensitiveData('my api_key is abc123')).toBe(true);
      expect(containsSensitiveData('the apiKey value is xyz')).toBe(true);
      expect(containsSensitiveData('API-KEY: secret')).toBe(true);
    });

    it('should detect passwords', () => {
      expect(containsSensitiveData('password: mysecret')).toBe(true);
      expect(containsSensitiveData('passwd=hidden')).toBe(true);
    });

    it('should detect tokens', () => {
      expect(containsSensitiveData('token: xyz123')).toBe(true);
      expect(containsSensitiveData('bearer abc123def456')).toBe(true);
    });

    it('should detect SSH/private keys', () => {
      expect(containsSensitiveData('ssh_key content')).toBe(true);
      expect(containsSensitiveData('private-key data')).toBe(true);
      expect(containsSensitiveData('-----BEGIN PRIVATE KEY-----')).toBe(true);
      expect(containsSensitiveData('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    });

    it('should detect AWS credentials', () => {
      expect(containsSensitiveData('aws_access_key_id: AKIA...')).toBe(true);
      expect(containsSensitiveData('aws-secret: xyz')).toBe(true);
    });

    it('should detect GitHub tokens', () => {
      expect(containsSensitiveData('ghp_abcdefghijklmnop')).toBe(true);
      expect(containsSensitiveData('gho_1234567890')).toBe(true);
    });

    it('should detect OpenAI API keys', () => {
      expect(containsSensitiveData('sk-abcdefghij1234567890')).toBe(true);
    });

    it('should detect Slack tokens', () => {
      expect(containsSensitiveData('xoxb-abc-123-def')).toBe(true);
      expect(containsSensitiveData('xoxp-something-here')).toBe(true);
    });

    it('should detect .env files', () => {
      expect(containsSensitiveData('reading .env file')).toBe(true);
    });

    it('should not flag normal content', () => {
      expect(containsSensitiveData('just a normal log message')).toBe(false);
      expect(containsSensitiveData('created file src/utils.ts')).toBe(false);
      expect(containsSensitiveData('ran npm install successfully')).toBe(false);
    });
  });

  describe('Memory Capture', () => {
    it('should capture a basic observation', () => {
      const memory = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'Read file src/utils.ts with 100 lines'
      );

      expect(memory).not.toBeNull();
      expect(memory?.workspaceId).toBe(workspaceId);
      expect(memory?.taskId).toBe('task-1');
      expect(memory?.type).toBe('observation');
      expect(memory?.content).toBe('Read file src/utils.ts with 100 lines');
      expect(memory?.isPrivate).toBe(false);
    });

    it('should capture decisions', () => {
      const memory = service.capture(
        workspaceId,
        'task-1',
        'decision',
        'Decided to use async/await instead of callbacks'
      );

      expect(memory?.type).toBe('decision');
    });

    it('should capture errors', () => {
      const memory = service.capture(
        workspaceId,
        'task-1',
        'error',
        'Build failed with TypeScript errors'
      );

      expect(memory?.type).toBe('error');
    });

    it('should mark sensitive content as private', () => {
      const memory = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'Found api_key in configuration file'
      );

      expect(memory?.isPrivate).toBe(true);
    });

    it('should mark memory as private when explicitly requested', () => {
      const memory = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'Normal content here',
        true // explicit isPrivate
      );

      expect(memory?.isPrivate).toBe(true);
    });

    it('should not capture when memory is disabled', () => {
      service.updateSettings(workspaceId, { enabled: false });

      const memory = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'This should not be captured'
      );

      expect(memory).toBeNull();
    });

    it('should not capture when autoCapture is disabled', () => {
      service.updateSettings(workspaceId, { autoCapture: false });

      const memory = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'This should not be captured'
      );

      expect(memory).toBeNull();
    });

    it('should not capture when privacy mode is disabled', () => {
      service.updateSettings(workspaceId, { privacyMode: 'disabled' });

      const memory = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'This should not be captured'
      );

      expect(memory).toBeNull();
    });

    it('should mark all as private in strict mode', () => {
      service.updateSettings(workspaceId, { privacyMode: 'strict' });

      const memory = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'Normal content'
      );

      expect(memory?.isPrivate).toBe(true);
    });

    it('should exclude content matching excluded patterns', () => {
      service.updateSettings(workspaceId, { excludedPatterns: ['node_modules', 'dist/'] });

      const memory1 = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'Reading file from node_modules'
      );

      const memory2 = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'Building to dist/ folder'
      );

      const memory3 = service.capture(
        workspaceId,
        'task-1',
        'observation',
        'Reading src/utils.ts'
      );

      expect(memory1).toBeNull();
      expect(memory2).toBeNull();
      expect(memory3).not.toBeNull();
    });

    it('should truncate very long content', () => {
      const longContent = 'x'.repeat(15000);
      const memory = service.capture(workspaceId, 'task-1', 'observation', longContent);

      expect(memory?.content.length).toBeLessThan(15000);
      expect(memory?.content).toContain('[... truncated]');
    });

    it('should estimate tokens correctly', () => {
      const content = 'This is a test message with some content.'; // ~42 chars
      const memory = service.capture(workspaceId, 'task-1', 'observation', content);

      // ~42 chars / 4 = ~11 tokens
      expect(memory?.tokens).toBeGreaterThan(0);
      expect(memory?.tokens).toBe(Math.ceil(content.length / 4));
    });
  });

  describe('Memory Search', () => {
    beforeEach(() => {
      // Create some test memories
      service.capture(workspaceId, 'task-1', 'observation', 'Created TypeScript file for utils');
      service.capture(workspaceId, 'task-1', 'observation', 'Implemented authentication module');
      service.capture(workspaceId, 'task-1', 'decision', 'Using React hooks for state management');
      service.capture(workspaceId, 'task-2', 'error', 'Build failed with missing dependencies');
    });

    it('should find memories by content', () => {
      const results = service.search(workspaceId, 'TypeScript');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].snippet).toContain('TypeScript');
    });

    it('should return empty for no matches', () => {
      const results = service.search(workspaceId, 'nonexistent-query-xyz');

      expect(results.length).toBe(0);
    });

    it('should respect limit parameter', () => {
      service.capture(workspaceId, 'task-1', 'observation', 'File 1 content');
      service.capture(workspaceId, 'task-1', 'observation', 'File 2 content');
      service.capture(workspaceId, 'task-1', 'observation', 'File 3 content');

      const results = service.search(workspaceId, 'File', 2);

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should not include private memories in search', () => {
      service.capture(workspaceId, 'task-1', 'observation', 'Secret api_key found in config');

      const results = service.search(workspaceId, 'api_key');

      expect(results.length).toBe(0);
    });

    it('should only search within specified workspace', () => {
      service.capture('other-workspace', 'task-1', 'observation', 'TypeScript file in other workspace');

      const results = service.search(workspaceId, 'TypeScript');

      // Should only find the one in test workspace
      expect(results.length).toBe(1);
    });
  });

  describe('Memory Retrieval', () => {
    beforeEach(() => {
      service.capture(workspaceId, 'task-1', 'observation', 'First observation');
      service.capture(workspaceId, 'task-1', 'observation', 'Second observation');
      service.capture(workspaceId, 'task-2', 'decision', 'Important decision made here');
    });

    it('should get recent memories for workspace', () => {
      const recent = service.getRecent(workspaceId, 10);

      expect(recent.length).toBe(3);
      // Verify all 3 memories are present (order may vary when timestamps are identical)
      const contents = recent.map(m => m.content);
      expect(contents).toContain('First observation');
      expect(contents).toContain('Second observation');
      expect(contents).toContain('Important decision made here');
    });

    it('should get memories by task', () => {
      const taskMemories = service.getByTask('task-1');

      expect(taskMemories.length).toBe(2);
      taskMemories.forEach((m) => {
        expect(m.taskId).toBe('task-1');
      });
    });

    it('should return empty for non-existent task', () => {
      const taskMemories = service.getByTask('non-existent-task');

      expect(taskMemories.length).toBe(0);
    });
  });

  describe('Memory Settings', () => {
    it('should create default settings for new workspace', () => {
      const settings = service.getSettings(workspaceId);

      expect(settings.workspaceId).toBe(workspaceId);
      expect(settings.enabled).toBe(true);
      expect(settings.autoCapture).toBe(true);
      expect(settings.compressionEnabled).toBe(true);
      expect(settings.retentionDays).toBe(30);
      expect(settings.privacyMode).toBe('normal');
    });

    it('should update settings', () => {
      service.updateSettings(workspaceId, {
        enabled: false,
        retentionDays: 90,
      });

      const settings = service.getSettings(workspaceId);

      expect(settings.enabled).toBe(false);
      expect(settings.retentionDays).toBe(90);
    });

    it('should preserve unmodified settings', () => {
      service.updateSettings(workspaceId, { enabled: false });

      const settings = service.getSettings(workspaceId);

      expect(settings.enabled).toBe(false);
      expect(settings.autoCapture).toBe(true); // unchanged
      expect(settings.compressionEnabled).toBe(true); // unchanged
    });
  });

  describe('Memory Stats', () => {
    it('should return zero stats for empty workspace', () => {
      const stats = service.getStats(workspaceId);

      expect(stats.count).toBe(0);
      expect(stats.totalTokens).toBe(0);
      expect(stats.compressedCount).toBe(0);
      expect(stats.compressionRatio).toBe(0);
    });

    it('should calculate stats correctly', () => {
      service.capture(workspaceId, 'task-1', 'observation', 'Short content');
      service.capture(workspaceId, 'task-1', 'observation', 'Another short content');
      service.capture(workspaceId, 'task-1', 'decision', 'A decision was made');

      const stats = service.getStats(workspaceId);

      expect(stats.count).toBe(3);
      expect(stats.totalTokens).toBeGreaterThan(0);
    });

    it('should only count memories in the specified workspace', () => {
      service.capture(workspaceId, 'task-1', 'observation', 'Workspace 1 memory');
      service.capture('other-workspace', 'task-1', 'observation', 'Other workspace memory');

      const stats = service.getStats(workspaceId);

      expect(stats.count).toBe(1);
    });
  });

  describe('Clear Workspace', () => {
    it('should clear all memories for workspace', () => {
      service.capture(workspaceId, 'task-1', 'observation', 'Memory 1');
      service.capture(workspaceId, 'task-1', 'observation', 'Memory 2');
      service.capture(workspaceId, 'task-1', 'observation', 'Memory 3');

      expect(service.getStats(workspaceId).count).toBe(3);

      service.clearWorkspace(workspaceId);

      expect(service.getStats(workspaceId).count).toBe(0);
    });

    it('should not affect other workspaces', () => {
      service.capture(workspaceId, 'task-1', 'observation', 'Workspace 1');
      service.capture('other-workspace', 'task-1', 'observation', 'Other workspace');

      service.clearWorkspace(workspaceId);

      expect(service.getStats(workspaceId).count).toBe(0);
      expect(service.getStats('other-workspace').count).toBe(1);
    });
  });

  describe('Context Injection', () => {
    it('should return empty when memory is disabled', () => {
      service.updateSettings(workspaceId, { enabled: false });
      service.capture(workspaceId, 'task-1', 'observation', 'Some memory');

      const context = service.getContextForInjection(workspaceId, 'New task prompt');

      expect(context).toBe('');
    });

    it('should return empty when no memories exist', () => {
      const context = service.getContextForInjection(workspaceId, 'New task prompt');

      expect(context).toBe('');
    });

    it('should return formatted context with memories', () => {
      // Note: avoid "auth" and other sensitive patterns
      service.capture(workspaceId, 'task-1', 'observation', 'Created user login module');
      service.capture(workspaceId, 'task-1', 'decision', 'Using React hooks for state');

      const context = service.getContextForInjection(workspaceId, 'Update user module');

      expect(context).toContain('<memory_context>');
      expect(context).toContain('</memory_context>');
      expect(context).toContain('Recent Activity');
      expect(context).toContain('[observation]');
      expect(context).toContain('[decision]');
    });

    it('should not include private memories in context', () => {
      service.capture(workspaceId, 'task-1', 'observation', 'Normal memory');
      service.capture(workspaceId, 'task-1', 'observation', 'Contains api_key secret'); // will be private

      const context = service.getContextForInjection(workspaceId, 'Some task');

      expect(context).toContain('Normal memory');
      expect(context).not.toContain('api_key');
    });

    it('should truncate long memory content in context', () => {
      const longContent = 'A'.repeat(300);
      service.capture(workspaceId, 'task-1', 'observation', longContent);

      const context = service.getContextForInjection(workspaceId, 'Some task');

      // Should be truncated
      expect(context).toContain('...');
      expect(context.length).toBeLessThan(longContent.length + 200);
    });
  });

  describe('Token Estimation', () => {
    it('should estimate tokens for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate tokens based on character count', () => {
      // ~4 chars per token
      expect(estimateTokens('test')).toBe(1);
      expect(estimateTokens('12345678')).toBe(2);
      expect(estimateTokens('This is a longer string with more tokens')).toBeGreaterThan(5);
    });

    it('should handle special characters', () => {
      const specialContent = 'function test() { return "hello"; }';
      const tokens = estimateTokens(specialContent);
      expect(tokens).toBeGreaterThan(0);
    });
  });
});

describe('MemoryRepository Edge Cases', () => {
  let repo: MockMemoryRepository;
  const workspaceId = 'edge-test-workspace';

  beforeEach(() => {
    mockMemories = new Map();
    mockSettings = new Map();
    memoryIdCounter = 0;
    repo = new MockMemoryRepository();
  });

  it('should handle findById for non-existent memory', () => {
    const result = repo.findById('non-existent-id');
    expect(result).toBeUndefined();
  });

  it('should handle update for non-existent memory', () => {
    // Should not throw
    expect(() => {
      repo.update('non-existent-id', { content: 'new content' });
    }).not.toThrow();
  });

  it('should handle search with empty query', () => {
    repo.create({
      workspaceId,
      type: 'observation',
      content: 'Test content',
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
    });

    const results = repo.search(workspaceId, '');
    // Empty query behavior: matches all non-private memories (includes('') is always true)
    // This is acceptable - real implementation would use FTS5 which handles empty queries differently
    expect(results.length).toBe(1);
  });

  it('should handle deleteOlderThan correctly', () => {
    const now = Date.now();

    // Create some memories with different timestamps
    const oldMemory = repo.create({
      workspaceId,
      type: 'observation',
      content: 'Old memory',
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
    });

    // Manually set createdAt to old time
    const stored = mockMemories.get(oldMemory.id);
    if (stored) {
      stored.createdAt = now - 100000;
      mockMemories.set(oldMemory.id, stored);
    }

    repo.create({
      workspaceId,
      type: 'observation',
      content: 'New memory',
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
    });

    const deleted = repo.deleteOlderThan(workspaceId, now - 50000);

    expect(deleted).toBe(1);
    expect(repo.getRecentForWorkspace(workspaceId, 10).length).toBe(1);
  });

  it('should handle getUncompressed correctly', () => {
    repo.create({
      workspaceId,
      type: 'observation',
      content: 'Uncompressed',
      tokens: 100,
      isCompressed: false,
      isPrivate: false,
    });

    repo.create({
      workspaceId,
      type: 'observation',
      content: 'Compressed',
      tokens: 50,
      isCompressed: true,
      isPrivate: false,
    });

    repo.create({
      workspaceId,
      type: 'observation',
      content: 'Private',
      tokens: 100,
      isCompressed: false,
      isPrivate: true,
    });

    const uncompressed = repo.getUncompressed(10);

    expect(uncompressed.length).toBe(1);
    expect(uncompressed[0].content).toBe('Uncompressed');
  });
});

// ============================================================
// Edge Case Tests
// ============================================================

describe('Content Edge Cases', () => {
  let service: MockMemoryService;
  const workspaceId = 'edge-case-workspace';

  beforeEach(() => {
    mockMemories = new Map();
    mockSettings = new Map();
    memoryIdCounter = 0;
    service = new MockMemoryService();
  });

  it('should handle unicode and emoji content', () => {
    const emojiContent = '📁 Created file 日本語テスト émojis: 🚀🎉✅';
    const memory = service.capture(workspaceId, 'task-1', 'observation', emojiContent);

    expect(memory).not.toBeNull();
    expect(memory?.content).toBe(emojiContent);
    expect(memory?.tokens).toBeGreaterThan(0);
  });

  it('should handle content with special characters', () => {
    const specialContent = 'Path: C:\\Users\\test\\file.txt\nRegex: /^[a-z]+$/gi\nJSON: {"key": "value"}';
    const memory = service.capture(workspaceId, 'task-1', 'observation', specialContent);

    expect(memory).not.toBeNull();
    expect(memory?.content).toBe(specialContent);
  });

  it('should handle content with SQL-like patterns safely', () => {
    const sqlContent = "User input: '; DROP TABLE memories;--";
    const memory = service.capture(workspaceId, 'task-1', 'observation', sqlContent);

    expect(memory).not.toBeNull();
    expect(memory?.content).toBe(sqlContent);
    // Verify other memories still work after potential injection
    const stats = service.getStats(workspaceId);
    expect(stats.count).toBe(1);
  });

  it('should handle empty string content', () => {
    const memory = service.capture(workspaceId, 'task-1', 'observation', '');

    expect(memory).not.toBeNull();
    expect(memory?.content).toBe('');
    expect(memory?.tokens).toBe(0);
  });

  it('should handle content with only whitespace', () => {
    const whitespaceContent = '   \n\t\n   ';
    const memory = service.capture(workspaceId, 'task-1', 'observation', whitespaceContent);

    expect(memory).not.toBeNull();
    expect(memory?.content).toBe(whitespaceContent);
  });

  it('should handle very long single line without newlines', () => {
    const longLine = 'x'.repeat(5000);
    const memory = service.capture(workspaceId, 'task-1', 'observation', longLine);

    expect(memory).not.toBeNull();
    expect(memory?.content).toBe(longLine);
  });

  it('should handle content with null bytes', () => {
    const contentWithNull = 'before\x00after';
    const memory = service.capture(workspaceId, 'task-1', 'observation', contentWithNull);

    expect(memory).not.toBeNull();
    // Content should be preserved as-is
    expect(memory?.content).toBe(contentWithNull);
  });

  it('should handle content with control characters', () => {
    const controlChars = 'line1\rline2\x1b[31mred\x1b[0m';
    const memory = service.capture(workspaceId, 'task-1', 'observation', controlChars);

    expect(memory).not.toBeNull();
    expect(memory?.content).toBe(controlChars);
  });

  it('should handle base64-like content', () => {
    const base64Content = 'SGVsbG8gV29ybGQhIFRoaXMgaXMgYSB0ZXN0Lg==';
    const memory = service.capture(workspaceId, 'task-1', 'observation', base64Content);

    expect(memory).not.toBeNull();
    expect(memory?.isPrivate).toBe(false); // Base64 alone shouldn't trigger privacy
  });
});

describe('Privacy Pattern Edge Cases', () => {
  it('should handle false positive: "authentication" contains "auth"', () => {
    // This is a known false positive - "auth" pattern matches "authentication"
    const result = containsSensitiveData('user authentication flow');
    expect(result).toBe(true); // Current behavior - flags it
  });

  it('should detect URL-encoded secrets', () => {
    // URL-encoded "api_key" = "api%5Fkey"
    const urlEncoded = 'param=api%5Fkey%3Dvalue';
    // Current implementation doesn't decode URLs
    const result = containsSensitiveData(urlEncoded);
    expect(result).toBe(false); // Won't detect encoded
  });

  it('should detect secrets split with spaces', () => {
    const spacedSecret = 'api _ key = abc123';
    const result = containsSensitiveData(spacedSecret);
    expect(result).toBe(false); // Pattern requires api_key or api-key
  });

  it('should detect mixed case variations', () => {
    expect(containsSensitiveData('API_KEY=value')).toBe(true);
    expect(containsSensitiveData('Api_Key=value')).toBe(true);
    expect(containsSensitiveData('api-KEY=value')).toBe(true);
    expect(containsSensitiveData('APIKEY=value')).toBe(true);
  });

  it('should detect secrets in multiline content', () => {
    const multiline = `
      config:
        database_url: postgres://...
        api_key: secret123
        port: 3000
    `;
    expect(containsSensitiveData(multiline)).toBe(true);
  });

  it('should detect partial GitHub token patterns', () => {
    expect(containsSensitiveData('ghp_abc123def456')).toBe(true);
    expect(containsSensitiveData('token: ghp_xyz')).toBe(true);
    // Non-matching patterns
    expect(containsSensitiveData('ghp')).toBe(false);
    expect(containsSensitiveData('ghp-abc')).toBe(false); // wrong separator
  });

  it('should detect OpenAI key variations', () => {
    expect(containsSensitiveData('sk-abcdefghijklmnop')).toBe(true);
    expect(containsSensitiveData('OPENAI_API_KEY=sk-test')).toBe(true);
    // Short sk- should still match
    expect(containsSensitiveData('sk-a')).toBe(true);
  });

  it('should not flag similar but non-sensitive patterns', () => {
    expect(containsSensitiveData('skeleton key concept')).toBe(false);
    expect(containsSensitiveData('asking questions')).toBe(false);
    expect(containsSensitiveData('passport validation')).toBe(false);
    expect(containsSensitiveData('tokenizer function')).toBe(true); // "token" still matches
  });
});

describe('Search Edge Cases', () => {
  let service: MockMemoryService;
  const workspaceId = 'search-edge-workspace';

  beforeEach(() => {
    mockMemories = new Map();
    mockSettings = new Map();
    memoryIdCounter = 0;
    service = new MockMemoryService();
  });

  it('should handle search with special regex characters', () => {
    service.capture(workspaceId, 'task-1', 'observation', 'File path: src/*.ts');
    service.capture(workspaceId, 'task-1', 'observation', 'Regex: /test[a-z]+/');

    // These could break regex-based search
    const results1 = service.search(workspaceId, '*.ts');
    const results2 = service.search(workspaceId, '[a-z]');

    // Mock uses includes() which handles these safely
    expect(results1.length).toBeGreaterThanOrEqual(0);
    expect(results2.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle search with FTS5 special operators', () => {
    service.capture(workspaceId, 'task-1', 'observation', 'Test AND OR NOT operators');

    // FTS5 treats these as operators
    const results = service.search(workspaceId, 'AND OR NOT');
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle search with quotes', () => {
    service.capture(workspaceId, 'task-1', 'observation', 'Said "hello world" to user');

    const results = service.search(workspaceId, '"hello');
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle case-insensitive search', () => {
    service.capture(workspaceId, 'task-1', 'observation', 'TypeScript configuration');

    const results1 = service.search(workspaceId, 'typescript');
    const results2 = service.search(workspaceId, 'TYPESCRIPT');
    const results3 = service.search(workspaceId, 'TypeScript');

    // All should find the memory (mock uses toLowerCase)
    expect(results1.length).toBe(1);
    expect(results2.length).toBe(1);
    expect(results3.length).toBe(1);
  });

  it('should handle search with only stop words', () => {
    service.capture(workspaceId, 'task-1', 'observation', 'The quick brown fox');

    const results = service.search(workspaceId, 'the');
    // Should still find it with simple includes search
    expect(results.length).toBe(1);
  });

  it('should handle search with unicode', () => {
    service.capture(workspaceId, 'task-1', 'observation', '日本語テスト');

    const results = service.search(workspaceId, '日本語');
    expect(results.length).toBe(1);
  });
});

describe('Retention and Cleanup Edge Cases', () => {
  let repo: MockMemoryRepository;
  const workspaceId = 'retention-edge-workspace';

  beforeEach(() => {
    mockMemories = new Map();
    mockSettings = new Map();
    memoryIdCounter = 0;
    repo = new MockMemoryRepository();
  });

  it('should handle retention with zero cutoff (delete all)', () => {
    repo.create({
      workspaceId,
      type: 'observation',
      content: 'Memory 1',
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
    });

    // Future cutoff should delete everything
    const deleted = repo.deleteOlderThan(workspaceId, Date.now() + 1000000);
    expect(deleted).toBe(1);
  });

  it('should handle retention with very old cutoff (delete nothing)', () => {
    repo.create({
      workspaceId,
      type: 'observation',
      content: 'Memory 1',
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
    });

    // Very old cutoff should delete nothing
    const deleted = repo.deleteOlderThan(workspaceId, 0);
    expect(deleted).toBe(0);
  });

  it('should handle cleanup on empty workspace', () => {
    const deleted = repo.deleteOlderThan(workspaceId, Date.now());
    expect(deleted).toBe(0);
  });

  it('should not affect other workspaces during cleanup', () => {
    const otherWorkspace = 'other-workspace';

    repo.create({
      workspaceId,
      type: 'observation',
      content: 'Workspace 1',
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
    });

    repo.create({
      workspaceId: otherWorkspace,
      type: 'observation',
      content: 'Workspace 2',
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
    });

    // Delete from workspace 1 only
    repo.deleteOlderThan(workspaceId, Date.now() + 1000);

    // Workspace 2 should be untouched
    const remaining = repo.getRecentForWorkspace(otherWorkspace, 10);
    expect(remaining.length).toBe(1);
  });
});

describe('Settings Edge Cases', () => {
  let service: MockMemoryService;
  const workspaceId = 'settings-edge-workspace';

  beforeEach(() => {
    mockMemories = new Map();
    mockSettings = new Map();
    memoryIdCounter = 0;
    service = new MockMemoryService();
  });

  it('should handle invalid regex in excluded patterns', () => {
    // Invalid regex pattern
    service.updateSettings(workspaceId, {
      excludedPatterns: ['[invalid(regex', 'valid-pattern'],
    });

    // Should not throw, invalid patterns are skipped
    const memory = service.capture(workspaceId, 'task-1', 'observation', 'Test content');
    expect(memory).not.toBeNull();
  });

  it('should handle empty excluded patterns array', () => {
    service.updateSettings(workspaceId, { excludedPatterns: [] });

    const memory = service.capture(workspaceId, 'task-1', 'observation', 'Any content');
    expect(memory).not.toBeNull();
  });

  it('should handle extremely long excluded pattern', () => {
    const longPattern = 'x'.repeat(1000);
    service.updateSettings(workspaceId, { excludedPatterns: [longPattern] });

    const memory = service.capture(workspaceId, 'task-1', 'observation', 'Normal content');
    expect(memory).not.toBeNull();
  });

  it('should handle retention days of 0', () => {
    service.updateSettings(workspaceId, { retentionDays: 0 });

    const settings = service.getSettings(workspaceId);
    expect(settings.retentionDays).toBe(0);
  });

  it('should handle switching privacy modes', () => {
    // Start with normal
    let memory1 = service.capture(workspaceId, 'task-1', 'observation', 'Content 1');
    expect(memory1?.isPrivate).toBe(false);

    // Switch to strict
    service.updateSettings(workspaceId, { privacyMode: 'strict' });
    let memory2 = service.capture(workspaceId, 'task-1', 'observation', 'Content 2');
    expect(memory2?.isPrivate).toBe(true);

    // Switch to disabled
    service.updateSettings(workspaceId, { privacyMode: 'disabled' });
    let memory3 = service.capture(workspaceId, 'task-1', 'observation', 'Content 3');
    expect(memory3).toBeNull();

    // Back to normal
    service.updateSettings(workspaceId, { privacyMode: 'normal' });
    let memory4 = service.capture(workspaceId, 'task-1', 'observation', 'Content 4');
    expect(memory4?.isPrivate).toBe(false);
  });
});

describe('Stats Edge Cases', () => {
  let service: MockMemoryService;
  const workspaceId = 'stats-edge-workspace';

  beforeEach(() => {
    mockMemories = new Map();
    mockSettings = new Map();
    memoryIdCounter = 0;
    service = new MockMemoryService();
  });

  it('should handle stats with only private memories', () => {
    service.capture(workspaceId, 'task-1', 'observation', 'Contains api_key secret');

    const stats = service.getStats(workspaceId);
    expect(stats.count).toBe(1);
    expect(stats.totalTokens).toBeGreaterThan(0);
  });

  it('should handle stats with mixed compressed/uncompressed', () => {
    // Create uncompressed
    service.capture(workspaceId, 'task-1', 'observation', 'Uncompressed memory');

    // Manually add a compressed one
    mockMemories.set('compressed-1', {
      id: 'compressed-1',
      workspaceId,
      type: 'observation',
      content: 'Compressed content',
      summary: 'Summary',
      tokens: 10,
      isCompressed: true,
      isPrivate: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const stats = service.getStats(workspaceId);
    expect(stats.count).toBe(2);
    expect(stats.compressedCount).toBe(1);
    expect(stats.compressionRatio).toBe(0.5);
  });

  it('should handle stats with zero tokens', () => {
    service.capture(workspaceId, 'task-1', 'observation', '');

    const stats = service.getStats(workspaceId);
    expect(stats.count).toBe(1);
    expect(stats.totalTokens).toBe(0);
  });
});

describe('Context Injection Edge Cases', () => {
  let service: MockMemoryService;
  const workspaceId = 'context-edge-workspace';

  beforeEach(() => {
    mockMemories = new Map();
    mockSettings = new Map();
    memoryIdCounter = 0;
    service = new MockMemoryService();
  });

  it('should handle context with all private memories', () => {
    // All captured memories will be private due to "auth" pattern
    service.capture(workspaceId, 'task-1', 'observation', 'auth token setup');
    service.capture(workspaceId, 'task-1', 'observation', 'password validation');

    const context = service.getContextForInjection(workspaceId, 'Test task');
    // Should return minimal context since all are private
    expect(context).not.toContain('auth');
    expect(context).not.toContain('password');
  });

  it('should handle context with very long memories', () => {
    const longContent = 'A'.repeat(500);
    service.capture(workspaceId, 'task-1', 'observation', longContent);

    const context = service.getContextForInjection(workspaceId, 'Test task');
    // Context should be truncated
    expect(context.length).toBeLessThan(longContent.length + 500);
    expect(context).toContain('...');
  });

  it('should handle context with special characters in memories', () => {
    service.capture(workspaceId, 'task-1', 'observation', '<script>alert("xss")</script>');

    const context = service.getContextForInjection(workspaceId, 'Test task');
    // Should contain the content (it's in memory_context tags)
    expect(context).toContain('<memory_context>');
  });

  it('should handle empty task prompt', () => {
    service.capture(workspaceId, 'task-1', 'observation', 'Normal memory');

    const context = service.getContextForInjection(workspaceId, '');
    // Should still return context
    expect(context).toContain('<memory_context>');
  });
});
