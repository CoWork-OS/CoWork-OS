import { Fragment, useState, type ReactNode } from "react";
import type {
  ApprovalRequest,
  ApprovalResponseAction,
  ApprovalType,
  PermissionPromptDetails,
} from "../../shared/types";

type ScopeKey = "once" | "session" | "workspace" | "profile";

interface ScopePair {
  scope: ScopeKey;
  label: string;
  denyAction: ApprovalResponseAction;
  allowAction: ApprovalResponseAction;
}

const SCOPE_ORDER: ScopeKey[] = ["once", "session", "workspace", "profile"];
const SCOPE_LABELS: Record<ScopeKey, string> = {
  once: "Once",
  session: "Session",
  workspace: "Workspace",
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

function titleForType(type: ApprovalType): string {
  switch (type) {
    case "run_command":
      return "Shell command";
    case "delete_file":
      return "Delete file";
    case "delete_multiple":
      return "Delete multiple items";
    case "bulk_rename":
      return "Bulk rename";
    case "network_access":
      return "Network access";
    case "external_service":
      return "External service";
    case "risk_gate":
      return "Risk review";
    case "computer_use":
    case "computer_move_mouse":
    case "computer_click":
    case "computer_type":
    case "computer_key":
      return "Computer use";
    default:
      return "Action approval";
  }
}

function iconForType(type: ApprovalType): string {
  switch (type) {
    case "delete_file":
    case "delete_multiple":
      return "🗑️";
    case "bulk_rename":
      return "📝";
    case "network_access":
      return "🌐";
    case "external_service":
      return "🔗";
    case "run_command":
      return "⌨️";
    default:
      return "⚠️";
  }
}

function formatApprovalTypeLabel(type: ApprovalType): string {
  return type.replace(/_/g, " ");
}

interface GenericApprovalDialogProps {
  approval: ApprovalRequest;
  onRespond: (action: ApprovalResponseAction) => void;
  onApproveAllSession?: () => void;
}

export function GenericApprovalDialog({
  approval,
  onRespond,
  onApproveAllSession,
}: GenericApprovalDialogProps) {
  const [selectedScope, setSelectedScope] = useState<ScopeKey>("once");
  const details =
    approval.details && typeof approval.details === "object" && !Array.isArray(approval.details)
      ? (approval.details as Record<string, unknown>)
      : {};
  const command = typeof details.command === "string" ? details.command : null;
  const cwd = typeof details.cwd === "string" ? details.cwd : null;
  const timeoutMs = typeof details.timeout === "number" && Number.isFinite(details.timeout) ? details.timeout : null;
  const bundleScope = typeof details.bundleScope === "string" ? details.bundleScope : null;
  const path = typeof details.path === "string" ? details.path : null;
  const url = typeof details.url === "string" ? details.url : null;
  const permissionPrompt =
    details.permissionPrompt && typeof details.permissionPrompt === "object"
      ? (details.permissionPrompt as PermissionPromptDetails)
      : null;

  const rows: { label: string; value: ReactNode }[] = [];

  rows.push({ label: "Category", value: formatApprovalTypeLabel(approval.type) });

  if (command) {
    rows.push({
      label: "Command",
      value: (
        <div className="session-approval-code-scroll" role="region" aria-label="Command to approve">
          <code className="session-approval-code session-approval-code--multiline">{command}</code>
        </div>
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

  const suggestedActions =
    permissionPrompt?.suggestedActions?.length
      ? permissionPrompt.suggestedActions
      : [
          { action: "deny_once" as const, label: "Deny once" },
          { action: "allow_once" as const, label: "Allow once" },
        ];

  const scopePairs = extractScopePairs(suggestedActions);
  const activePair = scopePairs?.find((p) => p.scope === selectedScope) ?? scopePairs?.[0];

  return (
    <div className="session-approval-overlay" role="dialog" aria-modal="true">
      <div className="session-approval-card">
        <div className="session-approval-icon-wrap" aria-hidden="true">
          <span className="session-approval-icon">{iconForType(approval.type)}</span>
        </div>
        <h3 className="session-approval-title">{titleForType(approval.type)}</h3>
        <p className="session-approval-prompt">{approval.description}</p>

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

        {scopePairs ? (
          <>
            <div className="session-approval-scope-row">
              <span className="session-approval-scope-label">Remember for</span>
              <div className="session-approval-scope-tabs" role="group" aria-label="Permission scope">
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
              <button
                type="button"
                className="session-approval-btn-deny"
                onClick={() => activePair && onRespond(activePair.denyAction)}
              >
                Deny
              </button>
              <button
                type="button"
                className="session-approval-btn-allow"
                onClick={() => activePair && onRespond(activePair.allowAction)}
              >
                Allow
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="session-approval-footer-hint">
              Choose a one-off decision or persist the rule for this session, workspace, or profile.
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
                  onClick={() => onRespond(action.action)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </>
        )}

        {onApproveAllSession ? (
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
