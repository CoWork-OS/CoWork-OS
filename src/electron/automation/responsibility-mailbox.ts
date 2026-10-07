import type Database from "better-sqlite3";
import type { EventTrigger, TriggerEvent } from "../triggers/types";

export type ResponsibilityMailboxAccountReceipt = { accountId: string; provider: string };

/** A governed mailbox event must name exactly one account in its persisted trigger conditions. */
export function selectedResponsibilityMailboxAccount(
  db: Database.Database,
  trigger: Pick<EventTrigger, "source" | "conditions">,
): ResponsibilityMailboxAccountReceipt | null {
  if (trigger.source !== "mailbox_event") return null;
  const selected = trigger.conditions.filter(
    (condition) => condition.field === "accountId" && condition.operator === "equals",
  );
  const accountId = selected.length === 1 ? selected[0].value.trim() : "";
  if (!accountId || accountId.length > 128)
    throw new Error("Mailbox event trigger must select exactly one account.");
  const account = db
    .prepare("SELECT id,provider,status FROM mailbox_accounts WHERE id=?")
    .get(accountId) as { id: string; provider: string; status: string } | undefined;
  if (!account || !["connected", "degraded"].includes(account.status))
    throw new Error("Selected mailbox event account is unavailable.");
  return { accountId: account.id, provider: account.provider };
}

/** Verifies the event adapter's persisted receipt and the selected workspace/account tuple. */
export function assertResponsibilityMailboxEvent(
  db: Database.Database,
  trigger: Pick<EventTrigger, "source" | "conditions">,
  event: TriggerEvent,
  workspaceId: string,
  expectedAccount?: ResponsibilityMailboxAccountReceipt,
): ResponsibilityMailboxAccountReceipt {
  const account = selectedResponsibilityMailboxAccount(db, trigger);
  if (
    !account ||
    (expectedAccount &&
      (account.accountId !== expectedAccount.accountId ||
        account.provider !== expectedAccount.provider))
  )
    throw new Error("Mailbox event account changed after occurrence acceptance.");
  const eventId = event.fields.mailboxEventId;
  if (
    event.source !== "mailbox_event" ||
    typeof eventId !== "string" ||
    !eventId.trim() ||
    eventId.length > 128 ||
    event.fields.workspaceId !== workspaceId ||
    event.fields.accountId !== account.accountId ||
    event.fields.provider !== account.provider ||
    typeof event.fields.eventType !== "string"
  )
    throw new Error("Mailbox event is outside the selected workspace/account scope.");
  const persisted = db
    .prepare("SELECT workspace_id,event_type,account_id,provider FROM mailbox_events WHERE id=?")
    .get(eventId) as
    | {
        workspace_id: string;
        event_type: string;
        account_id: string | null;
        provider: string | null;
      }
    | undefined;
  if (
    !persisted ||
    persisted.workspace_id !== workspaceId ||
    persisted.event_type !== event.fields.eventType ||
    persisted.account_id !== account.accountId ||
    persisted.provider !== account.provider
  )
    throw new Error("Mailbox event receipt is missing or changed.");
  return account;
}
