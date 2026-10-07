import type Database from "better-sqlite3";
import type { BotResponsibility } from "../../shared/bot-responsibility";
import type { EventTrigger, TriggerEvent } from "../triggers/types";
import {
  assertResponsibilityMailboxEvent,
  selectedResponsibilityMailboxAccount,
  type ResponsibilityMailboxAccountReceipt,
} from "./responsibility-mailbox";
import {
  resolveResponsibilityChannelInstances,
  type ResponsibilityChannelInstanceReceipt,
} from "./responsibility-store";

export type ResponsibilityAdmissionSnapshot = Pick<
  BotResponsibility,
  "id" | "revision" | "controlVersion" | "workspaceId" | "agentRoleId"
> & {
  engine: BotResponsibility["definition"]["engine"];
  channelInstances: ResponsibilityChannelInstanceReceipt[];
  mailboxAccount: ResponsibilityMailboxAccountReceipt | null;
};

/** Capture current source-instance identity inside a services-domain database unit. */
export function responsibilityEventAdmissionSnapshot(
  db: Database.Database,
  binding: BotResponsibility,
  trigger: EventTrigger,
): ResponsibilityAdmissionSnapshot {
  return {
    id: binding.id,
    revision: binding.revision,
    controlVersion: binding.controlVersion,
    workspaceId: binding.workspaceId,
    agentRoleId: binding.agentRoleId,
    engine: binding.definition.engine,
    channelInstances: resolveResponsibilityChannelInstances(db, binding.definition),
    mailboxAccount: selectedResponsibilityMailboxAccount(db, trigger),
  };
}

/** Match an event to the selected channel or account while staying on the database worker. */
export function responsibilityEventMatchesSourceInstance(
  db: Database.Database,
  trigger: EventTrigger,
  event: TriggerEvent,
  snapshot: ResponsibilityAdmissionSnapshot,
): boolean {
  if (event.source === "mailbox_event") {
    try {
      return Boolean(
        snapshot.mailboxAccount &&
        assertResponsibilityMailboxEvent(
          db,
          trigger,
          event,
          snapshot.workspaceId,
          snapshot.mailboxAccount,
        ),
      );
    } catch {
      return false;
    }
  }
  if (event.source !== "channel_message") return true;
  const channelType = event.fields.channelType;
  const channelInstanceId = event.fields.channelInstanceId;
  if (
    typeof channelType !== "string" ||
    typeof channelInstanceId !== "string" ||
    !channelInstanceId.trim() ||
    channelInstanceId.length > 128
  )
    return false;
  return snapshot.channelInstances.some(
    (instance) => instance.channelType === channelType && instance.channelId === channelInstanceId,
  );
}
