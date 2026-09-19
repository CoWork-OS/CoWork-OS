import type { AgentRole, AgentCapability } from "../../shared/types";
import { LLMProviderFactory } from "../agent/llm/provider-factory";
import type { LLMProvider } from "../agent/llm/types";
import { recordLlmCallError, recordLlmCallSuccess } from "../agent/llm/usage-telemetry";
import { createConfiguredJevProvider } from "../agent/jev";
import {
  createDecisionService,
  redactDecisionText,
  type JevDecisionTelemetryContext,
} from "../agent/decisions";
import type { JevNoulAnswer, JevQuestion } from "../agent/decisions";

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
  model: string;
}

const JEV_CANDIDATE_LIMIT = 8;
const JEV_LEADER_MIN_CONFIDENCE = 0.85;
const JEV_LEADER_MIN_PROBABILITY = 0.6;
const JEV_MEMBER_MIN_PROBABILITY = 0.75;

interface JevTeamSelection {
  memberIds: string[];
  leaderId: string;
  model: string;
}

export type AgentSelectionSource = "jev" | "chat_model" | "keyword" | "keyword_active";

export interface AgentSelectionResult {
  members: AgentRole[];
  leader: AgentRole;
  source: AgentSelectionSource;
  decisionModel?: string;
}

function rankJevCandidates(prompt: string, activeRoles: AgentRole[]): AgentRole[] {
  const detected = new Set<AgentCapability>();
  for (const [capability, pattern] of Object.entries(CAPABILITY_SIGNALS)) {
    if (pattern.test(prompt)) detected.add(capability as AgentCapability);
  }

  return activeRoles
    .map((role) => ({
      role,
      score: role.capabilities.filter((capability) => detected.has(capability)).length,
    }))
    .sort((a, b) => b.score - a.score || a.role.sortOrder - b.role.sortOrder)
    .slice(0, JEV_CANDIDATE_LIMIT)
    .map(({ role }) => role);
}

function buildJevQuestions(candidates: AgentRole[]): Record<string, JevQuestion> {
  const leaderCriteria: Record<string, string> = {
    none: "No candidate is a clear fit for leading this task.",
  };
  for (const role of candidates) {
    leaderCriteria[role.id] =
      "Choose " +
      redactDecisionText(role.displayName, 120) +
      " when this role is the best primary specialist and coordinator for the task.";
  }

  const questions: Record<string, JevQuestion> = {
    leader: {
      type: "choice",
      instructions: "Which active candidate should lead this task?",
      criteria: leaderCriteria,
    },
  };

  candidates.forEach((role, index) => {
    questions["include_" + index] = {
      type: "noul",
      instructions:
        "Should " +
        redactDecisionText(role.displayName, 120) +
        " participate in the team for this task?",
      criteria: {
        true: "The role provides a necessary, non-duplicative contribution.",
        false: "The role is tangential, redundant, or unrelated.",
      },
    };
  });

  return questions;
}

