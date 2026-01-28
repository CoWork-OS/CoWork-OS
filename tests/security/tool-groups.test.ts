/**
 * Tests for Tool Groups and Risk Levels
 *
 * Tests the tool categorization system that enables security policies
 * to work with groups of tools rather than individual tools.
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_GROUPS,
  TOOL_RISK_LEVELS,
  CONTEXT_TOOL_RESTRICTIONS,
  ToolGroupName,
  ToolRiskLevel,
  GatewayContextType,
} from '../../src/shared/types';

describe('Tool Groups', () => {
  describe('TOOL_GROUPS structure', () => {
    it('should have all required groups defined', () => {
      const requiredGroups: ToolGroupName[] = [
        'group:read',
        'group:write',
        'group:destructive',
        'group:system',
        'group:network',
        'group:memory',
        'group:image',
        'group:meta',
      ];

      requiredGroups.forEach(group => {
        expect(TOOL_GROUPS[group]).toBeDefined();
        expect(Array.isArray(TOOL_GROUPS[group])).toBe(true);
      });
    });

    it('should have read-only tools in group:read', () => {
      const readTools = TOOL_GROUPS['group:read'];
      expect(readTools).toContain('read_file');
      expect(readTools).toContain('list_directory');
      expect(readTools).toContain('search_files');
    });

    it('should have write tools in group:write', () => {
      const writeTools = TOOL_GROUPS['group:write'];
      expect(writeTools).toContain('write_file');
      expect(writeTools).toContain('copy_file');
      expect(writeTools).toContain('create_directory');
    });

    it('should have destructive tools in group:destructive', () => {
      const destructiveTools = TOOL_GROUPS['group:destructive'];
      expect(destructiveTools).toContain('delete_file');
      expect(destructiveTools).toContain('run_command');
    });

    it('should have memory-sensitive tools in group:memory', () => {
      const memoryTools = TOOL_GROUPS['group:memory'];
      expect(memoryTools).toContain('read_clipboard');
      expect(memoryTools).toContain('write_clipboard');
    });

    it('should not have overlapping tools between read and destructive groups', () => {
      const readTools = new Set(TOOL_GROUPS['group:read']);
      const destructiveTools = TOOL_GROUPS['group:destructive'];

      destructiveTools.forEach(tool => {
        expect(readTools.has(tool)).toBe(false);
      });
    });
  });

  describe('Tool Group Expansion (C4 invariant)', () => {
    it('should correctly expand group:read to all read tools', () => {
      const expanded = [...TOOL_GROUPS['group:read']];
      expect(expanded.length).toBeGreaterThan(0);
      expect(expanded.every(t => typeof t === 'string')).toBe(true);
    });

    it('should correctly expand group:network to browser tools', () => {
      const networkTools = TOOL_GROUPS['group:network'];
      expect(networkTools).toContain('web_search');
      expect(networkTools).toContain('browser_navigate');
      expect(networkTools).toContain('browser_click');
    });

    it('should have all groups be non-empty', () => {
      Object.entries(TOOL_GROUPS).forEach(([groupName, tools]) => {
        expect(tools.length).toBeGreaterThan(0);
      });
    });
  });
});

describe('Tool Risk Levels', () => {
  describe('TOOL_RISK_LEVELS mapping', () => {
    const validRiskLevels: ToolRiskLevel[] = ['read', 'write', 'destructive', 'system', 'network'];

    it('should map all tools to valid risk levels', () => {
      Object.values(TOOL_RISK_LEVELS).forEach(level => {
        expect(validRiskLevels).toContain(level);
      });
    });

    it('should assign read level to read-only tools', () => {
      expect(TOOL_RISK_LEVELS['read_file']).toBe('read');
      expect(TOOL_RISK_LEVELS['list_directory']).toBe('read');
      expect(TOOL_RISK_LEVELS['search_files']).toBe('read');
    });

    it('should assign write level to write tools', () => {
      expect(TOOL_RISK_LEVELS['write_file']).toBe('write');
      expect(TOOL_RISK_LEVELS['copy_file']).toBe('write');
      expect(TOOL_RISK_LEVELS['create_directory']).toBe('write');
    });

    it('should assign destructive level to dangerous tools', () => {
      expect(TOOL_RISK_LEVELS['delete_file']).toBe('destructive');
      expect(TOOL_RISK_LEVELS['run_command']).toBe('destructive');
    });

    it('should assign system level to system tools', () => {
      expect(TOOL_RISK_LEVELS['read_clipboard']).toBe('system');
      expect(TOOL_RISK_LEVELS['take_screenshot']).toBe('system');
      expect(TOOL_RISK_LEVELS['open_application']).toBe('system');
    });
  });

  describe('Risk Level Consistency', () => {
    it('should have consistent risk levels with tool groups', () => {
      // All tools in group:read should have 'read' risk level
      TOOL_GROUPS['group:read'].forEach(tool => {
        if (TOOL_RISK_LEVELS[tool as keyof typeof TOOL_RISK_LEVELS]) {
          expect(TOOL_RISK_LEVELS[tool as keyof typeof TOOL_RISK_LEVELS]).toBe('read');
        }
      });
    });

    it('should have destructive tools marked as destructive risk', () => {
      TOOL_GROUPS['group:destructive'].forEach(tool => {
        if (TOOL_RISK_LEVELS[tool as keyof typeof TOOL_RISK_LEVELS]) {
          expect(TOOL_RISK_LEVELS[tool as keyof typeof TOOL_RISK_LEVELS]).toBe('destructive');
        }
      });
    });
  });
});

describe('Context Tool Restrictions (C1 invariant)', () => {
  const contexts: GatewayContextType[] = ['private', 'group', 'public'];

  describe('Structure validation', () => {
    it('should have restrictions for all context types', () => {
      contexts.forEach(context => {
        expect(CONTEXT_TOOL_RESTRICTIONS[context]).toBeDefined();
        expect(CONTEXT_TOOL_RESTRICTIONS[context].deniedGroups).toBeDefined();
        expect(CONTEXT_TOOL_RESTRICTIONS[context].deniedTools).toBeDefined();
        expect(CONTEXT_TOOL_RESTRICTIONS[context].requireApprovalFor).toBeDefined();
      });
    });
  });

  describe('Private context (least restrictive)', () => {
    const privateRestrictions = CONTEXT_TOOL_RESTRICTIONS['private'];

    it('should have no denied groups', () => {
      expect(privateRestrictions.deniedGroups).toHaveLength(0);
    });

    it('should have no denied tools', () => {
      expect(privateRestrictions.deniedTools).toHaveLength(0);
    });

    it('should still require approval for dangerous operations', () => {
      expect(privateRestrictions.requireApprovalFor).toContain('run_command');
      expect(privateRestrictions.requireApprovalFor).toContain('delete_file');
    });
  });

  describe('Group context (moderately restrictive)', () => {
    const groupRestrictions = CONTEXT_TOOL_RESTRICTIONS['group'];

    it('should deny memory group (C1: Memory Tool Isolation)', () => {
      expect(groupRestrictions.deniedGroups).toContain('group:memory');
    });

    it('should deny destructive group', () => {
      expect(groupRestrictions.deniedGroups).toContain('group:destructive');
    });

    it('should explicitly deny clipboard tools', () => {
      expect(groupRestrictions.deniedTools).toContain('read_clipboard');
      expect(groupRestrictions.deniedTools).toContain('write_clipboard');
    });

    it('should require approval for write operations', () => {
      expect(groupRestrictions.requireApprovalFor).toContain('write_file');
    });
  });

  describe('Public context (most restrictive)', () => {
    const publicRestrictions = CONTEXT_TOOL_RESTRICTIONS['public'];

    it('should deny memory, destructive, and system groups', () => {
      expect(publicRestrictions.deniedGroups).toContain('group:memory');
      expect(publicRestrictions.deniedGroups).toContain('group:destructive');
      expect(publicRestrictions.deniedGroups).toContain('group:system');
    });

    it('should deny more tools than group context', () => {
      const groupDenied = CONTEXT_TOOL_RESTRICTIONS['group'].deniedTools.length;
      const publicDenied = publicRestrictions.deniedTools.length;
      expect(publicDenied).toBeGreaterThanOrEqual(groupDenied);
    });

    it('should deny shell commands', () => {
      expect(publicRestrictions.deniedTools).toContain('run_command');
    });

    it('should deny screenshot and app launch', () => {
      expect(publicRestrictions.deniedTools).toContain('take_screenshot');
      expect(publicRestrictions.deniedTools).toContain('open_application');
    });
  });

  describe('Restriction monotonicity', () => {
    it('should have increasingly restrictive contexts (private < group < public)', () => {
      const privateDenied = CONTEXT_TOOL_RESTRICTIONS['private'].deniedGroups.length +
                           CONTEXT_TOOL_RESTRICTIONS['private'].deniedTools.length;
      const groupDenied = CONTEXT_TOOL_RESTRICTIONS['group'].deniedGroups.length +
                         CONTEXT_TOOL_RESTRICTIONS['group'].deniedTools.length;
      const publicDenied = CONTEXT_TOOL_RESTRICTIONS['public'].deniedGroups.length +
                          CONTEXT_TOOL_RESTRICTIONS['public'].deniedTools.length;

      expect(groupDenied).toBeGreaterThanOrEqual(privateDenied);
      expect(publicDenied).toBeGreaterThanOrEqual(groupDenied);
    });
  });
});
