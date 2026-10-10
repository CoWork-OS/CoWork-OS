import { ApprovalDraftReview } from "./ApprovalDraftReview";
export { ApprovalDraftPreviewText } from "./ApprovalDraftReview";
import {
  type ApprovalDraftPreview,
  approvalDraftPresentation,
  responsibilityActionReviewPresentation,
} from "../../shared/approval-draft-presentation";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type {
  ApprovalRequest,
  ApprovalResponseAction,
  ApprovalType,
  PermissionPromptDetails,
} from "../../shared/types";
import { buildApprovalCommandPreview } from "../../shared/approval-command-preview";
import type { MemoryHubSource } from "../../shared/memory-hub-types";
import { SOURCE_LABELS } from "./memory/memory-knowledge-model";

type ScopeKey = "once" | "session" | "workspace" | "recurring" | "profile";

interface ScopePair {
  scope: ScopeKey;
  label: string;
  denyAction: ApprovalResponseAction;
  allowAction: ApprovalResponseAction;
}

const SCOPE_ORDER: ScopeKey[] = ["once", "session", "workspace", "recurring", "profile"];
const SCOPE_LABELS: Record<ScopeKey, string> = {
  once: "Once",
  session: "Session",
  workspace: "Workspace",
  recurring: "Recurring",
  profile: "Profile",
};

