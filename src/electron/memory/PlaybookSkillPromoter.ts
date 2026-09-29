/**
 * PlaybookSkillPromoter — proposes skills from repeated, evidence-backed successes
 *
 * Bridges the Playbook evidence ledger with SkillProposalService (which has the approval
 * workflow). A pattern qualifies when durable reinforcement links connect at least N
 * distinct, independent successful executions (default 3) that used a compatible
 * approach. Memory rows, reinforcement chains and legacy free-text claims never count.
 *
 * Proposals still require review; they describe "observed successful executions" and
 * list each execution's task and source memory.
 */

import {
  SkillProposalService,
  type SkillProposalStatus,
  type SkillProposalCreateInput,
} from "../agent/skills/SkillProposalService";
import { PlaybookService, type PlaybookSuccess } from "./PlaybookService";

// ─── Types ────────────────────────────────────────────────────────────

export interface PromotionCandidate {
  /** Human label for the pattern (most common task title in the cluster). */
  pattern: string;
  /** Approach identity shared by every execution in the cluster. */
  patternKey: string;
  /** Distinct independent successful executions in the cluster. */
  executionCount: number;
  /** Tools used across the executions. */
  toolsUsed: string[];
  /** Original request excerpts. */
  requestExcerpts: string[];
  /** One line per execution: its task and source memory. */
  sourceEvidence: string[];
  evidenceIds: string[];
}

export interface PromotionResult {
  proposed: boolean;
  reason: string;
  proposalId?: string;
  proposalStatus?: SkillProposalStatus;
}

// ─── Constants ────────────────────────────────────────────────────────

/** Minimum distinct successful executions before proposing a skill. */
const DEFAULT_PROMOTION_THRESHOLD = 3;

/** Max proposals to create in a single check (prevent spam). */
const MAX_PROPOSALS_PER_CHECK = 1;

/** Cooldown between promotion checks per workspace (10 minutes). */
const PROMOTION_COOLDOWN_MS = 10 * 60 * 1000;

/** Track last promotion check per workspace. */
const lastCheckByWorkspace = new Map<string, number>();

// ─── Helpers ──────────────────────────────────────────────────────────

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
 * Generate a prompt template from the evidence.
 */
function generatePromptTemplate(candidate: PromotionCandidate): string {
  const lines = [
    `You are performing a task pattern that CoWork observed completing successfully ${candidate.executionCount} times.`,
    ``,
    `Task pattern: ${candidate.pattern}`,
    ``,
    `Tools used in those executions: ${candidate.toolsUsed.join(", ") || "determined by context"}`,
    ``,
    `Treat the earlier approach as a starting point, not a guarantee; verify the result for this request.`,
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

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
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
  static async maybePropose(workspaceId: string, workspacePath: string): Promise<PromotionResult> {
    // Cooldown check
    const lastCheck = lastCheckByWorkspace.get(workspaceId) ?? 0;
    if (Date.now() - lastCheck < PROMOTION_COOLDOWN_MS) {
      return { proposed: false, reason: "cooldown" };
    }
    lastCheckByWorkspace.set(workspaceId, Date.now());

    try {
      // Find reinforcement candidates
      const candidates = await this.findCandidates(workspaceId);
      if (candidates.length === 0) {
        return { proposed: false, reason: "no_candidates" };
      }

      // Most observed executions first
      candidates.sort((a, b) => b.executionCount - a.executionCount);

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
   * Clusters of active success evidence joined by durable reinforcement links, counting
   * distinct independent executions (not memory rows or chains) per cluster.
   */
  static async findCandidates(
    workspaceId: string,
    threshold = DEFAULT_PROMOTION_THRESHOLD,
  ): Promise<PromotionCandidate[]> {
    try {
      const store = PlaybookService.getEvidenceStore();
      if (!store) return [];
      const eligible = new Map<string, PlaybookSuccess>();
      for (const success of await PlaybookService.eligibleSuccesses(store, workspaceId)) {
        if (success.record.patternKey) eligible.set(success.record.id, success);
      }
      if (eligible.size === 0) return [];

      // Union-find over links whose both ends are eligible and share a pattern key.
      const parent = new Map<string, string>();
      const find = (id: string): string => {
        let root = id;
        while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
        parent.set(id, root);
        return root;
      };
      for (const id of eligible.keys()) parent.set(id, id);
      for (const link of await store.listActiveLinks(workspaceId)) {
        const from = eligible.get(link.from);
        const to = eligible.get(link.to);
        if (!from || !to || from.record.patternKey !== to.record.patternKey) continue;
        parent.set(find(from.record.id), find(to.record.id));
      }

      const clusters = new Map<string, PlaybookSuccess[]>();
      for (const success of eligible.values()) {
        const root = find(success.record.id);
        clusters.set(root, [...(clusters.get(root) ?? []), success]);
      }

      // Evidence is unique per task, so each cluster member is a distinct execution.
      const candidates: PromotionCandidate[] = [];
      for (const executions of clusters.values()) {
        if (executions.length < threshold) continue;
        candidates.push({
          pattern: mostCommon(executions.map((success) => success.title)).slice(0, 120),
          patternKey: executions[0].record.patternKey,
          executionCount: executions.length,
          toolsUsed: [...new Set(executions.flatMap((success) => success.toolsUsed))],
          requestExcerpts: [...new Set(executions.map((success) => success.request.slice(0, 200)))]
            .filter(Boolean)
            .slice(0, 5),
          sourceEvidence: executions.map(
            ({ record }) =>
              `Observed successful execution of task ${record.taskId} (memory ${record.sourceMemoryId})`,
          ),
          evidenceIds: executions.map(({ record }) => record.id),
        });
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
      problemStatement: `Recurring task pattern with ${candidate.executionCount} observed successful executions: "${candidate.pattern}"`,
      evidence: [
        `${candidate.executionCount} distinct observed successful executions linked by a compatible approach`,
        `Common tools: ${candidate.toolsUsed.join(", ") || "various"}`,
        ...candidate.sourceEvidence,
        ...candidate.requestExcerpts.map((r) => `Example request: ${r}`),
      ],
      requiredTools: candidate.toolsUsed,
      riskNote:
        "Auto-generated by PlaybookSkillPromoter from the Playbook evidence ledger. Observed runtime success is not proof the results were accepted; review before approving.",
      provenance: {
        source: "playbook_evidence",
        evidenceIds: candidate.evidenceIds,
        executionCount: candidate.executionCount,
      },
      draftSkill: {
        id: skillId,
        name: skillName,
        description: `Auto-detected skill for: ${candidate.pattern}. Based on ${candidate.executionCount} observed successful executions.`,
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
