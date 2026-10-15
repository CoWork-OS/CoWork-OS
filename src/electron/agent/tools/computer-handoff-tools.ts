import type { LLMTool } from "../llm/types";
import { ComputerViewService } from "../../computer-use/computer-view-service";
import { COMPUTER_TAKEOVER_REASON_MAX_LENGTH } from "../../../shared/computer-view";

/**
 * ComputerHandoffTools lets an agent hand a step to the person: passwords, one-time codes,
 * CAPTCHAs, payments and identity checks are theirs to do, never the agent's.
 */
export class ComputerHandoffTools {
  constructor(private taskId: string) {}

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "request_takeover",
        description:
          "Use when the next step on the computer or in the browser needs the person: a password, " +
          "passkey, one-time code, CAPTCHA, payment, identity check, or a site that requires a " +
          "human. Asks them to take over. Never type or ask for these secrets in chat. After " +
          "calling it, stop using computer and browser tools and end your turn with one short " +
          "line on what they need to do; continue when they say they are done.",
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

  requestTakeover(input: { reason?: unknown }): { success: true; message: string } {
    const reason = typeof input?.reason === "string" ? input.reason : "";
    ComputerViewService.getInstance().requestTakeover(this.taskId, reason);
    return {
      success: true,
      message:
        "Asked the person to take over. Stop using computer and browser tools now and end your " +
        "turn with one short line on what they need to do. Continue when they say they are done.",
    };
  }
}
