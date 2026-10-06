/**
 * Token budgets for the memory-related execution prompt sections.
 *
 * The executor requests `MEMORY_CONTEXT_SECTION_TOKENS` from MemorySynthesizer and
 * ContentBuilder caps the `memory_context` section at the same value, so the
 * synthesizer's output is never cut a second time by a smaller section cap.
 * Context that used to be concatenated into the memory section (design system,
 * external profile, transcript hits, repo-level project instructions) has its
 * own section and budget.
 */
export const MEMORY_SYNTHESIS_SLICE_TOKENS = {
  kitContext: 700,
  memoryContext: 700,
  playbookContext: 420,
} as const;

/** Requested synthesizer budget == `memory_context` section cap. */
export const MEMORY_CONTEXT_SECTION_TOKENS =
  MEMORY_SYNTHESIS_SLICE_TOKENS.kitContext +
  MEMORY_SYNTHESIS_SLICE_TOKENS.memoryContext +
  MEMORY_SYNTHESIS_SLICE_TOKENS.playbookContext;

/** Smallest useful memory section; below this the composer drops it instead of shrinking. */
export const MEMORY_CONTEXT_MIN_TOKENS = 400;

/** Workspace DESIGN.md context for UI tasks (the source file is clamped to 7,000 chars). */
export const DESIGN_SYSTEM_SECTION_TOKENS = 1200;
export const DESIGN_SYSTEM_MIN_TOKENS = 400;

/** Repo-root AGENTS.md / CLAUDE.md plus docs map files. */
export const PROJECT_GUIDANCE_SECTION_TOKENS = 1000;
export const PROJECT_GUIDANCE_MIN_TOKENS = 300;

/** External memory provider (Supermemory) profile/search context. */
export const EXTERNAL_MEMORY_SECTION_TOKENS = 400;

/** Transcript span hits selected by the query orchestrator. */
export const TRANSCRIPT_CONTEXT_SECTION_TOKENS = 400;

/**
 * MemoryContextBuilder budgets (the one budget owner for memory_items text).
 * L0: identity, rules, pinned/explicit preferences, open commitments and curated hot
 * memory — the pinned `<cowork_user_profile>` block on step/follow-up turns, the memory
 * section on planning and chat. L1: memory_items recall for the current query; on plan
 * steps it takes the synthesizer's former hot-memory share of `memory_context`.
 */
export const MEMORY_L0_TOKENS = 600;
export const MEMORY_L1_ITEMS_TOKENS = 400;
/** L1 on compact surfaces (planning, chat, follow-up system prompt). */
export const MEMORY_L1_COMPACT_TOKENS = 250;

/**
 * The `<cowork_memory_repo>` block (docs/memory-repo-phase1-design.md §6.1): the memory
 * folder's MEMORY.md (500) plus the current workspace's file (300), then the MEMORY.md of up
 * to 3 team memory repos (300 each, docs/memory-repo-phase4-design.md §2): 1,700 at most.
 */
export const MEMORY_REPO_ENTRY_FILE_TOKENS = 500;
export const MEMORY_REPO_WORKSPACE_FILE_TOKENS = 300;
export const MEMORY_REPO_TEAM_FILE_TOKENS = 300;
export const MEMORY_REPO_MAX_TEAM_REPOS = 3;
export const MEMORY_REPO_TOKENS =
  MEMORY_REPO_ENTRY_FILE_TOKENS +
  MEMORY_REPO_WORKSPACE_FILE_TOKENS +
  MEMORY_REPO_TEAM_FILE_TOKENS * MEMORY_REPO_MAX_TEAM_REPOS;
