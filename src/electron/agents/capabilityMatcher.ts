import type { AgentRole, AgentCapability } from "../../shared/types";
import { LLMProviderFactory } from "../agent/llm/provider-factory";
import type { LLMProvider } from "../agent/llm/types";

/**
 * Keyword-based capability detection signals (used as fallback).
 * Maps each agent capability to a regex that detects relevant task content.
 */
const CAPABILITY_SIGNALS: Record<AgentCapability, RegExp> = {
  code: /\b(code|implement|build|develop|program|function|class|api|endpoint|refactor|fix|bug|script|module)\b/i,
  review: /\b(review|audit|check|inspect|quality|PR|pull.?request|feedback|critique)\b/i,
  test: /\b(test|spec|coverage|unit.?test|integration|e2e|QA|regression)\b/i,
  design: /\b(design|UI|UX|mockup|wireframe|layout|component|visual|interface)\b/i,
  research: /\b(research|investigate|explore|compare|evaluate|discover|survey|study)\b/i,
  analyze: /\b(analy[sz]e|data|metrics|insight|trend|pattern|benchmark|performance|profil)\b/i,
  plan: /\b(plan|architect|structure|system.?design|roadmap|strategy|approach)\b/i,
  document: /\b(document|docs|readme|guide|tutorial|explanation)\b/i,
  write: /\b(write|content|blog|article|copy|email|newsletter|draft)\b/i,
  security: /\b(security|vulnerab|CVE|auth|encrypt|permission|OWASP|threat)\b/i,
  ops: /\b(deploy|CI.?CD|docker|kubernetes|pipeline|infrastructure|monitoring|devops)\b/i,
  communicate: /\b(communicate|customer|support|outreach|respond)\b/i,
  market: /\b(market|campaign|growth|SEO|social.?media|brand|advertis)\b/i,
  manage: /\b(manage|coordinate|timeline|sprint|milestone|project|priorit)\b/i,
  product: /\b(product|feature|user.?story|backlog|requirement|stakeholder)\b/i,
};

// ---------------------------------------------------------------------------
// LLM-based team selection
// ---------------------------------------------------------------------------

interface LLMTeamSelection {
  memberIds: string[];
  leaderId: string;
}

/**
 * Ask the LLM to pick the right team members and leader for a given task.
 * Returns `null` when the LLM call fails or returns unparseable output so the
 * caller can fall back to keyword matching.
 */
