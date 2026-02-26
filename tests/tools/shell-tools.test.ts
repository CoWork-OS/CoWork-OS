/**
 * Tests for ShellTools auto-approval of similar commands
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GuardrailManager } from '../../src/electron/guardrails/guardrail-manager';
import { AgentDaemon } from '../../src/electron/agent/daemon';
import { Workspace } from '../../src/shared/types';
import { BuiltinToolsSettingsManager } from '../../src/electron/agent/tools/builtin-settings';
import { ShellTools } from '../../src/electron/agent/tools/shell-tools';

const mockDaemon = {
  requestApproval: vi.fn().mockResolvedValue(true),
  logEvent: vi.fn(),
} as unknown as AgentDaemon;

const mockWorkspace = {
  id: 'test-workspace',
  name: 'Test Workspace',
  path: '/Users/testuser/project',
  permissions: {
    shell: true,
    read: true,
    write: true,
    delete: true,
    network: true,
  },
} as Workspace;

const SAFE_CMD_1 = `"${process.execPath}" -e "process.stdout.write('ok1')"`;
const SAFE_CMD_2 = `"${process.execPath}" -v`;

describe('ShellTools auto-approval', () => {
  let shellTools: ShellTools;

  beforeEach(() => {
    vi.clearAllMocks();
    shellTools = new ShellTools(mockWorkspace, mockDaemon, 'task-1');
    vi.spyOn(GuardrailManager, 'isCommandBlocked').mockReturnValue({ blocked: false });
    vi.spyOn(GuardrailManager, 'isCommandTrusted').mockReturnValue({ trusted: false });
    vi.spyOn(BuiltinToolsSettingsManager, 'getToolAutoApprove').mockReturnValue(false);
    vi.spyOn(BuiltinToolsSettingsManager, 'getRunCommandApprovalMode').mockReturnValue('per_command');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes similar commands to the same signature', () => {
    const shellToolsAny = shellTools as any;
    const sigA = shellToolsAny.getCommandSignature('sips --resampleWidth 1024 "/Users/almarion/Desktop/A.png" --out "/Users/almarion/Desktop/optimized/A.png"');
    const sigB = shellToolsAny.getCommandSignature('sips --resampleWidth 1024 "/Users/almarion/Desktop/B.png" --out "/Users/almarion/Desktop/optimized/B.png"');
    expect(sigA).toBe(sigB);
    expect(sigA).toContain('<arg>');
  });

  it('normalizes near-identical commands with changing numbers and IDs', () => {
    const shellToolsAny = shellTools as any;
    const sigA = shellToolsAny.getCommandSignature(
      'solana airdrop 1 9GdH8UrHJYrwWB3JUck16MuPaAEmNCu3iBnq62Es3GRD --url https://api.devnet.solana.com'
    );
    const sigB = shellToolsAny.getCommandSignature(
      'solana airdrop 2 3KhuzM2PF6GWwWvUy1N5c5QARpGm13GsuPLNZveguqjg --url https://api.devnet.solana.com'
    );
    expect(sigA).toBe(sigB);
    expect(sigA).toContain('<num>');
    expect(sigA).toContain('<id>');
  });

  it('flags dangerous commands as unsafe for auto-approval', () => {
    const shellToolsAny = shellTools as any;
    expect(shellToolsAny.isAutoApprovalSafe('rm -rf "/Users/almarion/Desktop/tmp1"')).toBe(false);
    expect(shellToolsAny.isAutoApprovalSafe('sips --resampleWidth 1024 "/Users/almarion/Desktop/A.png" --out "/Users/almarion/Desktop/optimized/A.png"')).toBe(true);
  });

  it('redacts seed phrases from shell output', () => {
    const shellToolsAny = shellTools as any;
    const output = [
      'Generating a new keypair',
      'Save this seed phrase to recover your new keypair:',
      'winner castle crop major beauty crystal light guilt inmate hat fantasy chair',
      'Done',
    ].join('\n');
    const sanitized = shellToolsAny.sanitizeCommandOutput(output);
    expect(sanitized).toContain('[REDACTED_SEED_PHRASE]');
    expect(sanitized).not.toContain('winner castle crop');
  });

  it('uses a single approval bundle for safe command sequences when enabled', async () => {
    vi.spyOn(BuiltinToolsSettingsManager, 'getRunCommandApprovalMode').mockReturnValue('single_bundle');
    (mockDaemon.requestApproval as any).mockResolvedValue(true);

    const first = await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });
    const second = await shellTools.runCommand(SAFE_CMD_2, { cwd: process.cwd() });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(mockDaemon.requestApproval).toHaveBeenCalledTimes(1);
    expect((mockDaemon.requestApproval as any).mock.calls[0][2]).toContain('single approval bundle');
  });

  it('still requires explicit approval for unsafe commands even with bundle mode', async () => {
    vi.spyOn(BuiltinToolsSettingsManager, 'getRunCommandApprovalMode').mockReturnValue('single_bundle');
    (mockDaemon.requestApproval as any)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const first = await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });
    expect(first.success).toBe(true);

    await expect(shellTools.runCommand('sudo -n true')).rejects.toThrow('User denied command execution');
    expect(mockDaemon.requestApproval).toHaveBeenCalledTimes(2);
    expect((mockDaemon.requestApproval as any).mock.calls[1][2]).toBe('Run command: sudo -n true');
  });

  it('keeps per-command approvals when bundle mode is disabled', async () => {
    vi.spyOn(BuiltinToolsSettingsManager, 'getRunCommandApprovalMode').mockReturnValue('per_command');
    (mockDaemon.requestApproval as any).mockResolvedValue(true);

    const first = await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });
    const second = await shellTools.runCommand(SAFE_CMD_2, { cwd: process.cwd() });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(mockDaemon.requestApproval).toHaveBeenCalledTimes(2);
  });
});