async function selectViaJev(
  prompt: string,
  activeRoles: AgentRole[],
  maxAgents?: number,
  telemetryContext?: JevDecisionTelemetryContext,
): Promise<JevTeamSelection | null> {
  if (maxAgents === 1) return null;

  let resolved;
  try {
    const settings = LLMProviderFactory.loadSettings();
    const jevSettings = settings.jev;
    const teamSelectionEnabled =
      jevSettings?.teamSelectionEnabled === true ||
      (jevSettings?.enabled === true &&
        jevSettings.harnessEnabled === true &&
        jevSettings.toolReviewMode === "active");
    if (!teamSelectionEnabled) return null;
    resolved = createConfiguredJevProvider(settings);
  } catch {
    return null;
  }
  if (!resolved) return null;

  const candidates = rankJevCandidates(prompt, activeRoles);
  if (candidates.length < 2) return null;

  const decisionService = createDecisionService(resolved.provider, {
    model: resolved.model,
    providerType: resolved.providerType,
    telemetryContext,
    timeoutMs: 1_000,
    maxRetries: 0,
    maxCalls: 1,
    maxConcurrent: 1,
    cache: { enabled: true, ttlMs: 5_000, maxEntries: 4 },
  });

  const candidateByQuestion = new Map(
    candidates.map((role, index) => ["include_" + index, role] as const),
  );
  const state = {
    task: redactDecisionText(prompt, 8_000),
    requestedAgentCount: maxAgents ?? null,
    candidates: candidates.map((role) => ({
      id: redactDecisionText(role.id, 120),
      name: redactDecisionText(role.displayName, 120),
      description: redactDecisionText(role.description || "", 600),
      capabilities: role.capabilities,
      autonomyLevel: redactDecisionText(role.autonomyLevel || "", 80),
    })),
  };

  try {
    const serviceResult = await decisionService.decide(
      {
        state,
        model: resolved.model,
        questions: buildJevQuestions(candidates),
      },
      { purpose: "team-selection", timeoutMs: 1_000, maxRetries: 0 },
    );
    if (serviceResult.status !== "success" || !serviceResult.response) return null;
    const response = serviceResult.response;
    const leaderAnswer = response.answers.leader;
    if (
      !leaderAnswer ||
      leaderAnswer.type !== "choice" ||
      leaderAnswer.choice === "none" ||
      leaderAnswer.confidence < JEV_LEADER_MIN_CONFIDENCE ||
      (leaderAnswer.probabilities[leaderAnswer.choice] ?? 0) < JEV_LEADER_MIN_PROBABILITY
    ) {
      return null;
    }

    const roleIds = new Set(candidates.map((role) => role.id));
    if (!roleIds.has(leaderAnswer.choice)) return null;

    const selectedIds = new Set<string>([leaderAnswer.choice]);
    for (const [questionId, answer] of Object.entries(response.answers)) {
      const role = candidateByQuestion.get(questionId);
      if (!role || answer.type !== "noul") continue;
      const noulAnswer = answer as JevNoulAnswer;
      if (noulAnswer.noul >= JEV_MEMBER_MIN_PROBABILITY) selectedIds.add(role.id);
    }

    const orderedIds = [
      leaderAnswer.choice,
      ...candidates.map((role) => role.id).filter((id) => id !== leaderAnswer.choice),
    ].filter((id) => selectedIds.has(id));
    const boundedIds =
      maxAgents != null && maxAgents >= 1 ? orderedIds.slice(0, maxAgents) : orderedIds;
    if (boundedIds.length < 2 || !boundedIds.includes(leaderAnswer.choice)) return null;
    return { memberIds: boundedIds, leaderId: leaderAnswer.choice, model: resolved.model };
  } catch (error) {
    console.error("[capabilityMatcher] Jev selection failed, falling back:", error);
    return null;
  }
}

/**
 * Ask the LLM to pick the right team members and leader for a given task.
 * Returns `null` when the LLM call fails or returns unparseable output so the
 * caller can fall back to keyword matching.
 *
 * @param maxAgents - When provided (e.g. from "spawn 2 subagents"), the LLM is
 * instructed to pick exactly this many agents.
 */
