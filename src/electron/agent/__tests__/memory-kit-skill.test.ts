/**
 * Tests for Memory Kit skill
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { CustomSkill } from '../../../shared/types';

// Path to the skill file in the repo
const SKILL_PATH = path.join(__dirname, '../../../../resources/skills/memory-kit.json');

describe('Memory Kit Skill', () => {
  let skillData: CustomSkill;

  beforeEach(() => {
    const content = fs.readFileSync(SKILL_PATH, 'utf-8');
    skillData = JSON.parse(content);
  });

  describe('skill structure', () => {
    it('should have a valid id', () => {
      expect(skillData.id).toBe('memory-kit');
    });

    it('should have a name', () => {
      expect(skillData.name).toBe('Memory Kit');
    });

    it('should have a description', () => {
      expect(skillData.description).toBeDefined();
      expect(skillData.description.length).toBeGreaterThan(20);
      expect(skillData.description).toContain('memory');
    });

    it('should have an icon', () => {
      expect(skillData.icon).toBe('🧠');
    });

    it('should have a category', () => {
      expect(skillData.category).toBe('Tools');
    });

    it('should be enabled', () => {
      expect(skillData.enabled).toBe(true);
    });

    it('should have empty parameters array', () => {
      expect(skillData.parameters).toEqual([]);
    });
  });

  describe('prompt content', () => {
    it('should have a prompt', () => {
      expect(skillData.prompt).toBeDefined();
      expect(skillData.prompt.length).toBeGreaterThan(200);
    });

    it('should default to .cowork/ location', () => {
      expect(skillData.prompt).toContain('TARGET LOCATION');
      expect(skillData.prompt).toContain('.cowork/');
      expect(skillData.prompt).toContain('Do NOT write these files at repo root');
    });

    it('should include all core kit files', () => {
      expect(skillData.prompt).toContain('.cowork/AGENTS.md');
      expect(skillData.prompt).toContain('.cowork/SOUL.md');
      expect(skillData.prompt).toContain('.cowork/USER.md');
      expect(skillData.prompt).toContain('.cowork/MEMORY.md');
      expect(skillData.prompt).toContain('.cowork/HEARTBEAT.md');
      expect(skillData.prompt).toContain('.cowork/PRIORITIES.md');
      expect(skillData.prompt).toContain('.cowork/CROSS_SIGNALS.md');
      expect(skillData.prompt).toContain('.cowork/TOOLS.md');
      expect(skillData.prompt).toContain('.cowork/IDENTITY.md');
      expect(skillData.prompt).toContain('.cowork/BOOTSTRAP.md');
    });

    it('should include daily log template', () => {
      expect(skillData.prompt).toContain('.cowork/memory/YYYY-MM-DD.md');
      expect(skillData.prompt).toContain('# Daily Log (YYYY-MM-DD)');
      expect(skillData.prompt).toContain('## Open Loops');
    });
  });

  describe('JSON validity', () => {
    it('should be valid JSON', () => {
      const content = fs.readFileSync(SKILL_PATH, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('should not have extra unexpected properties', () => {
      const allowedKeys = [
        'id',
        'name',
        'description',
        'icon',
        'category',
        'prompt',
        'parameters',
        'enabled',
        'type',
        'priority',
        'invocation',
        'metadata',
      ];
      const skillKeys = Object.keys(skillData);
      for (const key of skillKeys) {
        expect(allowedKeys).toContain(key);
      }
    });
  });
});
