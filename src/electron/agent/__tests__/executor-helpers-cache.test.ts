import { describe, expect, it } from 'vitest';
import { FileOperationTracker, ToolCallDeduplicator } from '../executor-helpers';

describe('ToolCallDeduplicator read-history invalidation', () => {
  it('clears read/list duplicate history while preserving write history', () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 4, 20);

    dedupe.recordCall('read_file', { path: 'doc.md' }, '{"content":"a"}');
    dedupe.recordCall('read_file', { path: 'doc.md' }, '{"content":"a"}');
    dedupe.recordCall('write_file', { path: 'doc.md', content: 'x' }, '{"success":true}');
    dedupe.recordCall('write_file', { path: 'doc.md', content: 'x' }, '{"success":true}');

    expect(dedupe.checkDuplicate('read_file', { path: 'doc.md' }).isDuplicate).toBe(true);
    expect(dedupe.checkDuplicate('write_file', { path: 'doc.md', content: 'x' }).isDuplicate).toBe(true);

    dedupe.clearReadOnlyHistory();

    expect(dedupe.checkDuplicate('read_file', { path: 'doc.md' }).isDuplicate).toBe(false);
    expect(dedupe.checkDuplicate('write_file', { path: 'doc.md', content: 'x' }).isDuplicate).toBe(true);
  });
});

describe('FileOperationTracker cache invalidation', () => {
  it('invalidates read cache for a modified file', () => {
    const tracker = new FileOperationTracker();

    tracker.recordFileRead('NexusChain-Whitepaper.md', 'one');
    tracker.recordFileRead('NexusChain-Whitepaper.md', 'two');

    expect(tracker.checkFileRead('NexusChain-Whitepaper.md').blocked).toBe(true);

    tracker.invalidateFileRead('NexusChain-Whitepaper.md');

    expect(tracker.checkFileRead('NexusChain-Whitepaper.md').blocked).toBe(false);
  });

  it('invalidates directory listing cache after filesystem changes', () => {
    const tracker = new FileOperationTracker();

    tracker.recordDirectoryListing('research', ['01-state-of-the-art-research.md']);
    tracker.recordDirectoryListing('research', ['01-state-of-the-art-research.md']);

    expect(tracker.checkDirectoryListing('research').blocked).toBe(true);

    tracker.invalidateDirectoryListing('research');

    expect(tracker.checkDirectoryListing('research').blocked).toBe(false);
  });
});
