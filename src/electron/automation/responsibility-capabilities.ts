import type {
  BotResponsibilityDefinition,
  ResponsibilityOperation,
} from "../../shared/bot-responsibility";
import { CHANNEL_TYPES } from "../../shared/gateway-channel-types";
import type { Routine, RoutineMailboxEventTrigger } from "../routines/types";
const localResource = (id: string) =>
  id !== "" && !id.startsWith("/") && !id.includes("\\") && !id.split("/").includes("..");
export function supportedResponsibilityOperation(
  op: ResponsibilityOperation,
  effect: "read" | "write",
): boolean {
  if (op.connectorId === "workspace_files" && localResource(op.resourceId))
    return (effect === "read" ? ["read_file", "list_directory"] : ["write_file"]).includes(
      op.method,
    );
  if (
    effect === "read" &&
    op.connectorId === "mailbox" &&
    ["list_threads", "get_thread"].includes(op.method) &&
    op.resourceId.trim() !== ""
  )
    return true;
  return (
    effect === "read" &&
    CHANNEL_TYPES.some((type) => op.connectorId === `gateway:${type}`) &&
    op.method === "channel_history" &&
    op.resourceId.trim() !== ""
  );
}
/** A capability declaration does not grant permissions. Unknown adapters/targets
 * remain unavailable; each dispatch and tool rechecks persisted scope. */
export function responsibilityActivationIssues(
  definition: BotResponsibilityDefinition,
  routine: Routine | null,
  permissions: {
    read?: boolean;
    write?: boolean;
    accessProfileUnavailable?: boolean;
    /** True only when this runtime can present the inline exact review (not headless). */
    interactiveReview?: boolean;
  },
): string[] {
  const issues: string[] = [];
  if (permissions.accessProfileUnavailable)
    issues.push("The selected access profile is unavailable.");
  if (definition.engine.kind !== "routine" || !routine)
    issues.push("This engine has no governed task executor yet.");
  if (routine) {
    const chat = routine.contextBindings.chatContext;
    if (
      chat &&
      !definition.sources.some(
        (source) =>
          source.connectorId === `gateway:${chat.channelType}` &&
          source.method === "channel_history" &&
          source.resourceId === chat.channelId,
      )
    )
      issues.push("Routine chat context is outside the selected sources.");
    if (routine.workflow || routine.activeWorkflowVersionId)
      issues.push("Deterministic workflow policy binding is not connected yet.");
    if (routine.executionTarget.kind !== "workspace")
      issues.push("This execution target has no responsibility handoff yet.");
    if (
      Object.keys(routine.contextBindings.metadata ?? {}).some((key) =>
        ["targetTaskId", "sourceTaskId", "threadTaskId", "taskId"].includes(key),
      )
    )
      issues.push("Thread follow-ups require a separate run revision binding.");
    if (routine.outputs.some((output) => output.kind !== "task_only"))
      issues.push("External routine output needs a delivery approval binding.");
    if (
      routine.triggers.some((trigger) => trigger.enabled && trigger.type === "schedule") &&
      !definition.sources.length
    )
      issues.push("Scheduled responsibilities require a selected observable source.");
    const mailboxTriggers = routine.triggers.filter(
      (trigger): trigger is RoutineMailboxEventTrigger =>
        trigger.enabled && trigger.type === "mailbox_event",
    );
    if (mailboxTriggers.some((trigger) => !trigger.accountId?.trim()))
      issues.push("Mailbox event responsibilities require one explicitly selected account.");
    if (mailboxTriggers.length && !definition.sources.length)
      issues.push("Mailbox event responsibilities require a selected observable source.");
    if (
      routine.triggers.some(
        (trigger) =>
          trigger.enabled &&
          trigger.type !== "manual" &&
          trigger.type !== "schedule" &&
          !(
            (trigger.type === "channel_event" &&
              trigger.channelType &&
              trigger.chatId &&
              definition.sources.some(
                (source) =>
                  source.connectorId === `gateway:${trigger.channelType}` &&
                  source.method === "channel_history" &&
                  source.resourceId === trigger.chatId,
              )) ||
            (trigger.type === "mailbox_event" && trigger.accountId?.trim())
          ),
      )
    )
      issues.push("This event source needs a responsibility ingestion scope adapter.");
  }
  if (definition.destination.channel !== "internal")
    issues.push("This destination needs a channel decision and delivery binding.");
  if (definition.sources.some((op) => !supportedResponsibilityOperation(op, "read")))
    issues.push("A selected source has no trusted read scope adapter.");
  if (definition.permittedActions.some((op) => !supportedResponsibilityOperation(op, "write")))
    issues.push("A selected action has no trusted effect scope adapter.");
  if (definition.sources.length && !permissions.read)
    issues.push("Workspace read permission is unavailable.");
  if (
    definition.mode === "act" &&
    definition.reviewBoundary === "all_effects" &&
    definition.permittedActions.length > 0 &&
    definition.permittedActions.every((operation) =>
      supportedResponsibilityOperation(operation, "write"),
    ) &&
    !permissions.read
  )
    issues.push(
      "Reviewed workspace writes require read access to capture the current base revision.",
    );
  if (definition.permittedActions.length && !permissions.write)
    issues.push("Workspace write permission is unavailable.");
  // canAnswerInlineApproval denies inline reviews on headless runtimes and for
  // automated (scheduled or event-started) tasks, so an all-effects Act run there would
  // only repeat refused writes until its budget fails. Report it before dispatch; an
  // unknown runtime counts as non-interactive.
  const reviewsEveryEffect =
    definition.mode === "act" &&
    definition.reviewBoundary === "all_effects" &&
    definition.permittedActions.length > 0;
  if (reviewsEveryEffect && permissions.interactiveReview !== true)
    issues.push(
      "Reviewed effects need the desktop app to present the exact review; this headless runtime cannot ask for a decision.",
    );
  if (
    reviewsEveryEffect &&
    routine?.triggers.some((trigger) => trigger.enabled && trigger.type !== "manual")
  )
    issues.push(
      "Scheduled or event-started runs cannot present the exact review; use a manual trigger or grant the exact action within scope.",
    );
  return issues;
}
