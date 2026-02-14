import { describe, it, expect, vi } from 'vitest';
import { TaskExecutor } from '../executor';
import { TEMP_WORKSPACE_ID } from '../../../shared/types';

describe('TaskExecutor workspace preflight acknowledgement', () => {
  const buildBase = () => ({
    shouldPauseForQuestions: true,
    workspacePreflightAcknowledged: false,
    capabilityUpgradeRequested: false,
    isInternalAppOrToolChangeIntent: vi.fn(() => false),
    tryAutoSwitchToPreferredWorkspaceForAmbiguousTask: vi.fn(() => false),
    task: { prompt: 'Fix a bug in src/app.ts', id: 't1' },
    classifyWorkspaceNeed: vi.fn(() => 'needs_existing'),
    getWorkspaceSignals: vi.fn(() => ({ hasProjectMarkers: false, hasCodeFiles: false, hasAppDirs: false })),
  });

  it('pauses on workspace mismatch when acknowledgement is not set', () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: any = {
      ...buildBase(),
      workspace: { isTemp: false, id: 'ws1' },
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(true);
    expect(pauseForUserInput).toHaveBeenCalledTimes(1);
    expect(pauseForUserInput.mock.calls[0][1]).toBe('workspace_mismatch');
  });

  it('does not re-pause once the user acknowledged the preflight warning', () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: any = {
      ...buildBase(),
      workspacePreflightAcknowledged: true,
      workspace: { isTemp: false, id: 'ws1' },
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
  });

  it('applies to temp workspace gates as well', () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: any = {
      ...buildBase(),
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID },
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(true);
    expect(pauseForUserInput).toHaveBeenCalledTimes(1);
    expect(pauseForUserInput.mock.calls[0][1]).toBe('workspace_required');
  });

  it('does not pause for ambiguous coding requests in temporary workspace', () => {
    const pauseForUserInput = vi.fn();
    const tryAutoSwitch = vi.fn(() => false);
    const fakeThis: any = {
      ...buildBase(),
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID },
      classifyWorkspaceNeed: vi.fn(() => 'ambiguous'),
      tryAutoSwitchToPreferredWorkspaceForAmbiguousTask: tryAutoSwitch,
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
    expect(tryAutoSwitch).toHaveBeenCalledTimes(1);
  });

  it('does not pause when capability upgrade intent is active', () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: any = {
      ...buildBase(),
      capabilityUpgradeRequested: true,
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID },
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
  });

  it('does not pause for internal app/tool change intent in temporary workspace', () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: any = {
      ...buildBase(),
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID },
      isInternalAppOrToolChangeIntent: vi.fn(() => true),
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
  });

  it('auto-switches to the preferred non-temp workspace for ambiguous temp tasks', () => {
    const preferredWorkspace = {
      id: 'ws-preferred',
      name: 'Preferred',
      path: process.cwd(),
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    };
    const fakeThis: any = {
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID, path: process.cwd() },
      task: { id: 't1', workspaceId: TEMP_WORKSPACE_ID },
      sandboxRunner: null,
      toolRegistry: { setWorkspace: vi.fn() },
      daemon: {
        getMostRecentNonTempWorkspace: vi.fn(() => preferredWorkspace),
        updateTaskWorkspace: vi.fn(),
        logEvent: vi.fn(),
      },
      getWorkspaceSignalsForPath: vi.fn(() => ({
        hasProjectMarkers: true,
        hasCodeFiles: false,
        hasAppDirs: false,
      })),
    };

    const switched = (TaskExecutor as any).prototype.tryAutoSwitchToPreferredWorkspaceForAmbiguousTask.call(
      fakeThis,
      'ambiguous_temp_workspace'
    );

    expect(switched).toBe(true);
    expect(fakeThis.workspace.id).toBe('ws-preferred');
    expect(fakeThis.task.workspaceId).toBe('ws-preferred');
    expect(fakeThis.toolRegistry.setWorkspace).toHaveBeenCalledWith(preferredWorkspace);
    expect(fakeThis.daemon.updateTaskWorkspace).toHaveBeenCalledWith('t1', 'ws-preferred');
  });
});
