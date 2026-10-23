/**
 * Who wrote a follow-up's text (TaskFollowUpInput.textProvenance).
 *
 * The admin-lane tools (persona, behavioral rules, expertise, heartbeat, integration setup)
 * save into the system prompt of every later task, so only the user's own words may expose
 * them (tool-policy-engine.ts, ToolAvailabilityContext.userText). Follow-ups reach a task from
 * many places: the composer, channels, automations, heartbeats, triggers, webhooks, other
 * agents, page code. The text alone cannot say who wrote it, so each send path that a person
 * types into marks its message "user_typed", and anything unmarked counts as injected.
 */
import type { MessageSurfaceOrigin, TaskFollowUpInput } from "../../shared/types";
import { userTypedWords } from "./user-typed-words";

export const USER_TYPED_FOLLOW_UP = { textProvenance: "user_typed" } as const satisfies Pick<
  TaskFollowUpInput,
  "textProvenance"
>;

/**
 * Provenance for a message from a composer the owner signed in to: the desktop app, a remote
 * device's view of this task over the control plane, or Web Access. The person typed it,
 * unless the client says an answer surface sent it: a button the model wrote, page code, or
 * the output of a shell block. Those carry their surface origin and never "user_typed".
 */
export function composerFollowUpProvenance(
  surfaceOrigin: MessageSurfaceOrigin | undefined,
): Pick<TaskFollowUpInput, "surfaceOrigin" | "textProvenance"> {
  return surfaceOrigin ? { surfaceOrigin } : USER_TYPED_FOLLOW_UP;
}

/**
 * The user's own words in a follow-up, or "" when it was injected. Besides "user_typed",
 * the message must not be another agent's message or an answer-surface action, so a path
 * that marks too much still cannot pass those off as typed text. Attached files' text and a
 * channel's quote of the message being answered are not the user's words and are left out
 * (user-typed-words.ts).
 */
export function userTypedFollowUpText(
  message: string,
  context?: Pick<TaskFollowUpInput, "textProvenance" | "messageSource" | "surfaceOrigin">,
): string {
  if (
    context?.textProvenance !== "user_typed" ||
    context.messageSource === "agent" ||
    context.surfaceOrigin !== undefined
  ) {
    return "";
  }
  return userTypedWords(String(message || ""));
}