async function selectViaLLM(
  prompt: string,
  activeRoles: AgentRole[],
  maxAgents?: number,
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

  const countRule =
    maxAgents != null && maxAgents >= 1
      ? `- The user explicitly requested exactly ${maxAgents} agent(s). Pick EXACTLY ${maxAgents} agents — no more, no less.`
      : "- Pick between 2 and 5 agents depending on task complexity. Simple tasks need 2-3, complex tasks up to 5.";

  const systemPrompt = [
    "You are a team composition advisor. Given a task and a list of available agents, select the most appropriate team.",
    "",
    "Rules:",
    "- First identify the PRIMARY action of the task (writing, coding, research, design, etc.).",
    "- ALWAYS include the agent whose core specialization matches the primary action. E.g. a writing task MUST include a writer, a coding task MUST include a coder.",
    "- Then add agents that complement with relevant secondary skills (research, review, domain expertise).",
    countRule,
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
    recordLlmCallSuccess(
      {
        sourceKind: "capability_matcher",
        providerType: provider.type,
        modelKey: model,
        modelId: model,
      },
      response.usage,
    );

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
    if (!cleaned) return null;
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

    return { memberIds: validMembers, leaderId, model };
  } catch (err) {
    recordLlmCallError(
      {
        sourceKind: "capability_matcher",
        providerType: provider.type,
        modelKey: model,
        modelId: model,
      },
      err,
    );
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
  maxAgents?: number,
): { members: AgentRole[]; leader: AgentRole } {
  // Detect which capabilities the prompt needs
  const detected = new Set<AgentCapability>();
  for (const [cap, pattern] of Object.entries(CAPABILITY_SIGNALS)) {
    if (pattern.test(prompt)) detected.add(cap as AgentCapability);
  }

  // Use explicit max from prompt if provided, else heuristic
  let max = maxAgents ?? 3;
  if (maxAgents == null) {
    if (detected.size >= 5) max = 5;
    else if (detected.size >= 3) max = 4;
  }
  // When maxAgents is explicitly set (e.g. "spawn 1 agent"), respect it exactly.
  // Without an explicit cap, keep the existing floor of 2 so we always have a pair.
  const min = maxAgents != null ? maxAgents : Math.max(2, max - 1);

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
  let leader =
    members.find((m) => m.autonomyLevel === "lead") ||
    activeRoles.find((r) => r.name === "architect") ||
    activeRoles.find((r) => r.name === "project_manager") ||
    members[0];

  // Only add leader to members if not already present and we won't exceed maxAgents
  if (leader && !members.some((m) => m.id === leader!.id)) {
    if (maxAgents == null || members.length < maxAgents) {
      members.push(leader);
    } else {
      leader = members[0];
    }
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
 *
 * @param maxAgents - Optional cap from user prompt (e.g. "spawn 2 subagents" -> 2)
 */
export async function selectAgentsForTask(
  prompt: string,
  allRoles: AgentRole[],
  maxAgents?: number,
  telemetryContext?: JevDecisionTelemetryContext,
): Promise<AgentSelectionResult> {
  const active = allRoles.filter((r) => r.isActive);
  if (active.length === 0) {
    throw new Error("No active agent roles available for team selection");
  }

  let activeJevHarness = false;
  try {
    const settings = LLMProviderFactory.loadSettings();
    activeJevHarness =
      settings.jev?.enabled === true &&
      settings.jev.harnessEnabled === true &&
      settings.jev.toolReviewMode === "active";
  } catch {
    // Keep the existing fallback behavior when settings are unavailable.
  }

  // Jev is an opt-in structured-decision adviser. Active harness mode makes
  // it the only remote decision route for this bounded selection; a failed or
  // low-confidence answer goes directly to deterministic matching so the
  // normal chat model is not charged for a harness decision.
  const jevResult = await selectViaJev(prompt, active, maxAgents, telemetryContext);
  if (jevResult) {
    const roleMap = new Map(active.map((r) => [r.id, r]));
    const members = jevResult.memberIds
      .map((id) => roleMap.get(id))
      .filter((r): r is AgentRole => r != null);
    const leader = roleMap.get(jevResult.leaderId) || members[0];
    if (members.length >= 2 && leader) {
      return {
        members,
        leader,
        source: "jev",
        decisionModel: jevResult.model,
      };
    }
  }

  if (activeJevHarness) {
    let result = selectViaKeywords(prompt, active, maxAgents);
    if (maxAgents != null && maxAgents >= 1 && result.members.length > maxAgents) {
      result = {
        ...result,
        members: result.members.slice(0, maxAgents),
      };
    }
    return { ...result, source: "keyword_active" };
  }

  // Try the existing chat-model selection next.
  const llmResult = await selectViaLLM(prompt, active, maxAgents);

  if (llmResult) {
    const roleMap = new Map(active.map((r) => [r.id, r]));
    let memberIds = llmResult.memberIds;
    if (maxAgents != null && maxAgents >= 1) {
      memberIds = memberIds.slice(0, maxAgents);
    }
    const members = memberIds.map((id) => roleMap.get(id)).filter((r): r is AgentRole => r != null);
    const leader = roleMap.get(llmResult.leaderId) || members[0];
    if (members.length >= 2) {
      return {
        members,
        leader,
        source: "chat_model",
        decisionModel: llmResult.model,
      };
    }
  }

  // Fallback to keyword matching
  let result = selectViaKeywords(prompt, active, maxAgents);
  if (maxAgents != null && maxAgents >= 1 && result.members.length > maxAgents) {
    result = {
      ...result,
      members: result.members.slice(0, maxAgents),
    };
  }
  return { ...result, source: "keyword" };
}
