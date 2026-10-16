import type { LLMTool } from "../llm/types";
import type { InputRequestResponse, RequestUserInputArgs, Task } from "../../../shared/types";
import {
  allowsHardBlockerHumanInput,
  resolveHumanInputPolicy,
} from "../../../shared/human-input-policy";
import { ComputerViewService } from "../../computer-use/computer-view-service";
import { COMPUTER_TAKEOVER_REASON_MAX_LENGTH } from "../../../shared/computer-view";

interface HandoffDaemon {
  /** Asks the person a structured question and waits for the answer (inbox, phone, app). */
  requestUserInput?: (taskId: string, args: RequestUserInputArgs) => Promise<InputRequestResponse>;
  getTaskById?: (taskId: string) => Promise<Pick<Task, "agentConfig"> | undefined>;
}

const QUESTION_ID = "takeover";

/**
 * ComputerHandoffTools lets an agent hand a step to the person: passwords, one-time codes,
 * CAPTCHAs, payments and identity checks are theirs to do, never the agent's. The request is a
 * real input request, so it reaches the person wherever their input requests do (the app, the
 * notification inbox, their phone through a messaging channel), and the agent waits for it.
 */
export class ComputerHandoffTools {
  constructor(
    private taskId: string,
    private daemon?: HandoffDaemon,
  ) {}

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "request_takeover",
        description:
          "Use when the next step on the computer or in the browser needs the person: a password, " +
          "passkey, one-time code, CAPTCHA, payment, identity check, or a site that requires a " +
          "human. Asks them to take over and waits until they say they are done. Never type or " +
          "ask for these secrets in chat. Take a fresh screenshot before you continue.",
        input_schema: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description:
                "What the person needs to do, e.g. 'Sign in to the bank and approve the 2FA prompt'.",
              maxLength: COMPUTER_TAKEOVER_REASON_MAX_LENGTH,
            },
          },
          required: ["reason"],
        },
      },
    ];
  }

  async requestTakeover(input: {
    reason?: unknown;
  }): Promise<{ success: boolean; message: string }> {
    // A task that may not wait on the person (no human input) never pauses for a take-over.
    if (this.daemon?.getTaskById) {
      const task = await this.daemon.getTaskById(this.taskId);
      if (
        !allowsHardBlockerHumanInput(resolveHumanInputPolicy({ agentConfig: task?.agentConfig }))
      ) {
        return {
          success: false,
          message:
            "This task can't wait for the person. Don't try the step yourself; report what is blocked.",
        };
      }
    }
    const view = ComputerViewService.getInstance();
    const state = view.requestTakeover(
      this.taskId,
      typeof input?.reason === "string" ? input.reason : "",
    );
    const reason = state.takeoverRequest?.reason ?? "A step needs you.";
    // The reason comes from the model and often has no closing stop.
    const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
    if (!this.daemon?.requestUserInput) {
      return {
        success: true,
        message:
          "Asked the person to take over. Stop using computer and browser tools now and end your " +
          "turn with one short line on what they need to do. Continue when they say they are done.",
      };
    }
    let response: InputRequestResponse;
    try {
      response = await this.daemon.requestUserInput(this.taskId, {
        questions: [
          {
            header: "Take over",
            id: QUESTION_ID,
            question: `${sentence} Take over from the bot's panel (Computer → Take over), do this step, then choose Done.`,
            options: [
              { label: "Done", description: "I did it; the bot can continue." },
              { label: "Skip", description: "Not now; the bot continues without this step." },
            ],
          },
        ],
      });
    } catch (error) {
      // Only "another question is already waiting" keeps the request on the rail; a cancelled or
      // failed task withdraws it.
      if (
        !(error instanceof Error && /already has a pending structured input/.test(error.message))
      ) {
        view.clearTakeoverRequest(this.taskId);
        throw error;
      }
      return {
        success: true,
        message:
          `Asked the person to take over (${error instanceof Error ? error.message : "a question is already waiting"}). ` +
          "Stop using computer and browser tools and end your turn with one short line on what they need to do.",
      };
    }
    // The person answered: the computer goes back to the bot.
    if (view.isHeldByPerson(this.taskId)) view.handBack(this.taskId);
    view.clearTakeoverRequest(this.taskId);
    const answer = response.answers?.[QUESTION_ID]?.optionLabel?.trim().toLowerCase() ?? "";
    if (response.status !== "submitted" || answer === "skip") {
      return {
        success: false,
        message:
          "The person skipped this step. Don't try it yourself; continue without it or report what is blocked.",
      };
    }
    return {
      success: true,
      message:
        "The person finished the step and handed the computer back. Take a fresh screenshot before you continue.",
    };
  }
}
