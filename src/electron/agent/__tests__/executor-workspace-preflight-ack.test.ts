import { describe, it, expect, vi } from 'vitest';
import { TaskExecutor } from '../executor';
import { TEMP_WORKSPACE_ID } from '../../../shared/types';

describe('TaskExecutor workspace preflight acknowledgement', () => {
  it('pauses on workspace mismatch when acknowledgement is not set', () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: any = {
      shouldPauseForQuestions: true,
      workspacePreflightAcknowledged: false,
      task: { prompt: 'Fix a bug in src/app.ts', id: 't1' },
      workspace: { isTemp: false, id: 'ws1' },
      classifyWorkspaceNeed: vi.fn(() => 'needs_existing'),
      getWorkspaceSignals: vi.fn(() => ({ hasProjectMarkers: false, hasCodeFiles: false, hasAppDirs: false })),
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
      shouldPauseForQuestions: true,
      workspacePreflightAcknowledged: true,
      task: { prompt: 'Fix a bug in src/app.ts', id: 't1' },
      workspace: { isTemp: false, id: 'ws1' },
      classifyWorkspaceNeed: vi.fn(() => 'needs_existing'),
      getWorkspaceSignals: vi.fn(() => ({ hasProjectMarkers: false, hasCodeFiles: false, hasAppDirs: false })),
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
  });

  it('applies to temp workspace gates as well', () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: any = {
      shouldPauseForQuestions: true,
      workspacePreflightAcknowledged: false,
      task: { prompt: 'Fix a bug in src/app.ts', id: 't1' },
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID },
      classifyWorkspaceNeed: vi.fn(() => 'needs_existing'),
      getWorkspaceSignals: vi.fn(() => ({ hasProjectMarkers: false, hasCodeFiles: false, hasAppDirs: false })),
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(true);
    expect(pauseForUserInput).toHaveBeenCalledTimes(1);
    expect(pauseForUserInput.mock.calls[0][1]).toBe('workspace_required');
  });
});
