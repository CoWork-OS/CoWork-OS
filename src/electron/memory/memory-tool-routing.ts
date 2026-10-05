/**
 * Routing guidance for the agent's memory tools (audit §8.3, RECALL-2): one short hint,
 * generated from the tools that are actually visible, so it never names a tool the model
 * cannot call. Shared by the prompt synthesizer and the tool registry. No runtime imports.
 */

export const MEMORY_RECALL_TOOL = "memory_recall";
export const MEMORY_REMEMBER_TOOL = "memory_remember";
export const MEMORY_FORGET_TOOL = "memory_forget";
export const CONTEXT_RECALL_TOOL = "context_recall";

/** The consolidated memory tools, in the order the hint lists them. */
export const MEMORY_TOOL_ROUTES: ReadonlyArray<readonly [tool: string, use: string]> = [
  [
    MEMORY_RECALL_TOOL,
    'past facts, decisions, earlier tasks, notes; index, then detail:"full" + ids',
  ],
  [MEMORY_REMEMBER_TOOL, "save what later tasks need, as you learn it"],
  [MEMORY_FORGET_TOOL, "delete a wrong or unwanted memory"],
  [CONTEXT_RECALL_TOOL, "this task's details lost to compaction"],
];

/** Hard cap of the hint, in estimated tokens (chars / 4). */
export const MEMORY_ROUTING_HINT_MAX_TOKENS = 100;

/**
 * `<cowork_recall_hints>` naming each visible memory tool and when to use it, or "" when
 * none is visible. At most MEMORY_ROUTING_HINT_MAX_TOKENS.
 */
export function buildMemoryToolRoutingHint(visibleToolNames: Iterable<string>): string {
  const visible = new Set(visibleToolNames);
  const lines = MEMORY_TOOL_ROUTES.filter(([tool]) => visible.has(tool)).map(
    ([tool, use]) => `- \`${tool}\`: ${use}`,
  );
  if (lines.length === 0) return "";
  const hint = [
    "<cowork_recall_hints>",
    "Memory tools (injected memory is only a summary):",
    ...lines,
    "</cowork_recall_hints>",
  ].join("\n");
  const maxChars = MEMORY_ROUTING_HINT_MAX_TOKENS * 4;
  return hint.length <= maxChars ? hint : "";
}
