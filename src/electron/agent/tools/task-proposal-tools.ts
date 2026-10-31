/**
 * Suggested tasks: `propose_task` lets the agent hand work it noticed outside the current
 * request to the person as a card in this task's transcript, instead of doing it unasked or
 * only mentioning it. Nothing runs until the person starts it. See docs/suggested-tasks.md.
 */
import type { LLMTool } from "../llm/types";
import { TASK_PROPOSAL_LIMITS } from "../../../shared/task-proposals";
import type { TaskProposalService } from "../../task-proposals/TaskProposalService";

export const TASK_PROPOSAL_TOOL_NAMES = ["propose_task", "withdraw_task_proposal"] as const;

export class TaskProposalTools {
  /** Proposals made since the current turn began; reset by beginTurn(). */
  private proposalsThisTurn = 0;

  constructor(
    private readonly service: TaskProposalService,
    private readonly taskId: string,
  ) {}

  /** A new turn of the conversation starts: the per-turn proposal limit counts afresh. */
  beginTurn(): void {
    this.proposalsThisTurn = 0;
  }

  static getToolDefinitions(): LLMTool[] {
    const limits = TASK_PROPOSAL_LIMITS;
    return [
      {
        name: "propose_task",
        description:
          "Suggest a separate task for work you noticed outside the user's current request: a " +
          "bug found in passing, a cost too large to fix here, a missing test, stale docs, or the " +
          "follow-up your answer calls 'a follow-up' or 'a separate PR'. The user sees a card " +
          "under your answer and decides: start it as its own task, have you do it here, or " +
          "dismiss it. Nothing runs until they choose, so keep working on the current request. " +
          "Do not use it for anything the user asked you to do, for work you are about to do " +
          "anyway, for one-line tweaks or speculation, or for the one fix that acts on what you " +
          "just found (ask the user about that in your reply instead). " +
          `At most ${limits.perTurn} per turn, and never the same task twice. The new task ` +
          "does not see this conversation: the brief must stand alone.",
        input_schema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: `Names the task in a few words (at most ${limits.titleMaxChars} characters)`,
            },
            summary: {
              type: "string",
              description:
                "One or two plain sentences for the card: what the task does and why it matters",
            },
            brief: {
              type: "string",
              description:
                "The complete prompt the new task starts from: the goal, what you found and " +
                "why, the files or area (repository-relative paths), constraints, and what " +
                "done looks like",
            },
            worktree: {
              type: "boolean",
              description:
                "Suggest running it in its own git worktree, for code changes that should land " +
                "on their own branch. The user can change it.",
            },
          },
          required: ["title", "summary", "brief"],
        },
      },
      {
        name: "withdraw_task_proposal",
        description:
          "Take back a task you proposed with propose_task that the user has not acted on, " +
          "when it went stale: you did the work here after all, it turned out unnecessary, or " +
          "you proposed a better-scoped replacement (propose the new one first).",
        input_schema: {
          type: "object",
          properties: {
            proposal_id: {
              type: "string",
              description: "The proposal_id that propose_task returned",
            },
            reason: {
              type: "string",
              description: "One short line, e.g. 'fixed in this task'",
            },
          },
          required: ["proposal_id"],
        },
      },
    ];
  }

  async proposeTask(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.service.propose(
      this.taskId,
      {
        title: input.title,
        summary: input.summary,
        brief: input.brief,
        worktree: input.worktree,
      },
      { proposalsThisTurn: this.proposalsThisTurn },
    );
    // Proposing is advisory: a refused proposal is a note for the agent, never a failed tool
    // call, which would fail the step it was working on.
    if (!result.ok) return { success: true, proposed: false, note: result.error };
    this.proposalsThisTurn += 1;
    return {
      success: true,
      proposed: true,
      proposal_id: result.proposal.id,
      message:
        "The user sees this as a suggested task under your answer. Nothing has started; " +
        "continue with the current request.",
    };
  }

  async withdrawTaskProposal(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.service.withdraw(this.taskId, input.proposal_id, input.reason);
    if (!result.ok) return { success: true, withdrawn: false, note: result.error };
    return {
      success: true,
      withdrawn: true,
      proposal_id: result.proposal.id,
      status: "withdrawn",
    };
  }
}