function extractScopePairs(
  actions: { action: ApprovalResponseAction; label: string }[],
): ScopePair[] | null {
  const actionSet = new Set(actions.map((a) => a.action));
  const pairs: ScopePair[] = [];

  for (const scope of SCOPE_ORDER) {
    const allow = `allow_${scope}` as ApprovalResponseAction;
    const deny = `deny_${scope}` as ApprovalResponseAction;
    if (actionSet.has(allow) || actionSet.has(deny)) {
      pairs.push({
        scope,
        label: SCOPE_LABELS[scope],
        allowAction: allow,
        denyAction: deny,
      });
    }
  }

  return pairs.length >= 2 ? pairs : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatReviewedValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (value === undefined || value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function readParamString(details: Record<string, unknown>, key: string): string | null {
  return readString(details, key) ?? readString(asRecord(details.params), key);
}

function toolNameForDetails(details: Record<string, unknown>): string | null {
  return readString(details, "tool");
}

function formatApprovalTypeLabel(type: ApprovalType, toolName?: string | null): string {
  switch (toolName) {
    case "open_application":
    case "open_url":
    case "open_path":
    case "show_in_folder":
      return "system action";
    default:
      return type === "memory_delete" ? "forget memory" : type.replace(/_/g, " ");
  }
}

function titleForApproval(type: ApprovalType, toolName?: string | null): string {
  switch (toolName) {
    case "open_application":
      return "Open application";
    case "open_url":
      return "Open URL";
    case "open_path":
      return "Open path";
    case "show_in_folder":
      return "Show in Finder";
    default:
      return titleForType(type);
  }
}

function descriptionForApproval(
  description: string,
  toolName?: string | null,
  appName?: string | null,
): string {
  if (
    toolName === "open_application" &&
    /^Approve tool call:\s*open_application\b/i.test(description)
  ) {
    return appName
      ? `Allow CoWork OS to open ${appName}?`
      : "Allow CoWork OS to open an application?";
  }
  return description;
}

function titleForType(type: ApprovalType): string {
  switch (type) {
    case "run_command":
      return "Shell command";
    case "delete_file":
      return "Delete file";
    case "delete_multiple":
      return "Delete multiple items";
    case "memory_delete":
      return "Forget a memory";
    case "bulk_rename":
      return "Bulk rename";
    case "workspace_write":
      return "Workspace change";
    case "network_access":
      return "Network access";
    case "external_file_access":
      return "External file access";
    case "external_service":
      return "External service";
    case "location_access":
      return "Location access";
    case "risk_gate":
      return "Risk review";
    case "computer_use":
      return "Computer use";
    default:
      return "Action approval";
  }
}

function iconForType(type: ApprovalType): string {
  switch (type) {
    case "delete_file":
    case "delete_multiple":
    case "memory_delete":
      return "🗑️";
    case "bulk_rename":
    case "workspace_write":
      return "📝";
    case "network_access":
      return "🌐";
    case "external_file_access":
      return "📁";
    case "external_service":
      return "🔗";
    case "location_access":
      return "📍";
    case "run_command":
      return "⌨️";
    default:
      return "⚠️";
  }
}

interface GenericApprovalDialogProps {
  approval: ApprovalRequest;
  onRespond: (action: ApprovalResponseAction, expectedRevisionHash?: string) => void;
  onApproveAllSession?: () => void;
}

export function GenericApprovalDialog({
  approval,
  onRespond,
  onApproveAllSession,
}: GenericApprovalDialogProps) {
  const [draftPreviews, setDraftPreviews] = useState<ApprovalDraftPreview[]>([]);
  const [draftPreviewLoading, setDraftPreviewLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setDraftPreviews([]);
    setDraftPreviewLoading(false);
    if (
      approval.status === "pending" &&
      approvalDraftPresentation(approval.details)?.state === "bound" &&
      typeof window !== "undefined" &&
      window.electronAPI?.getApprovalDraftPreview
    ) {
      setDraftPreviewLoading(true);
      void window.electronAPI
        .getApprovalDraftPreview(approval)
        .then((result) => {
          if (current && Array.isArray(result))
            setDraftPreviews(
              result.filter(
                (entry) =>
                  typeof entry?.text === "string" &&
                  entry.text.length <= 2000 &&
                  typeof entry.sha256 === "string" &&
                  /^[a-f0-9]{64}$/.test(entry.sha256) &&
                  typeof entry.reference === "string" &&
                  typeof entry.truncated === "boolean",
              ),
            );
        })
        .catch(() => {
          /* Stale, denied or unavailable files remain without a preview. */
        })
        .finally(() => {
          if (current) setDraftPreviewLoading(false);
        });
    }
    return () => {
      current = false;
    };
  }, [approval.id, approval.requestedAt, approval.revisionHash, approval.details, approval.status]);
  const [selectedScope, setSelectedScope] = useState<ScopeKey>("once");
  const [showAdvancedScopes, setShowAdvancedScopes] = useState(false);
  const details =
    approval.details && typeof approval.details === "object" && !Array.isArray(approval.details)
      ? (approval.details as Record<string, unknown>)
      : {};
  const draft = approvalDraftPresentation(details);
  const responsibilityActionReview = responsibilityActionReviewPresentation(approval.details);
  const toolName = toolNameForDetails(details);
  const command = typeof details.command === "string" ? details.command : null;
  const commandPreview = command ? buildApprovalCommandPreview(command) : null;
  const cwd = typeof details.cwd === "string" ? details.cwd : null;
  const timeoutMs =
    typeof details.timeout === "number" && Number.isFinite(details.timeout)
      ? details.timeout
      : null;
  const bundleScope = typeof details.bundleScope === "string" ? details.bundleScope : null;
  const path = typeof details.path === "string" ? details.path : null;
  const url = typeof details.url === "string" ? details.url : null;
  const permissionPrompt =
    details.permissionPrompt && typeof details.permissionPrompt === "object"
      ? (details.permissionPrompt as PermissionPromptDetails)
      : null;
  const appName = readParamString(details, "appName");
  const description = descriptionForApproval(approval.description, toolName, appName);
  const reviewedEffect = asRecord(details.reviewedEffect);
  const reviewedMessage = asRecord(reviewedEffect.message);
  const reviewedEvent = asRecord(reviewedEffect.event);
  const reviewedPreviousEvent = asRecord(reviewedEffect.previousEvent);
  const reviewedNotionTarget = asRecord(reviewedEffect.target);

  const rows: { label: string; value: ReactNode }[] = [];

  rows.push({ label: "Category", value: formatApprovalTypeLabel(approval.type, toolName) });

  if (toolName) {
    rows.push({
      label: "Tool",
      value: <code className="session-approval-code">{toolName}</code>,
    });
  }

  if (approval.type === "memory_delete") {
    const memoryContent = readString(details, "content");
    const memorySource = readString(details, "source");
    const memoryReason = readString(details, "reason");
    if (memoryContent) {
      rows.push({ label: "Memory", value: memoryContent });
    }
    if (memorySource) {
      rows.push({
        label: "Source",
        value: SOURCE_LABELS[memorySource as MemoryHubSource] ?? memorySource.replace(/_/g, " "),
      });
    }
    if (memoryReason) {
      rows.push({ label: "Why", value: memoryReason });
    }
    rows.push({
      label: "What happens",
      value:
        "CoWork deletes this memory, and any synced remote copy, and stops using it in future tasks.",
    });
  }

  if (toolName === "open_application") {
    if (appName) {
      rows.push({
        label: "Application",
        value: <code className="session-approval-code">{appName}</code>,
      });
    }
    rows.push({
      label: "What happens",
      value: appName
        ? `CoWork OS launches ${appName} on this computer. It may open or focus a window outside the workspace.`
        : "CoWork OS launches an application on this computer. It may open or focus a window outside the workspace.",
    });
  }

  if (command) {
    rows.push({
      label: "Command",
      value: (
        <>
          <div
            className="session-approval-code-scroll"
            role="region"
            aria-label="Command to approve"
          >
            <code className="session-approval-code session-approval-code--multiline">
              {commandPreview?.text ?? command}
            </code>
          </div>
          {commandPreview?.truncated ? (
            <p className="session-approval-preview-note">
              Preview condensed for readability. Approval still applies to the full command.
            </p>
          ) : null}
        </>
      ),
    });
  }
  if (cwd) {
    rows.push({
      label: "Working directory",
      value: <code className="session-approval-code">{cwd}</code>,
    });
  }
  if (timeoutMs !== null) {
    rows.push({
      label: "Timeout",
      value: `${Math.max(1, Math.round(timeoutMs / 1000))}s`,
    });
  }
  if (bundleScope) {
    rows.push({
      label: "Bundle",
      value: bundleScope.replace(/_/g, " "),
    });
  }
  if (path) {
    rows.push({
      label: "Path",
      value: <code className="session-approval-code">{path}</code>,
    });
  }
  if (url) {
    rows.push({
      label: "URL",
      value: <code className="session-approval-code">{url}</code>,
    });
  }
  if (permissionPrompt?.scopePreview) {
    rows.push({
      label: "Scope",
      value: permissionPrompt.scopePreview,
    });
  }
  if (permissionPrompt?.reason?.summary) {
    rows.push({
      label: "Reason",
      value: permissionPrompt.reason.summary,
    });
  }

  if (reviewedEffect.version === 1 && reviewedEffect.provider === "gmail") {
    const operation = readString(reviewedEffect, "operation");
    const emailOperation = [
      "send_draft",
      "send_email",
      "send_message",
      "reply_to_thread",
      "forward_email",
      "create_draft",
      "update_draft",
    ].includes(operation ?? "");
    const effectLabels: Record<string, string> = {
      send_draft: "Send this existing Gmail draft",
      send_email: "Send this Gmail message",
      send_message: "Send this Gmail message",
      reply_to_thread: "Reply to this Gmail thread",
      forward_email: "Forward this Gmail message",
      create_draft: "Create a Gmail draft",
      update_draft: "Update this Gmail draft",
      create_label: "Create a Gmail label",
      apply_labels: "Change labels on Gmail messages",
      bulk_label: "Change labels on matching Gmail messages",
      archive_thread: "Archive this Gmail thread",
      modify_thread_labels: "Change labels on this Gmail thread",
      batch_modify_messages: "Change labels on selected Gmail messages",
      trash_message: "Move this Gmail message to Trash",
    };
    rows.push({ label: "Effect", value: effectLabels[operation ?? ""] ?? "Change Gmail data" });
    if (emailOperation) {
      for (const [label, key] of [
        ["To", "to"],
        ["Cc", "cc"],
        ["Bcc", "bcc"],
        ["Subject", "subject"],
        ["Thread", "threadId"],
      ] as const) {
        const value = formatReviewedValue(reviewedMessage[key]);
        if (value) rows.push({ label, value });
      }
      const body = formatReviewedValue(reviewedMessage.body);
      if (body) {
        rows.push({
          label: "Message",
          value: (
            <div
              className="session-approval-code-scroll"
              role="region"
              aria-label="Message to send"
            >
              <pre className="session-approval-code session-approval-code--multiline">{body}</pre>
            </div>
          ),
        });
      }
      const attachments = reviewedMessage.attachments;
      if (Array.isArray(attachments) && attachments.length > 0) {
        rows.push({ label: "Attachments", value: formatReviewedValue(attachments) });
      }
      for (const [label, key] of [
        ["Reviewed draft revision", "draftRevisionSha256"],
        ["Source draft revision", "sourceDraftRevisionSha256"],
      ] as const) {
        const revision = readString(reviewedEffect, key);
        if (revision) rows.push({ label, value: revision });
      }
    } else {
      const target = formatReviewedValue(reviewedEffect.target);
      const change = formatReviewedValue(reviewedEffect.change);
      if (target) rows.push({ label: "Target", value: target });
      if (change) {
        rows.push({
          label: "Proposed change",
          value: (
            <div
              className="session-approval-code-scroll"
              role="region"
              aria-label="Proposed Gmail change"
            >
              <pre className="session-approval-code session-approval-code--multiline">{change}</pre>
            </div>
          ),
        });
      }
      const query = readString(reviewedMessage, "query");
      const labelName = readString(reviewedMessage, "labelName");
      const matchCount = formatReviewedValue(reviewedMessage.matchCount);
      const messageIds = formatReviewedValue(reviewedMessage.messageIdsPreview);
      const messageIdsSha256 = readString(reviewedEffect, "messageIdsSha256");
      if (query) rows.push({ label: "Search", value: query });
      if (labelName) rows.push({ label: "Label", value: labelName });
      if (matchCount) rows.push({ label: "Matched messages", value: matchCount });
      if (messageIds) rows.push({ label: "Sample message IDs", value: messageIds });
      if (messageIdsSha256) rows.push({ label: "Matched set revision", value: messageIdsSha256 });
    }
  }

  if (reviewedEffect.version === 1 && reviewedEffect.provider === "google_calendar") {
    rows.push({
      label: "Effect",
      value: `Google Calendar ${String(reviewedEffect.operation ?? "change")}`,
    });
    const calendarId = formatReviewedValue(reviewedEffect.calendarId);
    const eventId = formatReviewedValue(reviewedEffect.eventId);
    if (calendarId) rows.push({ label: "Calendar", value: calendarId });
    if (eventId) rows.push({ label: "Event ID", value: eventId });
    const summary = formatReviewedValue(reviewedEvent.summary);
    const start = formatReviewedValue(reviewedEvent.start);
    const end = formatReviewedValue(reviewedEvent.end);
    const location = formatReviewedValue(reviewedEvent.location);
    const attendees = formatReviewedValue(reviewedEvent.attendees);
    const eventDescription = formatReviewedValue(reviewedEvent.description);
    if (summary) rows.push({ label: "Event", value: summary });
    if (start) rows.push({ label: "Starts", value: start });
    if (end) rows.push({ label: "Ends", value: end });
    if (location) rows.push({ label: "Location", value: location });
    if (attendees) rows.push({ label: "Attendees", value: attendees });
    if (eventDescription) rows.push({ label: "Description", value: eventDescription });
    if (Object.keys(reviewedEvent).length > 0) {
      rows.push({
        label: "Full event change",
        value: (
          <div
            className="session-approval-code-scroll"
            role="region"
            aria-label="Full event change"
          >
            <pre className="session-approval-code session-approval-code--multiline">
              {JSON.stringify(reviewedEvent, null, 2)}
            </pre>
          </div>
        ),
      });
    }
    if (Object.keys(reviewedPreviousEvent).length > 0) {
      rows.push({
        label: "Existing event to delete",
        value: (
          <div
            className="session-approval-code-scroll"
            role="region"
            aria-label="Existing event to delete"
          >
            <pre className="session-approval-code session-approval-code--multiline">
              {JSON.stringify(reviewedPreviousEvent, null, 2)}
            </pre>
          </div>
        ),
      });
    }
  }

  if (reviewedEffect.version === 1 && reviewedEffect.provider === "notion") {
    rows.push({
      label: "Effect",
      value: `Notion ${String(reviewedEffect.operation ?? "change")}`,
    });
    const targetKind = readString(reviewedNotionTarget, "kind");
    const targetId = readString(reviewedNotionTarget, "id");
    const targetParent = formatReviewedValue(reviewedNotionTarget.parent);
    if (targetKind) rows.push({ label: "Resource", value: targetKind.replace(/_/g, " ") });
    if (targetId) rows.push({ label: "Resource ID", value: targetId });
    if (targetParent) rows.push({ label: "Parent", value: targetParent });
    const change = formatReviewedValue(reviewedEffect.change);
    if (change) {
      rows.push({
        label: "Proposed change",
        value: (
          <div
            className="session-approval-code-scroll"
            role="region"
            aria-label="Proposed Notion change"
          >
            <pre className="session-approval-code session-approval-code--multiline">{change}</pre>
          </div>
        ),
      });
    }
    const previousResource = formatReviewedValue(reviewedEffect.previousResource);
    if (previousResource) {
      rows.push({
        label: "Existing resource",
        value: (
          <div
            className="session-approval-code-scroll"
            role="region"
            aria-label="Existing Notion resource"
          >
            <pre className="session-approval-code session-approval-code--multiline">
              {previousResource}
            </pre>
          </div>
        ),
      });
    }
  }

  const suggestedActions =
    responsibilityActionReview.state !== "absent"
      ? []
      : permissionPrompt?.suggestedActions?.length
        ? permissionPrompt.suggestedActions
        : [
            { action: "deny_once" as const, label: "Deny once" },
            { action: "allow_once" as const, label: "Allow once" },
          ];

  const allScopePairs =
    responsibilityActionReview.state === "absent" ? extractScopePairs(suggestedActions) : null;
  const hasAdvancedScopes = allScopePairs?.some(
    (pair) => !["once", "session"].includes(pair.scope),
  );
  const scopePairs = allScopePairs?.filter(
    (pair) => showAdvancedScopes || pair.scope === "once" || pair.scope === "session",
  );
  const activePair = scopePairs?.find((p) => p.scope === selectedScope) ?? scopePairs?.[0];

  return (
    <div className="session-approval-overlay" role="dialog" aria-modal="true">
      <div
        className={
          commandPreview
            ? "session-approval-card session-approval-card--command"
            : "session-approval-card"
        }
      >
        <div className="session-approval-heading">
          <span className="session-approval-icon" aria-hidden="true">
            {iconForType(approval.type)}
          </span>
          <h3 className="session-approval-title">{titleForApproval(approval.type, toolName)}</h3>
        </div>
        <p className="session-approval-prompt">{description}</p>

        {rows.length > 0 && (
          <dl className="session-approval-details">
            {rows.map((row) => (
              <Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </Fragment>
            ))}
          </dl>
        )}

        <ApprovalDraftReview
          draft={draft}
          previews={draftPreviews}
          loading={draftPreviewLoading}
          responsibilityActionReview={
            responsibilityActionReview.state === "absent" ? undefined : responsibilityActionReview
          }
        />

        {responsibilityActionReview.state !== "absent" ? (
          <>
            <p className="session-approval-footer-hint">
              This decision applies only to the proposed write shown above.
            </p>
            <div className="session-approval-actions">
              <button
                type="button"
                className="session-approval-btn-deny"
                onClick={() => onRespond("deny_once", approval.revisionHash)}
              >
                Deny once
              </button>
              {responsibilityActionReview.state === "valid" && (
                <button
                  type="button"
                  className="session-approval-btn-allow"
                  onClick={() => onRespond("allow_once", approval.revisionHash)}
                >
                  Approve once
                </button>
              )}
            </div>
          </>
        ) : scopePairs ? (
          <>
            <div className="session-approval-scope-row">
              <span className="session-approval-scope-label">Remember for</span>
              <div
                className="session-approval-scope-tabs"
                role="group"
                aria-label="Permission scope"
              >
                {scopePairs.map((pair) => (
                  <button
                    key={pair.scope}
                    type="button"
                    className={
                      pair.scope === selectedScope
                        ? "session-approval-scope-tab session-approval-scope-tab--active"
                        : "session-approval-scope-tab"
                    }
                    onClick={() => setSelectedScope(pair.scope)}
                    aria-pressed={pair.scope === selectedScope}
                  >
                    {pair.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="session-approval-actions session-approval-actions--scoped">
              {hasAdvancedScopes ? (
                <button
                  type="button"
                  className="session-approval-approve-all-link"
                  aria-expanded={showAdvancedScopes}
                  onClick={() => {
                    setShowAdvancedScopes(!showAdvancedScopes);
                    setSelectedScope("once");
                  }}
                >
                  {showAdvancedScopes ? "Hide advanced rules" : "Advanced permission rules"}
                </button>
              ) : null}
              <button
                type="button"
                className="session-approval-btn-deny"
                onClick={() =>
                  activePair && onRespond(activePair.denyAction, approval.revisionHash)
                }
              >
                Deny
              </button>
              <button
                type="button"
                className="session-approval-btn-allow"
                onClick={() =>
                  activePair && onRespond(activePair.allowAction, approval.revisionHash)
                }
              >
                Allow
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="session-approval-footer-hint">
              This decision applies to the requested action and resource.
            </p>
            <div className="session-approval-actions">
              {suggestedActions.map((action) => (
                <button
                  key={action.action}
                  type="button"
                  className={
                    action.action.startsWith("allow_")
                      ? "session-approval-btn-allow"
                      : "session-approval-btn-deny"
                  }
                  onClick={() => onRespond(action.action, approval.revisionHash)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </>
        )}

        {responsibilityActionReview.state === "absent" &&
        onApproveAllSession &&
        showAdvancedScopes &&
        !details.accessProfile ? (
          <button
            type="button"
            className="session-approval-approve-all-link"
            onClick={onApproveAllSession}
          >
            Approve all for this session
          </button>
        ) : null}
      </div>
    </div>
  );
}
