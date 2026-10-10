import { ShieldQuestion } from "lucide-react";
import type { ApprovalRequest, ApprovalResponseAction } from "../../../shared/types";

type ApprovalDetails = {
  kind?: unknown;
  origin?: unknown;
  url?: unknown;
  domain?: unknown;
  host?: unknown;
  filePath?: unknown;
  query?: unknown;
  sessionId?: unknown;
  browserSessionId?: unknown;
};

function readDetails(approval: ApprovalRequest): ApprovalDetails {
  return approval.details &&
    typeof approval.details === "object" &&
    !Array.isArray(approval.details)
    ? (approval.details as ApprovalDetails)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Approvals CoWork asks for while using the in-app browser: site access, page
 * scripts (developer mode), uploads, downloads and history search. Opening the
 * browser itself is asked before the browser exists, so it stays in the dialog.
 */
export function isBrowserTabApproval(approval: ApprovalRequest | null | undefined): boolean {
  if (!approval || approval.status !== "pending") return false;
  const kind = text(readDetails(approval).kind);
  return kind.startsWith("browser_") && kind !== "browser_visible_workbench";
}

/** The approval belongs to this workbench session, or names no session at all. */
export function approvalMatchesBrowserSession(
  approval: ApprovalRequest,
  sessionId: string,
): boolean {
  const details = readDetails(approval);
  const owner = text(details.browserSessionId) || text(details.sessionId);
  return !owner || owner === sessionId;
}

function targetLabel(details: ApprovalDetails): string {
  const origin = text(details.origin);
  if (origin) return origin;
  const url = text(details.url);
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  return text(details.domain) || text(details.host);
}

export type BrowserApprovalChoice = {
  action: ApprovalResponseAction;
  label: string;
  primary?: boolean;
};

/** Title, subject line and buttons for the card. Mirrors the chat dialogs' actions. */
export function describeBrowserApproval(approval: ApprovalRequest): {
  title: string;
  subject: string;
  choices: BrowserApprovalChoice[];
} {
  const details = readDetails(approval);
  const kind = text(details.kind);
  const target = targetLabel(details);
  if (kind === "browser_use_domain_access") {
    return {
      title: "CoWork wants to use this site",
      subject: target,
      choices: [
        { action: "deny_once", label: "Deny" },
        { action: "allow_workspace", label: "Always allow" },
        // Same as the dialog's default: allowed for the rest of this task.
        { action: "allow_session", label: "Allow", primary: true },
      ],
    };
  }
  const subject =
    kind === "browser_upload"
      ? [text(details.filePath).split(/[\\/]/).pop(), target].filter(Boolean).join(" → ")
      : kind === "browser_history_search"
        ? text(details.query)
        : target;
  return {
    title: approval.description || "CoWork needs your approval",
    subject,
    choices: [
      { action: "deny_once", label: "Deny" },
      { action: "allow_once", label: "Allow", primary: true },
    ],
  };
}

/**
 * The pending approval docked over the browser tab, so the user can decide
 * without leaving the page. It answers through the same approval bridge as
 * the chat dialog; whichever answers first wins.
 */
export function BrowserApprovalCard({
  approval,
  onRespond,
}: {
  approval: ApprovalRequest;
  onRespond: (approval: ApprovalRequest, action: ApprovalResponseAction) => void;
}) {
  const { title, subject, choices } = describeBrowserApproval(approval);
  return (
    <div
      className="browser-workbench-driving browser-workbench-approval"
      role="alertdialog"
      aria-label={title}
    >
      <span className="browser-workbench-approval-icon" aria-hidden="true">
        <ShieldQuestion size={14} />
      </span>
      <span>
        <span className="browser-workbench-approval-title">{title}</span>
        {subject && <span className="browser-workbench-driving-label"> · {subject}</span>}
      </span>
      {choices.map((choice) => (
        <button
          key={choice.action}
          type="button"
          className={choice.primary ? "is-primary" : undefined}
          onClick={() => onRespond(approval, choice.action)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
