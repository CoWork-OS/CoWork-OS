import type { ResponsibilityOperation } from "../../shared/bot-responsibility";
import { CHANNEL_TYPES } from "../../shared/gateway-channel-types";
import type { MailboxAccount } from "../../shared/mailbox";

const channelNames: Record<(typeof CHANNEL_TYPES)[number], string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  whatsapp: "WhatsApp",
  imessage: "iMessage",
  signal: "Signal",
  mattermost: "Mattermost",
  matrix: "Matrix",
  line: "LINE",
  bluebubbles: "BlueBubbles",
  email: "Email",
  teams: "Teams",
  googlechat: "Google Chat",
  feishu: "Feishu",
  wecom: "WeCom",
  x: "X",
  whatsapp_cloud: "WhatsApp Cloud",
  twilio_sms: "Twilio SMS",
};
export interface ResponsibilityOperationChoice {
  connectorId: string;
  method: string;
  label: string;
  resourceLabel: string;
  resourceHint: string;
}
export function responsibilityOperationChoices(
  effect: "read" | "write",
): ResponsibilityOperationChoice[] {
  const file = {
    connectorId: "workspace_files",
    method: effect === "read" ? "read_file" : "write_file",
    label: effect === "read" ? "File in this workspace" : "Write a workspace file",
    resourceLabel: "File path",
    resourceHint: "Path relative to this workspace, such as reports/summary.md",
  };
  if (effect === "write") return [file];
  return [
    file,
    {
      ...file,
      method: "list_directory",
      label: "Folder in this workspace",
      resourceLabel: "Folder path",
      resourceHint: "Path relative to this workspace; use . for its root.",
    },
    {
      connectorId: "mailbox",
      method: "list_threads",
      label: "Mailbox account threads",
      resourceLabel: "Mailbox account",
      resourceHint: "Reads cached thread summaries from this exact account.",
    },
    {
      connectorId: "mailbox",
      method: "get_thread",
      label: "Thread in a mailbox account",
      resourceLabel: "Mailbox account",
      resourceHint: "Reads a thread only after checking it belongs to this exact account.",
    },
    ...CHANNEL_TYPES.map((channel) => ({
      connectorId: `gateway:${channel}`,
      method: "channel_history",
      label: `${channelNames[channel]} conversation history`,
      resourceLabel: "Conversation ID",
      resourceHint: "Exact conversation ID from the configured channel. Reads saved history only.",
    })),
  ];
}
const choiceKey = (value: Pick<ResponsibilityOperation, "connectorId" | "method">) =>
  `${value.connectorId}:${value.method}`;
export function chooseResponsibilityOperation(
  current: ResponsibilityOperation,
  choice: ResponsibilityOperationChoice,
): ResponsibilityOperation {
  return {
    connectorId: choice.connectorId,
    method: choice.method,
    resourceId: choice.connectorId === current.connectorId ? current.resourceId : "",
  };
}
export function ResponsibilityOperationEditor({
  operation,
  effect,
  index,
  mailboxAccounts = [],
  onChange,
}: {
  operation: ResponsibilityOperation;
  effect: "read" | "write";
  index: number;
  mailboxAccounts?: Pick<MailboxAccount, "id" | "provider" | "address" | "status">[];
  onChange: (next: ResponsibilityOperation) => void;
}) {
  const choices = responsibilityOperationChoices(effect);
  const selected = choices.find((choice) => choiceKey(choice) === choiceKey(operation));
  const noun = effect === "read" ? "Source" : "Action";
  return (
    <>
      <label>
        {noun} {index + 1}
        <select
          value={selected ? choiceKey(selected) : "saved-unavailable"}
          onChange={(event) => {
            const choice = choices.find((item) => choiceKey(item) === event.target.value);
            if (choice) onChange(chooseResponsibilityOperation(operation, choice));
          }}
        >
          {!selected && (
            <option value="saved-unavailable" disabled>
              Saved {noun.toLowerCase()} (unavailable)
            </option>
          )}
          {choices.map((choice) => (
            <option key={choiceKey(choice)} value={choiceKey(choice)}>
              {choice.label}
            </option>
          ))}
        </select>
        {!selected && (
          <small>
            This saved operation has no supported adapter. Choose a supported {noun.toLowerCase()}{" "}
            to use it.
          </small>
        )}
      </label>
      <label>
        {selected?.resourceLabel ?? "Saved resource scope"}
        {selected?.connectorId === "mailbox" ? (
          <>
            <select
              aria-label={"Mailbox account for " + noun.toLowerCase() + " " + (index + 1)}
              required
              value={operation.resourceId}
              onChange={(event) => onChange({ ...operation, resourceId: event.target.value })}
            >
              <option value="" disabled>
                Choose a configured mailbox account
              </option>
              {operation.resourceId &&
                !mailboxAccounts.some((account) => account.id === operation.resourceId) && (
                  <option value={operation.resourceId} disabled>
                    Saved account unavailable · {operation.resourceId}
                  </option>
                )}
              {mailboxAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.address} · {account.provider} · {account.status}
                </option>
              ))}
            </select>
            <small>{selected.resourceHint} Only configured accounts are selectable.</small>
          </>
        ) : (
          <>
            <input
              required
              maxLength={512}
              value={operation.resourceId}
              onChange={(event) => onChange({ ...operation, resourceId: event.target.value })}
            />
            <small>
              {selected?.resourceHint ?? operation.connectorId + " · " + operation.method}
            </small>
          </>
        )}
      </label>
    </>
  );
}
