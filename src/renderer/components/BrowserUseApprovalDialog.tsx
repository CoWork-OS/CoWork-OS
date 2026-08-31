import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRequest, ApprovalResponseAction } from "../../shared/types";

interface BrowserUseApprovalDetails {
  kind?: unknown;
  origin?: unknown;
  url?: unknown;
  domain?: unknown;
}

interface BrowserUseApprovalDialogProps {
  approval: ApprovalRequest;
  onRespond: (action: ApprovalResponseAction) => void;
}

interface KeyboardTargetInfo {
  tagName?: unknown;
  role?: unknown;
  isContentEditable?: unknown;
  hasInteractiveAncestor?: unknown;
}

function readDetails(approval: ApprovalRequest): BrowserUseApprovalDetails {
  return approval.details &&
    typeof approval.details === "object" &&
    !Array.isArray(approval.details)
    ? (approval.details as BrowserUseApprovalDetails)
    : {};
}

function normalizeTargetLabel(details: BrowserUseApprovalDetails): string {
  if (typeof details.origin === "string" && details.origin.trim()) {
    return details.origin.trim();
  }
  if (typeof details.url === "string" && details.url.trim()) {
    try {
      return new URL(details.url.trim()).origin;
    } catch {
      return details.url.trim();
    }
  }
  if (typeof details.domain === "string" && details.domain.trim()) {
    return `https://${details.domain.trim()}`;
  }
  return "this domain";
}

export function isBrowserUseDomainApproval(approval: ApprovalRequest): boolean {
  return readDetails(approval).kind === "browser_use_domain_access";
}

export function getBrowserUseApprovalAction(alwaysAllow: boolean): ApprovalResponseAction {
  return alwaysAllow ? "allow_workspace" : "allow_session";
}

export function shouldIgnoreBrowserUseApprovalKeyboardShortcut(
  key: string,
  target?: KeyboardTargetInfo | null,
): boolean {
  if (key !== "Enter") return false;
  if (target?.hasInteractiveAncestor === true || target?.isContentEditable === true) return true;
  const tagName = typeof target?.tagName === "string" ? target.tagName.toLowerCase() : "";
  if (["button", "input", "select", "textarea"].includes(tagName)) return true;
  if (tagName === "a") return true;
  const role = typeof target?.role === "string" ? target.role.toLowerCase() : "";
  return role === "button" || role === "checkbox";
}

function getKeyboardTargetInfo(target: EventTarget | null): KeyboardTargetInfo {
  if (!target || typeof target !== "object") return {};
  const candidate = target as {
    tagName?: unknown;
    getAttribute?: (name: string) => string | null;
    isContentEditable?: unknown;
    closest?: (selector: string) => unknown;
  };
  return {
    tagName: candidate.tagName,
    role: typeof candidate.getAttribute === "function" ? candidate.getAttribute("role") : undefined,
    isContentEditable: candidate.isContentEditable,
    hasInteractiveAncestor:
      typeof candidate.closest === "function"
        ? Boolean(
            candidate.closest(
              "button, input, select, textarea, a[href], [role='button'], [role='checkbox'], [contenteditable='true']",
            ),
          )
        : false,
  };
}

export function getBrowserUseApprovalKeyboardAction(
  key: string,
  alwaysAllow: boolean,
  target?: KeyboardTargetInfo | null,
): ApprovalResponseAction | null {
  if (key === "Escape") return "deny_once";
  if (shouldIgnoreBrowserUseApprovalKeyboardShortcut(key, target)) return null;
  if (key === "Enter") return getBrowserUseApprovalAction(alwaysAllow);
  return null;
}

export function BrowserUseApprovalDialog({ approval, onRespond }: BrowserUseApprovalDialogProps) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const isBrowserUseApproval = isBrowserUseDomainApproval(approval);
  const details = useMemo(() => readDetails(approval), [approval]);
  const targetLabel = useMemo(() => normalizeTargetLabel(details), [details]);

  const cancel = useCallback(() => {
    onRespond("deny_once");
  }, [onRespond]);

  const allow = useCallback(() => {
    onRespond(getBrowserUseApprovalAction(alwaysAllow));
  }, [alwaysAllow, onRespond]);

  useEffect(() => {
    setAlwaysAllow(false);
  }, [approval.id]);

  useEffect(() => {
    if (!isBrowserUseApproval) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = getBrowserUseApprovalKeyboardAction(
        event.key,
        alwaysAllow,
        getKeyboardTargetInfo(event.target),
      );
      if (action) {
        event.preventDefault();
        onRespond(action);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [alwaysAllow, isBrowserUseApproval, onRespond]);

  if (!isBrowserUseApproval) {
    return null;
  }

  return (
    <div
      className="session-approval-overlay browser-use-approval-overlay"
      role="dialog"
      aria-modal="true"
    >
      <div className="browser-use-approval-card">
        <div className="browser-use-approval-header">
          <span className="browser-use-approval-glyph" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span className="browser-use-approval-name">Browser Use</span>
        </div>

        <h3 className="browser-use-approval-title">Allow Browser Use to access {targetLabel}?</h3>

        <div className="browser-use-approval-footer">
          <label className="browser-use-approval-checkbox">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(event) => setAlwaysAllow(event.currentTarget.checked)}
            />
            <span>Always allow</span>
          </label>

          <div className="browser-use-approval-actions">
            <button type="button" className="browser-use-approval-cancel" onClick={cancel}>
              <span>Cancel</span>
              <kbd>Esc</kbd>
            </button>
            <button type="button" className="browser-use-approval-allow" onClick={allow} autoFocus>
              <span>Allow</span>
              <kbd>Enter</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
