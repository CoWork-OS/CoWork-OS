/**
 * PlaybookSkillPromoter — Auto-proposes skills from repeated playbook patterns
 *
 * Bridges PlaybookService (which detects repeated successful patterns) with
 * SkillProposalService (which has a full approval workflow). When a playbook
 * pattern is reinforced N times (configurable, default 3), this service
 * auto-generates a skill proposal with evidence and a draft prompt template.
 *
 * The proposal goes through the existing governance approval workflow —
 * the admin sees the evidence and can approve or reject with one click.
 *
 * Enterprise value:
 *  - Transforms repeated manual workflows into governed, version-controlled skills
 *  - Reduces mean-time-to-automation from weeks of manual skill authoring to
 *    automatic proposal with one-click approval
 */

import { MemoryService } from "./MemoryService";
import {
  SkillProposalService,
  type SkillProposalStatus,
  type SkillProposalCreateInput,
} from "../agent/skills/SkillProposalService";

// ─── Types ────────────────────────────────────────────────────────────

export interface PromotionCandidate {
  /** The playbook pattern text. */
  pattern: string;
  /** Number of times this pattern has been reinforced. */
  reinforcementCount: number;
  /** Tools used across the reinforced instances. */
  toolsUsed: string[];
  /** Original request excerpts from the playbook entries. */
  requestExcerpts: string[];
}

export interface PromotionResult {
  proposed: boolean;
  reason: string;
  proposalId?: string;
  proposalStatus?: SkillProposalStatus;
}

// ─── Constants ────────────────────────────────────────────────────────

/** Minimum reinforcement count before proposing a skill. */
const DEFAULT_PROMOTION_THRESHOLD = 3;

/** Max proposals to create in a single check (prevent spam). */
const MAX_PROPOSALS_PER_CHECK = 1;

/** Cooldown between promotion checks per workspace (10 minutes). */
const PROMOTION_COOLDOWN_MS = 10 * 60 * 1000;

/** Track last promotion check per workspace. */
const lastCheckByWorkspace = new Map<string, number>();

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract a clean task description from a playbook snippet.
 */
function extractTaskDescription(snippet: string): string {
  // Try to extract the task title from various playbook formats
  const titleMatch = snippet.match(/Task succeeded:\s*"([^"]+)"/);
  if (titleMatch) return titleMatch[1];

  const reinforcedMatch = snippet.match(/Reinforced pattern:\s*"([^"]+)"/);
  if (reinforcedMatch) return reinforcedMatch[1];

  // Fallback: first meaningful line
  const firstLine = snippet
    .replace(/^\[PLAYBOOK\]\s*/m, "")
    .split("\n")[0]
    .trim();
  return firstLine.slice(0, 120);
}

/**
 * Extract tools from a playbook snippet.
 */
function extractTools(snippet: string): string[] {
  const toolsMatch = snippet.match(/(?:Key tools|Tools):\s*(.+)/i);
  if (!toolsMatch) return [];
  return toolsMatch[1]
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Extract the original request from a playbook snippet.
 */
function extractRequest(snippet: string): string {
  const requestMatch = snippet.match(/Original request:\s*(.+)/i);
  if (!requestMatch) return "";
  return requestMatch[1].trim().slice(0, 200);
}

/**
 * Generate a slug-style skill ID from a task description.
 */
function generateSkillId(description: string): string {
  return (
    "auto_" +
    description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 40)
  );
}

/**
 * Generate a prompt template from the playbook evidence.
 */
function generatePromptTemplate(candidate: PromotionCandidate): string {
  const lines = [
    `You are performing a task that has been successfully completed multiple times before.`,
    ``,
    `Task pattern: ${candidate.pattern}`,
    ``,
    `Recommended tools: ${candidate.toolsUsed.join(", ") || "determined by context"}`,
    ``,
    `Follow the proven approach from previous successful completions.`,
    `Use the tools listed above as your primary toolkit for this task.`,
  ];

  if (candidate.requestExcerpts.length > 0) {
    lines.push("");
    lines.push("Example requests this skill handles:");
    for (const excerpt of candidate.requestExcerpts.slice(0, 3)) {
      lines.push(`- ${excerpt}`);
    }
  }

  return lines.join("\n");
}

// ─── Main Service ─────────────────────────────────────────────────────

