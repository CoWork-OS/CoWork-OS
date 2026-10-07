import type { AgentRole } from "../../shared/types";

/** Built from verified workspace/team membership, never from a seeded roster. */
export interface BotTeamPromptContext {
  teamName: string;
  isLead: boolean;
  peers: Array<Pick<AgentRole, "id" | "name" | "displayName">>;
}

export function buildBotTeamContextPrompt(context: BotTeamPromptContext): string {
  const lines = [
    "PERSISTENT BOT TEAM:",
    `This conversation belongs to the configured team ${JSON.stringify(context.teamName)}.`,
    "Use send_agent_message with bot= to delegate or report durable teammate updates within this team.",
    context.peers.length
      ? `Configured teammates: ${context.peers.map((peer) => `${JSON.stringify(peer.displayName)} (bot=${JSON.stringify(peer.id)}, handle=${JSON.stringify(peer.name)})`).join("; ")}.`
      : "No other active bot is configured in this team.",
  ];
  if (context.isLead) {
    lines.push(
      "As the configured team lead, delegate focused work when requested, wait for durable replies, and summarize only received results.",
    );
  }
  lines.push(
    "For any inbound teammate handoff, do the focused work and send exactly one concise result back to the actual requesting teammate, including evidence and blockers. Prefer send_agent_message with task_id from the [NEW TEAMMATE HANDOFF] boundary so the durable reply is correlated; otherwise use that teammate's bot ID. Never route a reply to another bot merely because it is the lead.",
    "A [CORRELATED TEAM REPLY] is a delivery receipt for your own earlier handoff, not a new request. Do not send another message for it or start a reply loop; finish the turn after recording the received result. Only message again when the receipt explicitly contains a new action request.",
    "Never claim that a teammate completed work without a durable reply or visible result.",
  );
  return lines.join("\n");
}

/** Recognize configured identities without granting any messaging authority. */
export function hasBotTeamDelegationRequest(text: string, context?: BotTeamPromptContext): boolean {
  if (/\b(?:send_agent_message|delegat(?:e|es|ed|ing|ion)|teammate|bot team)\b/i.test(text)) {
    return true;
  }
  const selectors = context?.peers.flatMap((peer) => [peer.id, peer.name, peer.displayName]) || [];
  return selectors.some((selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`\\bask\\s+(?:the\\s+)?@?${escaped}(?=$|[^\\p{L}\\p{N}_-])`, "iu").test(text);
  });
}
