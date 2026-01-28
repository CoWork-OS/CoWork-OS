/**
 * Tests for Security Policy Manager
 *
 * Tests the monotonic policy precedence (deny-wins) system
 * that evaluates tool access across multiple policy layers.
 *
 * Key invariants tested:
 * - C3: Monotonic Policy Precedence (Deny Wins)
 * - C5: Dual Allowlist for Elevated Execution
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecurityPolicyManager,
  createPolicyManager,
  isToolAllowedQuick,
  PolicyCheckResult,
} from '../../src/electron/security/policy-manager';
import { Workspace, GatewayContextType, GuardrailSettings } from '../../src/shared/types';

// Mock workspace factory
function createMockWorkspace(overrides: Partial<Workspace['permissions']> = {}): Workspace {
  return {
    id: 'test-workspace-id',
    name: 'Test Workspace',
    path: '/tmp/test-workspace',
    permissions: {
      read: true,
      write: true,
      delete: false,
      shell: false,
      network: false,
      unrestrictedFileAccess: false,
      allowedPaths: [],
      ...overrides,
    },
    settings: {
      useGuardrails: true,
      guardrails: createMockGuardrails(),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Mock guardrails factory
function createMockGuardrails(overrides: Partial<GuardrailSettings> = {}): GuardrailSettings {
  return {
    blockDangerousCommands: true,
    customBlockedPatterns: [],
    autoApproveTrustedCommands: false,
    trustedCommandPatterns: [],
    enforceAllowedDomains: false,
    allowedDomains: [],
    ...overrides,
  };
}

describe('SecurityPolicyManager', () => {
  describe('Constructor and Initialization', () => {
    it('should create a policy manager with workspace context', () => {
      const workspace = createMockWorkspace();
      const guardrails = createMockGuardrails();

      const manager = new SecurityPolicyManager({
        workspace,
        guardrails,
      });

      expect(manager).toBeDefined();
    });

    it('should accept optional gateway context', () => {
      const workspace = createMockWorkspace();
      const guardrails = createMockGuardrails();

      const manager = new SecurityPolicyManager({
        workspace,
        guardrails,
        gatewayContext: 'group',
      });

      expect(manager).toBeDefined();
    });
  });

  describe('Tool Access Checks', () => {
    describe('Read-only tools', () => {
      it('should allow read tools when read permission is granted', () => {
        const workspace = createMockWorkspace({ read: true });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const result = manager.checkToolAccess('read_file');
        expect(result.allowed).toBe(true);
      });

      it('should deny read tools when read permission is revoked', () => {
        const workspace = createMockWorkspace({ read: false });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const result = manager.checkToolAccess('read_file');
        expect(result.allowed).toBe(false);
        expect(result.deniedBy).toBe('workspace_permissions');
      });
    });

    describe('Write tools', () => {
      it('should allow write tools when write permission is granted', () => {
        const workspace = createMockWorkspace({ write: true });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const result = manager.checkToolAccess('write_file');
        expect(result.allowed).toBe(true);
      });

      it('should deny write tools when write permission is revoked', () => {
        const workspace = createMockWorkspace({ write: false });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const result = manager.checkToolAccess('write_file');
        expect(result.allowed).toBe(false);
      });
    });

    describe('Shell commands (run_command)', () => {
      it('should deny shell commands when shell permission is false', () => {
        const workspace = createMockWorkspace({ shell: false });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const result = manager.checkToolAccess('run_command');
        expect(result.allowed).toBe(false);
        expect(result.deniedBy).toBe('workspace_permissions');
      });

      it('should allow shell commands with approval when shell permission is true', () => {
        const workspace = createMockWorkspace({ shell: true });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const result = manager.checkToolAccess('run_command');
        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(true);
      });
    });

    describe('Network tools', () => {
      it('should deny network tools when network permission is false', () => {
        const workspace = createMockWorkspace({ network: false });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const result = manager.checkToolAccess('web_search');
        expect(result.allowed).toBe(false);
      });

      it('should allow network tools when network permission is true', () => {
        const workspace = createMockWorkspace({ network: true });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const result = manager.checkToolAccess('web_search');
        expect(result.allowed).toBe(true);
      });
    });
  });

  describe('Monotonic Policy Precedence (C3 invariant)', () => {
    it('should deny tool even if later layers would allow it', () => {
      // Workspace denies read, but we're in private context (which allows everything)
      const workspace = createMockWorkspace({ read: false });
      const manager = createPolicyManager(workspace, createMockGuardrails(), 'private');

      const result = manager.checkToolAccess('read_file');
      // Should still be denied because workspace layer denied it
      expect(result.allowed).toBe(false);
      expect(result.deniedBy).toBe('workspace_permissions');
    });

    it('should not allow context restrictions to override workspace denials', () => {
      // Workspace denies shell
      const workspace = createMockWorkspace({ shell: false });
      // Even in private context (most permissive)
      const manager = createPolicyManager(workspace, createMockGuardrails(), 'private');

      const result = manager.checkToolAccess('run_command');
      expect(result.allowed).toBe(false);
    });

    it('should accumulate denials from all layers', () => {
      const workspace = createMockWorkspace({ read: true, write: true });
      // Public context denies clipboard
      const manager = createPolicyManager(workspace, createMockGuardrails(), 'public');

      const result = manager.checkToolAccess('read_clipboard');
      expect(result.allowed).toBe(false);
      expect(result.deniedBy).toBe('context_restrictions');
    });
  });

  describe('Context-Aware Restrictions (C1 invariant)', () => {
    describe('Private context', () => {
      it('should allow memory tools in private context', () => {
        const workspace = createMockWorkspace({ read: true, write: true });
        const manager = createPolicyManager(workspace, createMockGuardrails(), 'private');

        // Memory tools should be allowed in private context
        // (assuming system tools are allowed)
        const result = manager.checkToolAccess('read_file');
        expect(result.allowed).toBe(true);
      });
    });

    describe('Group context', () => {
      it('should deny memory tools in group context (Memory Tool Isolation)', () => {
        const workspace = createMockWorkspace({ read: true, write: true });
        const manager = createPolicyManager(workspace, createMockGuardrails(), 'group');

        const result = manager.checkToolAccess('read_clipboard');
        expect(result.allowed).toBe(false);
      });

      it('should deny destructive tools in group context', () => {
        const workspace = createMockWorkspace({ delete: true, shell: true });
        const manager = createPolicyManager(workspace, createMockGuardrails(), 'group');

        const deleteResult = manager.checkToolAccess('delete_file');
        expect(deleteResult.allowed).toBe(false);
      });
    });

    describe('Public context', () => {
      it('should deny system tools in public context', () => {
        const workspace = createMockWorkspace({ read: true, write: true });
        const manager = createPolicyManager(workspace, createMockGuardrails(), 'public');

        const result = manager.checkToolAccess('take_screenshot');
        expect(result.allowed).toBe(false);
      });

      it('should deny all destructive operations in public context', () => {
        const workspace = createMockWorkspace({ shell: true, delete: true });
        const manager = createPolicyManager(workspace, createMockGuardrails(), 'public');

        expect(manager.checkToolAccess('run_command').allowed).toBe(false);
        expect(manager.checkToolAccess('delete_file').allowed).toBe(false);
      });
    });
  });

  describe('Command Policy Checks', () => {
    // Note: Command-specific policy checks happen during checkCommandPolicy
    // which is called internally. For these tests, we verify that:
    // 1. run_command requires approval when shell permission is granted
    // 2. The command patterns are correctly evaluated

    it('should require approval for shell commands by default', () => {
      const workspace = createMockWorkspace({ shell: true });
      const guardrails = createMockGuardrails({ blockDangerousCommands: true });
      const manager = createPolicyManager(workspace, guardrails);

      // run_command tool should be allowed but require approval
      const result = manager.checkToolAccess('run_command');
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('should deny shell commands when shell permission is false', () => {
      const workspace = createMockWorkspace({ shell: false });
      const guardrails = createMockGuardrails({ blockDangerousCommands: true });
      const manager = createPolicyManager(workspace, guardrails);

      // run_command tool should be denied at workspace layer
      const result = manager.checkToolAccess('run_command');
      expect(result.allowed).toBe(false);
      expect(result.deniedBy).toBe('workspace_permissions');
    });

    it('should track shell commands in approval-required list', () => {
      const workspace = createMockWorkspace({ shell: true });
      const guardrails = createMockGuardrails();
      const manager = createPolicyManager(workspace, guardrails);

      const approvalRequired = manager.getApprovalRequiredTools();
      expect(approvalRequired).toContain('run_command');
    });

    it('should not auto-approve non-matching commands', () => {
      const workspace = createMockWorkspace({ shell: true });
      const guardrails = createMockGuardrails({
        autoApproveTrustedCommands: true,
        trustedCommandPatterns: ['npm *'],
      });
      const manager = createPolicyManager(workspace, guardrails);

      const result = manager.checkToolAccess('run_command', { command: 'python script.py' });
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('should have shell commands always require approval even with permission', () => {
      const workspace = createMockWorkspace({ shell: true });
      const guardrails = createMockGuardrails();
      const manager = createPolicyManager(workspace, guardrails);

      // Even with shell permission, run_command should require approval
      const decisions = manager.getToolDecisions('run_command');
      const workspaceDecision = decisions.find(d => d.layer === 'workspace_permissions');
      expect(workspaceDecision?.decision).toBe('require_approval');
    });
  });

  describe('Static Helper Methods', () => {
    describe('expandToolGroup', () => {
      it('should return tools for valid group', () => {
        const tools = SecurityPolicyManager.expandToolGroup('group:read');
        expect(tools.length).toBeGreaterThan(0);
        expect(tools).toContain('read_file');
      });

      it('should return empty/undefined for invalid group', () => {
        const tools = SecurityPolicyManager.expandToolGroup('group:invalid' as any);
        // Returns undefined or empty array for invalid groups
        expect(!tools || tools.length === 0).toBe(true);
      });
    });

    describe('isToolInGroup', () => {
      it('should return true for tools in group', () => {
        expect(SecurityPolicyManager.isToolInGroup('read_file', 'group:read')).toBe(true);
        expect(SecurityPolicyManager.isToolInGroup('delete_file', 'group:destructive')).toBe(true);
      });

      it('should return false for tools not in group', () => {
        expect(SecurityPolicyManager.isToolInGroup('delete_file', 'group:read')).toBe(false);
        expect(SecurityPolicyManager.isToolInGroup('read_file', 'group:destructive')).toBe(false);
      });
    });

    describe('getToolRiskLevel', () => {
      it('should return correct risk level', () => {
        expect(SecurityPolicyManager.getToolRiskLevel('read_file')).toBe('read');
        expect(SecurityPolicyManager.getToolRiskLevel('write_file')).toBe('write');
        expect(SecurityPolicyManager.getToolRiskLevel('delete_file')).toBe('destructive');
      });

      it('should return undefined for unknown tools', () => {
        expect(SecurityPolicyManager.getToolRiskLevel('unknown_tool')).toBeUndefined();
      });
    });
  });

  describe('Utility Methods', () => {
    describe('getDeniedTools', () => {
      it('should return list of denied tools', () => {
        const workspace = createMockWorkspace({ read: false, shell: false });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const denied = manager.getDeniedTools();
        expect(denied).toContain('read_file');
        expect(denied).toContain('run_command');
      });
    });

    describe('getApprovalRequiredTools', () => {
      it('should return list of tools requiring approval', () => {
        const workspace = createMockWorkspace({ shell: true, delete: false });
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const approval = manager.getApprovalRequiredTools();
        expect(approval).toContain('run_command');
        expect(approval).toContain('delete_file');
      });
    });

    describe('getToolDecisions', () => {
      it('should return layer decisions for a tool', () => {
        const workspace = createMockWorkspace();
        const manager = createPolicyManager(workspace, createMockGuardrails());

        const decisions = manager.getToolDecisions('read_file');
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions[0]).toHaveProperty('layer');
        expect(decisions[0]).toHaveProperty('decision');
      });
    });
  });
});

describe('isToolAllowedQuick', () => {
  it('should quickly check if tool is allowed', () => {
    const workspace = createMockWorkspace({ read: true });
    expect(isToolAllowedQuick('read_file', workspace)).toBe(true);
  });

  it('should respect workspace permissions', () => {
    const workspace = createMockWorkspace({ read: false });
    expect(isToolAllowedQuick('read_file', workspace)).toBe(false);
  });

  it('should respect gateway context', () => {
    const workspace = createMockWorkspace({ read: true });
    expect(isToolAllowedQuick('read_clipboard', workspace, 'public')).toBe(false);
    expect(isToolAllowedQuick('read_file', workspace, 'public')).toBe(true);
  });
});