export class PlaybookSkillPromoter {
  /**
   * Check if any playbook patterns in the given workspace have been
   * reinforced enough times to warrant a skill proposal.
   *
   * Called after task completion in executor.ts, debounced per workspace.
   *
   * @param workspaceId - Workspace to check
   * @param workspacePath - Filesystem path for SkillProposalService
   */
  static async maybePropose(
    workspaceId: string,
    workspacePath: string,
  ): Promise<PromotionResult> {
    // Cooldown check
    const lastCheck = lastCheckByWorkspace.get(workspaceId) ?? 0;
    if (Date.now() - lastCheck < PROMOTION_COOLDOWN_MS) {
      return { proposed: false, reason: "cooldown" };
    }
    lastCheckByWorkspace.set(workspaceId, Date.now());

    try {
      // Find reinforcement candidates
      const candidates = this.findCandidates(workspaceId);
      if (candidates.length === 0) {
        return { proposed: false, reason: "no_candidates" };
      }

      // Sort by reinforcement count (most reinforced first)
      candidates.sort((a, b) => b.reinforcementCount - a.reinforcementCount);

      // Propose up to MAX_PROPOSALS_PER_CHECK
      const proposalService = new SkillProposalService(workspacePath);
      let lastResult: PromotionResult = { proposed: false, reason: "no_viable_candidates" };

      for (const candidate of candidates.slice(0, MAX_PROPOSALS_PER_CHECK)) {
        lastResult = await this.proposeSkill(candidate, proposalService);
        if (lastResult.proposed) break;
      }

      return lastResult;
    } catch (err) {
      return { proposed: false, reason: `error: ${String(err)}` };
    }
  }

  /**
   * Find playbook patterns that have been reinforced at least THRESHOLD times.
   */
  static findCandidates(
    workspaceId: string,
    threshold = DEFAULT_PROMOTION_THRESHOLD,
  ): PromotionCandidate[] {
    try {
      // Search for all reinforcement entries
      const results = MemoryService.search(workspaceId, "[PLAYBOOK] Reinforced pattern", 100);
      const reinforcements = results.filter(
        (r) => r.type === "insight" && r.snippet.includes("Reinforced pattern"),
      );

      if (reinforcements.length === 0) return [];

      // Group by pattern similarity (using task description as key)
      const patternGroups = new Map<
        string,
        { count: number; tools: Set<string>; requests: Set<string> }
      >();

      for (const entry of reinforcements) {
        const desc = extractTaskDescription(entry.snippet);
        const key = desc.toLowerCase().replace(/\s+/g, " ").trim();
        if (!key) continue;

        const existing = patternGroups.get(key) ?? {
          count: 0,
          tools: new Set<string>(),
          requests: new Set<string>(),
        };

        existing.count++;
        for (const tool of extractTools(entry.snippet)) {
          existing.tools.add(tool);
        }
        const request = extractRequest(entry.snippet);
        if (request) existing.requests.add(request);

        patternGroups.set(key, existing);
      }

      // Filter to candidates that meet the threshold
      const candidates: PromotionCandidate[] = [];
      for (const [pattern, data] of patternGroups) {
        if (data.count >= threshold) {
          candidates.push({
            pattern,
            reinforcementCount: data.count,
            toolsUsed: Array.from(data.tools),
            requestExcerpts: Array.from(data.requests).slice(0, 5),
          });
        }
      }

      return candidates;
    } catch {
      return [];
    }
  }

  /**
   * Create a skill proposal from a promotion candidate.
   */
  private static async proposeSkill(
    candidate: PromotionCandidate,
    proposalService: SkillProposalService,
  ): Promise<PromotionResult> {
    const skillId = generateSkillId(candidate.pattern);
    const skillName = candidate.pattern.slice(0, 60);

    const input: SkillProposalCreateInput = {
      problemStatement: `Recurring task pattern detected (reinforced ${candidate.reinforcementCount} times): "${candidate.pattern}"`,
      evidence: [
        `Pattern reinforced ${candidate.reinforcementCount} times across different tasks`,
        `Common tools: ${candidate.toolsUsed.join(", ") || "various"}`,
        ...candidate.requestExcerpts.map((r) => `Example request: ${r}`),
      ],
      requiredTools: candidate.toolsUsed,
      riskNote: "Auto-generated from PlaybookSkillPromoter based on repeated successful patterns.",
      draftSkill: {
        id: skillId,
        name: skillName,
        description: `Auto-detected skill for: ${candidate.pattern}. Based on ${candidate.reinforcementCount} successful completions.`,
        prompt: generatePromptTemplate(candidate),
        icon: "zap",
        category: "auto-promoted",
        enabled: true,
      },
    };

    try {
      const result = await proposalService.create(input);
      if (result.proposal) {
        return {
          proposed: true,
          reason: `Proposed skill "${skillName}" (${result.proposal.id})`,
          proposalId: result.proposal.id,
          proposalStatus: result.proposal.status,
        };
      }
      if (result.duplicateOf) {
        return { proposed: false, reason: `duplicate of ${result.duplicateOf}` };
      }
      if (result.blocked) {
        return { proposed: false, reason: `blocked: ${result.blocked}` };
      }
      return { proposed: false, reason: "unknown" };
    } catch (err) {
      return { proposed: false, reason: `proposal_error: ${String(err)}` };
    }
  }
}
