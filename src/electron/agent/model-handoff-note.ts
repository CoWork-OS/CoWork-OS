import type { LLMMessage } from "./llm/types";

export interface ModelRoute {
  providerType: string;
  modelId: string;
}

export interface ModelHandoff {
  from: ModelRoute;
  to: ModelRoute;
}

const MAX_TURNS_LISTED = 6;
const MAX_TOOLS_PER_TURN = 5;

function isToolResultOnly(message: LLMMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => (block as { type?: string }).type === "tool_result")
  );
}

/**
 * Tool activity per earlier user turn, oldest first, e.g. "turn 2: web_search ×2, write_file".
 * A new user turn starts at each user message that is not just tool results.
 */
export function summarizeEarlierToolActivity(history: readonly LLMMessage[]): string[] {
  const turns: Map<string, number>[] = [];
  let current: Map<string, number> | null = null;
  for (const message of history) {
    if (message.role === "user") {
      if (!isToolResultOnly(message)) {
        current = new Map();
        turns.push(current);
      }
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const toolUse = block as { type?: string; name?: unknown };
      if (toolUse.type !== "tool_use" || typeof toolUse.name !== "string") continue;
      if (!current) {
        current = new Map();
        turns.push(current);
      }
      current.set(toolUse.name, (current.get(toolUse.name) ?? 0) + 1);
    }
  }
  const lines = turns
    .map((tools, index) => ({ tools, turn: index + 1 }))
    .filter(({ tools }) => tools.size > 0)
    .slice(-MAX_TURNS_LISTED)
    .map(({ tools, turn }) => {
      const entries = [...tools.entries()];
      const shown = entries
        .slice(0, MAX_TOOLS_PER_TURN)
        .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
      const extra = entries.length - shown.length;
      return `turn ${turn}: ${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`;
    });
  return lines;
}

/**
 * Note prepended to the first message after a thread moves to a different provider, so the
 * new model knows it is joining mid-conversation and what earlier turns already did.
 */
export function buildModelHandoffNote(
  handoff: ModelHandoff,
  history: readonly LLMMessage[],
): string {
  const lines = [
    `MODEL HANDOFF: Earlier replies in this conversation came from ${handoff.from.providerType}/${handoff.from.modelId}. ` +
      `You are ${handoff.to.providerType}/${handoff.to.modelId}, continuing the same conversation. ` +
      "Treat the earlier turns as your own and build on them instead of starting over.",
  ];
  const activity = summarizeEarlierToolActivity(history);
  if (activity.length > 0) {
    lines.push(`Tools used in earlier turns: ${activity.join("; ")}.`);
  }
  return lines.join("\n");
}
