/**
 * Tests for SkillEligibilityChecker
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CustomSkill, SkillsConfig } from '../../../shared/types';

// Mock child_process before importing the module
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// Dynamic import to allow mocking
const { SkillEligibilityChecker } = await import('../skill-eligibility');

describe('SkillEligibilityChecker', () => {
  let checker: SkillEligibilityChecker;

  beforeEach(() => {
    checker = new SkillEligibilityChecker();
    vi.clearAllMocks();
  });

  afterEach(() => {
    checker.clearCache();
  });

  describe('checkEnvVar', () => {
    it('should return true when env var is set', () => {
      process.env.TEST_VAR = 'value';
      expect(checker.checkEnvVar('TEST_VAR')).toBe(true);
      delete process.env.TEST_VAR;
    });

    it('should return false when env var is not set', () => {
      delete process.env.NONEXISTENT_VAR;
      expect(checker.checkEnvVar('NONEXISTENT_VAR')).toBe(false);
    });

    it('should return false when env var is empty string', () => {
      process.env.EMPTY_VAR = '';
      expect(checker.checkEnvVar('EMPTY_VAR')).toBe(false);
      delete process.env.EMPTY_VAR;
    });
  });

  describe('checkAllEnvVars', () => {
    it('should return found and missing env vars', () => {
      process.env.FOUND_VAR = 'value';
      delete process.env.MISSING_VAR;

      const result = checker.checkAllEnvVars(['FOUND_VAR', 'MISSING_VAR']);
      expect(result.found).toContain('FOUND_VAR');
      expect(result.missing).toContain('MISSING_VAR');

      delete process.env.FOUND_VAR;
    });
  });

  describe('checkOS', () => {
    it('should match current OS', () => {
      const result = checker.checkOS([process.platform as 'darwin' | 'linux' | 'win32']);
      expect(result.matches).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('should not match different OS', () => {
      const differentOS = process.platform === 'darwin' ? 'win32' : 'darwin';
      const result = checker.checkOS([differentOS]);
      expect(result.matches).toBe(false);
      expect(result.missing).toContain(differentOS);
    });

    it('should match when OS array is empty', () => {
      const result = checker.checkOS([]);
      expect(result.matches).toBe(true);
    });

    it('should return current platform in result', () => {
      const result = checker.checkOS(['darwin']);
      expect(result.current).toBe(process.platform);
    });
  });

  describe('isBlockedByList', () => {
    it('should return true when skill is in denylist', () => {
      const config: SkillsConfig = {
        skillsDirectory: '/test',
        enabledSkillIds: [],
        denylist: ['blocked-skill'],
      };
      const checkerWithConfig = new SkillEligibilityChecker(config);
      expect(checkerWithConfig.isBlockedByList('blocked-skill')).toBe(true);
    });

    it('should return true when skill is not in allowlist', () => {
      const config: SkillsConfig = {
        skillsDirectory: '/test',
        enabledSkillIds: [],
        allowlist: ['allowed-skill'],
      };
      const checkerWithConfig = new SkillEligibilityChecker(config);
      expect(checkerWithConfig.isBlockedByList('other-skill')).toBe(true);
      expect(checkerWithConfig.isBlockedByList('allowed-skill')).toBe(false);
    });

    it('should return false when no config', () => {
      expect(checker.isBlockedByList('any-skill')).toBe(false);
    });

    it('should return false when lists are empty', () => {
      const config: SkillsConfig = {
        skillsDirectory: '/test',
        enabledSkillIds: [],
        allowlist: [],
        denylist: [],
      };
      const checkerWithConfig = new SkillEligibilityChecker(config);
      expect(checkerWithConfig.isBlockedByList('any-skill')).toBe(false);
    });
  });

  describe('checkEligibility', () => {
    it('should return eligible for skill with no requirements', async () => {
      const skill: CustomSkill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        icon: 'test',
        prompt: 'Test prompt',
      };

      const result = await checker.checkEligibility(skill);
      expect(result.eligible).toBe(true);
      expect(result.disabled).toBe(false);
      expect(result.blockedByAllowlist).toBe(false);
    });

    it('should return not eligible when disabled', async () => {
      const skill: CustomSkill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        icon: 'test',
        prompt: 'Test prompt',
        enabled: false,
      };

      const result = await checker.checkEligibility(skill);
      expect(result.eligible).toBe(false);
      expect(result.disabled).toBe(true);
    });

    it('should return not eligible when missing required env var', async () => {
      delete process.env.REQUIRED_API_KEY;

      const skill: CustomSkill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        icon: 'test',
        prompt: 'Test prompt',
        requires: {
          env: ['REQUIRED_API_KEY'],
        },
      };

      const result = await checker.checkEligibility(skill);
      expect(result.eligible).toBe(false);
      expect(result.missing.env).toContain('REQUIRED_API_KEY');
    });

    it('should return eligible when required env var is set', async () => {
      process.env.MY_API_KEY = 'test-key';

      const skill: CustomSkill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        icon: 'test',
        prompt: 'Test prompt',
        requires: {
          env: ['MY_API_KEY'],
        },
      };

      const result = await checker.checkEligibility(skill);
      expect(result.eligible).toBe(true);
      expect(result.missing.env).toHaveLength(0);

      delete process.env.MY_API_KEY;
    });

    it('should return not eligible when OS does not match', async () => {
      const differentOS = process.platform === 'darwin' ? 'win32' : 'darwin';

      const skill: CustomSkill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        icon: 'test',
        prompt: 'Test prompt',
        requires: {
          os: [differentOS as 'darwin' | 'linux' | 'win32'],
        },
      };

      const result = await checker.checkEligibility(skill);
      expect(result.eligible).toBe(false);
      expect(result.missing.os.length).toBeGreaterThan(0);
    });

    it('should return eligible when OS matches', async () => {
      const skill: CustomSkill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        icon: 'test',
        prompt: 'Test prompt',
        requires: {
          os: [process.platform as 'darwin' | 'linux' | 'win32'],
        },
      };

      const result = await checker.checkEligibility(skill);
      expect(result.eligible).toBe(true);
      expect(result.missing.os).toHaveLength(0);
    });

    it('should check multiple requirements together', async () => {
      process.env.TEST_KEY = 'value';
      delete process.env.MISSING_KEY;

      const skill: CustomSkill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        icon: 'test',
        prompt: 'Test prompt',
        requires: {
          env: ['TEST_KEY', 'MISSING_KEY'],
          os: [process.platform as 'darwin' | 'linux' | 'win32'],
        },
      };

      const result = await checker.checkEligibility(skill);
      expect(result.eligible).toBe(false);
      expect(result.missing.env).toContain('MISSING_KEY');
      expect(result.missing.env).not.toContain('TEST_KEY');
      expect(result.missing.os).toHaveLength(0);

      delete process.env.TEST_KEY;
    });
  });

  describe('buildStatusEntry', () => {
    it('should build complete status entry', async () => {
      const skill: CustomSkill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        icon: 'test',
        prompt: 'Test prompt',
        requires: {
          env: ['HOME'],
          os: [process.platform as 'darwin' | 'linux' | 'win32'],
        },
      };

      const entry = await checker.buildStatusEntry(skill);

      expect(entry.id).toBe('test-skill');
      expect(entry.name).toBe('Test Skill');
      expect(entry.requirements.env).toEqual(['HOME']);
      expect(entry.requirements.os).toEqual([process.platform]);
      expect(typeof entry.eligible).toBe('boolean');
      expect(typeof entry.disabled).toBe('boolean');
      expect(typeof entry.blockedByAllowlist).toBe('boolean');
    });

    it('should include missing requirements in status entry', async () => {
      delete process.env.NONEXISTENT_VAR;

      const skill: CustomSkill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        icon: 'test',
        prompt: 'Test prompt',
        requires: {
          env: ['NONEXISTENT_VAR'],
        },
      };

      const entry = await checker.buildStatusEntry(skill);

      expect(entry.missing.env).toContain('NONEXISTENT_VAR');
      expect(entry.eligible).toBe(false);
    });
  });

  describe('buildStatusEntries', () => {
    it('should build status entries for multiple skills', async () => {
      const skills: CustomSkill[] = [
        {
          id: 'skill-1',
          name: 'Skill 1',
          description: 'First skill',
          icon: 'test',
          prompt: 'Test prompt 1',
        },
        {
          id: 'skill-2',
          name: 'Skill 2',
          description: 'Second skill',
          icon: 'test',
          prompt: 'Test prompt 2',
          enabled: false,
        },
      ];

      const entries = await checker.buildStatusEntries(skills);

      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe('skill-1');
      expect(entries[0].eligible).toBe(true);
      expect(entries[1].id).toBe('skill-2');
      expect(entries[1].eligible).toBe(false);
      expect(entries[1].disabled).toBe(true);
    });
  });

  describe('updateConfig', () => {
    it('should update config and affect blocking behavior', () => {
      expect(checker.isBlockedByList('blocked-skill')).toBe(false);

      checker.updateConfig({
        skillsDirectory: '/test',
        enabledSkillIds: [],
        denylist: ['blocked-skill'],
      });

      expect(checker.isBlockedByList('blocked-skill')).toBe(true);
    });
  });

  describe('clearCache', () => {
    it('should be callable without errors', () => {
      expect(() => checker.clearCache()).not.toThrow();
    });
  });

  describe('Security: Binary Name Validation', () => {
    it('should reject binary names with shell metacharacters', async () => {
      const result = await checker.checkBinary('node; rm -rf /');
      expect(result).toBe(false);
    });

    it('should reject binary names with path traversal', async () => {
      const result = await checker.checkBinary('../../../bin/bash');
      expect(result).toBe(false);
    });

    it('should reject binary names with backticks', async () => {
      const result = await checker.checkBinary('`whoami`');
      expect(result).toBe(false);
    });

    it('should reject binary names with dollar signs', async () => {
      const result = await checker.checkBinary('$(whoami)');
      expect(result).toBe(false);
    });

    it('should reject binary names with pipes', async () => {
      const result = await checker.checkBinary('cat | rm');
      expect(result).toBe(false);
    });

    it('should reject empty binary names', async () => {
      const result = await checker.checkBinary('');
      expect(result).toBe(false);
    });

    it('should reject whitespace-only binary names', async () => {
      const result = await checker.checkBinary('   ');
      expect(result).toBe(false);
    });

    // Note: Tests for valid binary names that would pass sanitization
    // are not included here because they would trigger actual shell execution,
    // which is slow and environment-dependent. The security tests above
    // verify that malicious inputs are rejected before reaching the shell.
  });
});
