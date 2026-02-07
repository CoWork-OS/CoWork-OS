import { describe, it, expect } from 'vitest';
import { TaskExecutor } from '../executor';

describe('TaskExecutor workspace preflight classification', () => {
  const classify = (prompt: string) =>
    (TaskExecutor as any).prototype.classifyWorkspaceNeed.call({}, prompt) as
      | 'none'
      | 'new_ok'
      | 'ambiguous'
      | 'needs_existing';

  it('does not treat new markdown file creation as "needs_existing"', () => {
    expect(classify('Create a NEW markdown file named notes.md in this folder')).toBe('new_ok');
  });

  it('still detects existing project work when prompt includes repo + update', () => {
    expect(classify('Update README.md in this repo')).toBe('needs_existing');
  });

  it('detects existing code work when prompt includes a code file path', () => {
    expect(classify('Fix a bug in src/app.ts')).toBe('needs_existing');
  });
});