async function selectViaLLM(
  prompt: string,
  activeRoles: AgentRole[],
): Promise<LLMTeamSelection | null> {
  let provider: LLMProvider;
  let model: string;
  try {
    provider = LLMProviderFactory.createProvider();
    model = LLMProviderFactory.getSelectedModel();
  } catch {
    return null;
  }

  const agentDescriptions = activeRoles
    .map(
      (r) =>
        `- id: "${r.id}" | name: "${r.displayName}" | capabilities: [${r.capabilities.join(", ")}]${r.description ? ` | description: ${r.description}` : ""}`,
    )
    .join("\n");

  const systemPrompt = [
    "You are a team composition advisor. Given a task and a list of available agents, select the most appropriate team.",
    "",
    "Rules:",
    "- First identify the PRIMARY action of the task (writing, coding, research, design, etc.).",
    "- ALWAYS include the agent whose core specialization matches the primary action. E.g. a writing task MUST include a writer, a coding task MUST include a coder.",
    "- Then add agents that complement with relevant secondary skills (research, review, domain expertise).",
    "- Pick between 2 and 5 agents depending on task complexity.",
    "- Simple, single-domain tasks need only 2-3 agents.",
    "- Complex, multi-domain tasks may need up to 5.",
    "- Pick a leader who can best coordinate and synthesize the work — usually the agent with the primary skill.",
    "- Do NOT pick agents with only tangential relevance. A marketing agent is not a writer. A coder is not a researcher.",
    "",
    "Respond with ONLY a JSON object (no markdown fences, no explanation):",
    '{ "memberIds": ["id1", "id2", ...], "leaderId": "id1" }',
  ].join("\n");

  const userMessage = ["AVAILABLE AGENTS:", agentDescriptions, "", "TASK:", prompt].join("\n");

  try {
    const response = await provider.createMessage({
      model,
      maxTokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    // Extract text from response
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    // Parse JSON — strip markdown fences if present
    const cleaned = text
      .replace(/```json?\s*/gi, "")
      .replace(/```/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as LLMTeamSelection;

    // Validate: memberIds must be an array of known IDs
    const roleIdSet = new Set(activeRoles.map((r) => r.id));
    if (!Array.isArray(parsed.memberIds) || parsed.memberIds.length < 2) return null;
    const validMembers = parsed.memberIds.filter((id) => roleIdSet.has(id));
    if (validMembers.length < 2) return null;

    const leaderId =
      parsed.leaderId && roleIdSet.has(parsed.leaderId) ? parsed.leaderId : validMembers[0];

    // Ensure leader is in members
    if (!validMembers.includes(leaderId)) {
      validMembers.push(leaderId);
    }

    return { memberIds: validMembers, leaderId };
  } catch (err) {
    console.error("[capabilityMatcher] LLM selection failed, falling back:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Keyword-based fallback
// ---------------------------------------------------------------------------

function selectViaKeywords(
  prompt: string,
  activeRoles: AgentRole[],
): { members: AgentRole[]; leader: AgentRole } {
  // Detect which capabilities the prompt needs
  const detected = new Set<AgentCapability>();
  for (const [cap, pattern] of Object.entries(CAPABILITY_SIGNALS)) {
    if (pattern.test(prompt)) detected.add(cap as AgentCapability);
  }

  // Simple heuristic sizing
  let max = 3;
  if (detected.size >= 5) max = 5;
  else if (detected.size >= 3) max = 4;
  const min = Math.max(2, max - 1);

  // Score agents by how many detected capabilities they cover
  const scored = activeRoles
    .map((role) => ({
      role,
      score: role.capabilities.filter((c) => detected.has(c)).length,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const members = scored.slice(0, max).map((s) => s.role);

  // Pad with general-purpose agents if under minimum
  if (members.length < min) {
    const remaining = activeRoles
      .filter((r) => !members.some((m) => m.id === r.id))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    members.push(...remaining.slice(0, min - members.length));
  }

  // Select leader: prefer "lead" autonomy among selected, else fallback
  const leader =
    members.find((m) => m.autonomyLevel === "lead") ||
    activeRoles.find((r) => r.name === "architect") ||
    activeRoles.find((r) => r.name === "project_manager") ||
    members[0];

  if (leader && !members.some((m) => m.id === leader.id)) {
    members.push(leader);
  }

  return { members, leader: leader! };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Selects the best-fit agents for a task.
 *
 * Uses the configured LLM to analyze task complexity and pick agents.
 * Falls back to keyword-based matching if the LLM call fails.
 */
export async function selectAgentsForTask(
  prompt: string,
  allRoles: AgentRole[],
): Promise<{ members: AgentRole[]; leader: AgentRole }> {
  const active = allRoles.filter((r) => r.isActive);
  if (active.length === 0) {
    throw new Error("No active agent roles available for team selection");
  }

  // Try LLM-based selection first
  const llmResult = await selectViaLLM(prompt, active);

  if (llmResult) {
    const roleMap = new Map(active.map((r) => [r.id, r]));
    const members = llmResult.memberIds
      .map((id) => roleMap.get(id))
      .filter((r): r is AgentRole => r != null);
    const leader = roleMap.get(llmResult.leaderId) || members[0];
    if (members.length >= 2) {
      return { members, leader };
    }
  }

  // Fallback to keyword matching
  return selectViaKeywords(prompt, active);
}
