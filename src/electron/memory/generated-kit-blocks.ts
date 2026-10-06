/**
 * The retired generated blocks of the workspace kit files (docs/memory-engine.md §5, §7a):
 * the curated blocks of `.cowork/USER.md` / `.cowork/MEMORY.md` (rendered views of
 * memory_items), the milestone block of `.cowork/LORE.md` and the feedback-pattern block of
 * `.cowork/MISTAKES.md` (its patterns are corrections in the memory folder now). The prompt
 * strips them from kit text (WorkspaceKitContext, the shared-context block) and a one-time
 * pass removes them from the files (kit-block-strip.ts). Pure, so both can share it.
 */

/** The MISTAKES.md feedback-pattern block; still written when the memory folder is off. */
export const MISTAKES_AUTO_BLOCK = [
  "<!-- cowork:auto:mistakes:start -->",
  "<!-- cowork:auto:mistakes:end -->",
] as const;

export const GENERATED_MEMORY_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["<!-- cowork:auto:curated-user:start -->", "<!-- cowork:auto:curated-user:end -->"],
  ["<!-- cowork:auto:curated-workspace:start -->", "<!-- cowork:auto:curated-workspace:end -->"],
  ["<!-- cowork:auto:lore:start -->", "<!-- cowork:auto:lore:end -->"],
  MISTAKES_AUTO_BLOCK,
];

export interface RemoveGeneratedBlocksOptions {
  /**
   * Keep the MISTAKES.md feedback-pattern block: with the memory folder off it is still
   * the live fallback that FeedbackService writes, so it must be neither stripped from the
   * file nor from the prompt.
   */
  keepFeedbackPatterns?: boolean;
}

/**
 * Remove every generated block, start marker through end marker plus one newline after
 * it. A start marker without an end marker (a block cut by truncation or a hand edit) is
 * removed through the end of the text. Everything else is returned unchanged.
 */
export function removeGeneratedMemoryBlocks(
  markdown: string,
  options: RemoveGeneratedBlocksOptions = {},
): string {
  let out = markdown;
  for (const block of GENERATED_MEMORY_BLOCKS) {
    if (options.keepFeedbackPatterns && block === MISTAKES_AUTO_BLOCK) continue;
    const [start, end] = block;
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
