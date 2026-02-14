/**
 * Tests for Auto Commenter skill
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { CustomSkill } from '../../../shared/types';

// Path to the skill file in the repo
const SKILL_PATH = path.join(__dirname, '../../../../resources/skills/auto-commenter.json');

describe('Auto Commenter Skill', () => {
  let skillData: CustomSkill;

  beforeEach(() => {
    // Load the actual skill file
    const content = fs.readFileSync(SKILL_PATH, 'utf-8');
    skillData = JSON.parse(content);
  });

  describe('skill structure', () => {
    it('should have a valid id', () => {
      expect(skillData.id).toBe('auto-commenter');
    });

    it('should have a name', () => {
      expect(skillData.name).toBe('Auto Commenter');
    });

    it('should have a description', () => {
      expect(skillData.description).toBeDefined();
      expect(skillData.description.length).toBeGreaterThan(20);
      expect(skillData.description).toContain('comment');
    });

    it('should have an icon', () => {
      expect(skillData.icon).toBe('💬');
    });

    it('should have a category', () => {
      expect(skillData.category).toBe('Marketing');
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
      expect(skillData.prompt.length).toBeGreaterThan(100);
    });

    it('should include overview section', () => {
      expect(skillData.prompt).toContain('## Overview');
    });

    it('should include core principles', () => {
      expect(skillData.prompt).toContain('## Core Principles');
      expect(skillData.prompt).toContain('Authenticity');
    });

    it('should include 16-point authenticity checklist', () => {
      expect(skillData.prompt).toContain('16-Point Authenticity Checklist');
    });

    it('should include workflow section', () => {
      expect(skillData.prompt).toContain('## Workflow');
      expect(skillData.prompt).toContain('Style Learning');
      expect(skillData.prompt).toContain('Target Analysis');
      expect(skillData.prompt).toContain('Post Evaluation');
      expect(skillData.prompt).toContain('Comment Generation');
      expect(skillData.prompt).toContain('Lead Identification');
    });

    it('should include output format', () => {
      expect(skillData.prompt).toContain('## Output Format');
      expect(skillData.prompt).toContain('**Target**');
      expect(skillData.prompt).toContain('**Comment**');
      expect(skillData.prompt).toContain('**Authenticity Score**');
      expect(skillData.prompt).toContain('**Lead Potential**');
    });

    it('should include batch mode instructions', () => {
      expect(skillData.prompt).toContain('## Batch Mode');
    });

    it('should include activity logging', () => {
      expect(skillData.prompt).toContain('## Activity Logging');
    });

    it('should include best practices', () => {
      expect(skillData.prompt).toContain('## Best Practices');
    });

    it('should include commands', () => {
      expect(skillData.prompt).toContain('## Commands');
      expect(skillData.prompt).toContain('analyze style');
      expect(skillData.prompt).toContain('scout');
      expect(skillData.prompt).toContain('generate');
      expect(skillData.prompt).toContain('batch');
      expect(skillData.prompt).toContain('review leads');
      expect(skillData.prompt).toContain('log today');
    });

    it('should include ethical guidelines', () => {
      expect(skillData.prompt).toContain('## Ethical Guidelines');
      expect(skillData.prompt).toContain('disclose');
      expect(skillData.prompt).toContain('impersonate');
    });

    it('should mention supported platforms', () => {
      expect(skillData.prompt).toContain('Reddit');
      expect(skillData.prompt).toContain('Twitter');
      expect(skillData.prompt).toContain('LinkedIn');
      expect(skillData.prompt).toContain('Discord');
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

  describe('authenticity checklist coverage', () => {
    it('should have all 16 checklist items', () => {
      const checklistMatches = skillData.prompt.match(/^\d+\./gm);
      // Count numbered items in the checklist section
      const checklistSection = skillData.prompt.split('16-Point Authenticity Checklist')[1]?.split('## ')[0] || '';
      const numberedItems = checklistSection.match(/^\d+\./gm) || [];
      expect(numberedItems.length).toBeGreaterThanOrEqual(16);
    });
  });
});
