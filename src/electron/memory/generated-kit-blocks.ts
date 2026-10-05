/**
 * The retired generated memory blocks of `.cowork/USER.md` / `.cowork/MEMORY.md`
 * (docs/memory-engine.md §5): rendered views of memory_items, no longer written. The
 * prompt strips them from kit text (WorkspaceKitContext) and a one-time pass removes them
 * from the files (kit-block-strip.ts). Pure, so both can share it.
 */

export const GENERATED_MEMORY_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["<!-- cowork:auto:curated-user:start -->", "<!-- cowork:auto:curated-user:end -->"],
  ["<!-- cowork:auto:curated-workspace:start -->", "<!-- cowork:auto:curated-workspace:end -->"],
];

/**
 * Remove every generated block, start marker through end marker plus one newline after
 * it. A start marker without an end marker (a block cut by truncation or a hand edit) is
 * removed through the end of the text. Everything else is returned unchanged.
 */
export function removeGeneratedMemoryBlocks(markdown: string): string {
  let out = markdown;
  for (const [start, end] of GENERATED_MEMORY_BLOCKS) {
    for (let startAt = out.indexOf(start); startAt !== -1; startAt = out.indexOf(start)) {
      const endAt = out.indexOf(end, startAt + start.length);
      out =
        endAt === -1
          ? out.slice(0, startAt)
          : `${out.slice(0, startAt)}${out.slice(endAt + end.length).replace(/^\n/, "")}`;
    }
  }
  return out;
}
