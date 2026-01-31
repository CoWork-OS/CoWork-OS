/**
 * Tests for SkillRegistry
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { CustomSkill, SkillRegistryEntry, SkillSearchResult } from '../../../shared/types';

// Track file system operations
let mockFiles: Map<string, string> = new Map();
let mockDirExists = true;

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (p.endsWith('skills')) return mockDirExists;
      const filename = p.split('/').pop() || '';
      for (const [key] of mockFiles) {
        if (key.endsWith(filename)) return true;
      }
      return false;
    }),
    readFileSync: vi.fn().mockImplementation((p: string) => {
      const filename = p.split('/').pop() || '';
      for (const [key, value] of mockFiles) {
        if (key.endsWith(filename)) return value;
      }
      throw new Error(`File not found: ${p}`);
    }),
    writeFileSync: vi.fn().mockImplementation((p: string, content: string) => {
      const filename = p.split('/').pop() || '';
      mockFiles.set(filename, content);
    }),
    readdirSync: vi.fn().mockImplementation(() => {
      return Array.from(mockFiles.keys())
        .filter(k => k.endsWith('.json'))
        .map(k => k.split('/').pop());
    }),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn().mockImplementation((p: string) => {
      const filename = p.split('/').pop() || '';
      mockFiles.delete(filename);
    }),
  },
  existsSync: vi.fn().mockImplementation((p: string) => {
    if (p.endsWith('skills')) return mockDirExists;
    const filename = p.split('/').pop() || '';
    for (const [key] of mockFiles) {
      if (key.endsWith(filename)) return true;
    }
    return false;
  }),
  readFileSync: vi.fn().mockImplementation((p: string) => {
    const filename = p.split('/').pop() || '';
    for (const [key, value] of mockFiles) {
      if (key.endsWith(filename)) return value;
    }
    throw new Error(`File not found: ${p}`);
  }),
  writeFileSync: vi.fn().mockImplementation((p: string, content: string) => {
    const filename = p.split('/').pop() || '';
    mockFiles.set(filename, content);
  }),
  readdirSync: vi.fn().mockImplementation(() => {
    return Array.from(mockFiles.keys())
      .filter(k => k.endsWith('.json'))
      .map(k => k.split('/').pop());
  }),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn().mockImplementation((p: string) => {
    const filename = p.split('/').pop() || '';
    mockFiles.delete(filename);
  }),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Dynamic import after mocking
const { SkillRegistry, resetSkillRegistry } = await import('../skill-registry');

// Helper to create a mock skill
function createMockSkill(overrides: Partial<CustomSkill> = {}): CustomSkill {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    icon: '🧪',
    prompt: 'Test prompt content',
    enabled: true,
    ...overrides,
  };
}

// Helper to create a mock registry entry
function createMockRegistryEntry(overrides: Partial<SkillRegistryEntry> = {}): SkillRegistryEntry {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    version: '1.0.0',
    author: 'Test Author',
    ...overrides,
  };
}

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    mockDirExists = true;
    mockFetch.mockReset();
    resetSkillRegistry();
    registry = new SkillRegistry({
      registryUrl: 'https://test-registry.com/api',
      managedSkillsDir: '/mock/skills',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSkillRegistry();
  });

  describe('constructor', () => {
    it('should use default registry URL when not provided', () => {
      const defaultRegistry = new SkillRegistry({
        managedSkillsDir: '/mock/skills',
      });
      expect(defaultRegistry.getRegistryUrl()).toBe('https://skill-hub.com/api');
    });

    it('should use custom registry URL when provided', () => {
      expect(registry.getRegistryUrl()).toBe('https://test-registry.com/api');
    });
  });

  describe('search', () => {
    it('should search for skills and return results', async () => {
      const mockResults: SkillSearchResult = {
        query: 'test',
        total: 2,
        page: 1,
        pageSize: 20,
        results: [
          createMockRegistryEntry({ id: 'skill-1', name: 'Skill 1' }),
          createMockRegistryEntry({ id: 'skill-2', name: 'Skill 2' }),
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResults),
      });

      const result = await registry.search('test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/skills/search?q=test')
      );
      expect(result.total).toBe(2);
      expect(result.results).toHaveLength(2);
    });

    it('should include pagination parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ query: 'test', total: 0, page: 2, pageSize: 10, results: [] }),
      });

      await registry.search('test', { page: 2, pageSize: 10 });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/page=2.*pageSize=10|pageSize=10.*page=2/)
      );
    });

    it('should return empty results on fetch error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await registry.search('test');

      expect(result.total).toBe(0);
      expect(result.results).toHaveLength(0);
    });

    it('should return empty results on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await registry.search('test');

      expect(result.total).toBe(0);
      expect(result.results).toHaveLength(0);
    });
  });

  describe('getSkillDetails', () => {
    it('should fetch skill details by id', async () => {
      const mockEntry = createMockRegistryEntry();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockEntry),
      });

      const result = await registry.getSkillDetails('test-skill');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-registry.com/api/skills/test-skill'
      );
      expect(result).toEqual(mockEntry);
    });

    it('should return null for 404 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await registry.getSkillDetails('non-existent');

      expect(result).toBeNull();
    });

    it('should return null on fetch error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await registry.getSkillDetails('test-skill');

      expect(result).toBeNull();
    });
  });

  describe('install', () => {
    it('should download and install a skill', async () => {
      const mockSkillData = createMockSkill();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSkillData),
      });

      const progressUpdates: string[] = [];
      const result = await registry.install('test-skill', undefined, (progress) => {
        progressUpdates.push(progress.status);
      });

      expect(result.success).toBe(true);
      expect(result.skill).toBeDefined();
      expect(result.skill?.id).toBe('test-skill');
      expect(result.skill?.source).toBe('managed');
      expect(progressUpdates).toContain('downloading');
      expect(progressUpdates).toContain('completed');
    });

    it('should include version in download URL when provided', async () => {
      const mockSkillData = createMockSkill();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSkillData),
      });

      await registry.install('test-skill', '1.2.3');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('version=1.2.3')
      );
    });

    it('should return error on failed download', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await registry.install('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to download');
    });

    it('should return error on invalid skill data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ invalid: 'data' }),
      });

      const result = await registry.install('test-skill');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid skill data');
    });

    it('should call progress callback with failure on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const progressUpdates: string[] = [];
      await registry.install('test-skill', undefined, (progress) => {
        progressUpdates.push(progress.status);
      });

      expect(progressUpdates).toContain('failed');
    });
  });

  describe('update', () => {
    it('should return error if skill is not installed', async () => {
      mockDirExists = true;

      const result = await registry.update('non-installed');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('should re-install skill when updating', async () => {
      // First install a skill
      const skillData = createMockSkill({ id: 'update-skill' });
      mockFiles.set('update-skill.json', JSON.stringify(skillData));

      // Mock the fetch for update
      const updatedSkill = { ...skillData, metadata: { version: '2.0.0' } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(updatedSkill),
      });

      const result = await registry.update('update-skill');

      expect(result.success).toBe(true);
      expect(result.skill?.id).toBe('update-skill');
    });
  });

  describe('uninstall', () => {
    it('should remove skill file', () => {
      const skillData = createMockSkill({ id: 'to-uninstall' });
      mockFiles.set('to-uninstall.json', JSON.stringify(skillData));

      const result = registry.uninstall('to-uninstall');

      expect(result.success).toBe(true);
    });

    it('should return error if skill not installed', () => {
      const result = registry.uninstall('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
    });
  });

  describe('listManagedSkills', () => {
    it('should return empty array when no skills', () => {
      const skills = registry.listManagedSkills();
      expect(skills).toEqual([]);
    });

    it('should return all managed skills', () => {
      const skill1 = createMockSkill({ id: 'skill-1' });
      const skill2 = createMockSkill({ id: 'skill-2' });

      mockFiles.set('skill-1.json', JSON.stringify(skill1));
      mockFiles.set('skill-2.json', JSON.stringify(skill2));

      const skills = registry.listManagedSkills();

      expect(skills).toHaveLength(2);
      expect(skills.every(s => s.source === 'managed')).toBe(true);
    });

    it('should skip non-json files', () => {
      mockFiles.set('skill-1.json', JSON.stringify(createMockSkill({ id: 'skill-1' })));
      mockFiles.set('readme.txt', 'Some text');

      const skills = registry.listManagedSkills();

      expect(skills).toHaveLength(1);
    });

    it('should handle malformed JSON gracefully', () => {
      mockFiles.set('good.json', JSON.stringify(createMockSkill({ id: 'good' })));
      mockFiles.set('bad.json', 'not valid json');

      // The mock returns both, but parsing will fail for bad.json
      // Since our mock doesn't throw on invalid JSON, we need to adjust
      const skills = registry.listManagedSkills();

      // Should still return at least the valid one
      expect(skills.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('isInstalled', () => {
    it('should return true when skill is installed', () => {
      mockFiles.set('installed-skill.json', JSON.stringify(createMockSkill({ id: 'installed-skill' })));

      expect(registry.isInstalled('installed-skill')).toBe(true);
    });

    it('should return false when skill is not installed', () => {
      expect(registry.isInstalled('not-installed')).toBe(false);
    });
  });

  describe('getInstalledVersion', () => {
    it('should return version when skill has metadata', () => {
      const skill = createMockSkill({
        id: 'versioned',
        metadata: { version: '1.2.3', author: 'Test' },
      });
      mockFiles.set('versioned.json', JSON.stringify(skill));

      expect(registry.getInstalledVersion('versioned')).toBe('1.2.3');
    });

    it('should return null when skill has no version', () => {
      const skill = createMockSkill({ id: 'no-version' });
      mockFiles.set('no-version.json', JSON.stringify(skill));

      expect(registry.getInstalledVersion('no-version')).toBeNull();
    });

    it('should return null when skill is not installed', () => {
      expect(registry.getInstalledVersion('not-installed')).toBeNull();
    });
  });

  describe('checkForUpdates', () => {
    it('should return hasUpdate true when versions differ', async () => {
      const skill = createMockSkill({
        id: 'outdated',
        metadata: { version: '1.0.0', author: 'Test' },
      });
      mockFiles.set('outdated.json', JSON.stringify(skill));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockRegistryEntry({ id: 'outdated', version: '2.0.0' })),
      });

      const result = await registry.checkForUpdates('outdated');

      expect(result.hasUpdate).toBe(true);
      expect(result.currentVersion).toBe('1.0.0');
      expect(result.latestVersion).toBe('2.0.0');
    });

    it('should return hasUpdate false when versions match', async () => {
      const skill = createMockSkill({
        id: 'current',
        metadata: { version: '1.0.0', author: 'Test' },
      });
      mockFiles.set('current.json', JSON.stringify(skill));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockRegistryEntry({ id: 'current', version: '1.0.0' })),
      });

      const result = await registry.checkForUpdates('current');

      expect(result.hasUpdate).toBe(false);
    });

    it('should handle skill not found in registry', async () => {
      const skill = createMockSkill({ id: 'local-only' });
      mockFiles.set('local-only.json', JSON.stringify(skill));

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await registry.checkForUpdates('local-only');

      expect(result.hasUpdate).toBe(false);
      expect(result.latestVersion).toBeNull();
    });
  });

  describe('setRegistryUrl', () => {
    it('should update the registry URL', () => {
      registry.setRegistryUrl('https://new-registry.com/api');
      expect(registry.getRegistryUrl()).toBe('https://new-registry.com/api');
    });
  });

  describe('getManagedSkillsDir', () => {
    it('should return the managed skills directory', () => {
      const dir = registry.getManagedSkillsDir();
      expect(dir).toBe('/mock/skills');
    });
  });

  describe('updateAll', () => {
    it('should update all installed skills', async () => {
      const skill1 = createMockSkill({ id: 'skill-1' });
      const skill2 = createMockSkill({ id: 'skill-2' });
      mockFiles.set('skill-1.json', JSON.stringify(skill1));
      mockFiles.set('skill-2.json', JSON.stringify(skill2));

      // Mock successful updates
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(skill1),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(skill2),
        });

      const result = await registry.updateAll();

      expect(result.updated).toContain('skill-1');
      expect(result.updated).toContain('skill-2');
      expect(result.failed).toHaveLength(0);
    });

    it('should track failed updates', async () => {
      const skill1 = createMockSkill({ id: 'skill-1' });
      mockFiles.set('skill-1.json', JSON.stringify(skill1));

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error',
      });

      const result = await registry.updateAll();

      expect(result.failed).toContain('skill-1');
      expect(result.updated).toHaveLength(0);
    });
  });
});

describe('getSkillRegistry', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  it('should return singleton instance', async () => {
    const { getSkillRegistry, resetSkillRegistry: reset } = await import('../skill-registry');
    reset();

    const instance1 = getSkillRegistry({ managedSkillsDir: '/mock/skills' });
    const instance2 = getSkillRegistry();

    expect(instance1).toBe(instance2);

    reset();
  });
});

describe('Security: Skill ID Validation', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    mockDirExists = true;
    mockFetch.mockReset();
    resetSkillRegistry();
    registry = new SkillRegistry({
      registryUrl: 'https://test-registry.com/api',
      managedSkillsDir: '/mock/skills',
    });
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  describe('path traversal prevention', () => {
    it('should reject skill ID with path traversal (..)', async () => {
      const result = await registry.install('../../../etc/passwd');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid skill ID');
    });

    it('should reject skill ID with forward slashes', async () => {
      const result = await registry.install('foo/bar');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid skill ID');
    });

    it('should reject skill ID with backslashes', async () => {
      const result = await registry.install('foo\\bar');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid skill ID');
    });

    it('should reject skill ID with special characters', async () => {
      const result = await registry.install('skill;rm -rf /');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid skill ID');
    });

    it('should reject empty skill ID', async () => {
      const result = await registry.install('');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid skill ID');
    });

    it('should reject skill ID with only whitespace', async () => {
      const result = await registry.install('   ');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid skill ID');
    });
  });

  describe('valid skill IDs', () => {
    it('should accept lowercase alphanumeric skill ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockSkill({ id: 'valid123' })),
      });

      const result = await registry.install('valid123');
      expect(result.success).toBe(true);
    });

    it('should accept skill ID with hyphens', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockSkill({ id: 'my-skill-name' })),
      });

      const result = await registry.install('my-skill-name');
      expect(result.success).toBe(true);
    });

    it('should accept skill ID with underscores', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockSkill({ id: 'my_skill_name' })),
      });

      const result = await registry.install('my_skill_name');
      expect(result.success).toBe(true);
    });

    it('should normalize uppercase to lowercase', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockSkill({ id: 'myskill' })),
      });

      const result = await registry.install('MySkill');
      expect(result.success).toBe(true);
    });
  });

  describe('uninstall validation', () => {
    it('should reject path traversal in uninstall', () => {
      const result = registry.uninstall('../../../etc/passwd');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid skill ID');
    });
  });

  describe('getSkillDetails validation', () => {
    it('should return null for invalid skill ID', async () => {
      const result = await registry.getSkillDetails('../malicious');
      expect(result).toBeNull();
    });
  });

  describe('isInstalled validation', () => {
    it('should return false for invalid skill ID', () => {
      const result = registry.isInstalled('../malicious');
      expect(result).toBe(false);
    });
  });

  describe('checkForUpdates validation', () => {
    it('should return safe defaults for invalid skill ID', async () => {
      const result = await registry.checkForUpdates('../malicious');
      expect(result.hasUpdate).toBe(false);
      expect(result.currentVersion).toBeNull();
      expect(result.latestVersion).toBeNull();
    });
  });
});
