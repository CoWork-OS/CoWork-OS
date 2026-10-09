import { AlertTriangle, ExternalLink, RotateCw, ShieldOff, Unplug } from "lucide-react";
import type { BrowserTab } from "./browser-tabs-model";

type BrowserTabNoticeProps = {
  tab: BrowserTab;
  onRetry: () => void;
  onReloadCrashed: () => void;
  onGoBack: () => void;
  onOpenExternal: (url: string) => void;
  onOpenAccessSettings?: () => void;
};

const POLICY_DETAILS: Record<string, string> = {
  profile_domain_denied: "This task's access profile blocks this domain.",
  profile_domain_not_allowed:
    "This task's access profile only allows specific domains, and this is not one of them.",
  profile_network_disabled: "Network access is turned off in this task's access profile.",
  workspace_network_disabled: "This workspace does not have network permission.",
  blocked_domain: "Your administrator's network policy blocks this domain.",
  domain_not_in_admin_allowlist: "Your administrator's network policy only allows listed domains.",
  admin_default_deny: "Your administrator's network policy blocks sites by default.",
  internal_address_blocked: "Private and internal network addresses are blocked.",
  legacy_guardrail_domain_denied: "The guardrail domain list blocks this site.",
};

function describeBrowserBlock(
  reason: string,
  detail?: string,
): {
  title: string;
  body: string;
} {
  if (reason === "local_preview") {
    return {
      title: "Local page not opened",
      body: "Local dev servers and files open only when you or a preview start them. Allow it to load this page in this session.",
    };
  }
  if (reason === "scheme") {
    return {
      title: "This link can't open here",
      body: detail
        ? `The in-app browser opens web pages only, not "${detail}:" links.`
        : "The in-app browser opens web pages only.",
    };
  }
  return {
    title: "Blocked by access settings",
    body: (detail && POLICY_DETAILS[detail]) || "The task's access settings block this site.",
  };
}

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Blocked, failed and crashed pages, shown inside the tab instead of a silent no-op. */
export function BrowserTabNotice({
  tab,
  onRetry,
  onReloadCrashed,
  onGoBack,
  onOpenExternal,
  onOpenAccessSettings,
}: BrowserTabNoticeProps) {
  if (tab.crashed) {
    return (
      <div className="browser-workbench-notice" role="alert">
        <div className="browser-workbench-notice-card">
          <Unplug className="browser-workbench-notice-icon" size={22} aria-hidden="true" />
          <h3>{tab.crashed === "clean-exit" ? "This page closed" : "This page crashed"}</h3>
          <p>The page's process stopped ({tab.crashed}). Reload to open it again.</p>
          <div className="browser-workbench-notice-actions">
            <button type="button" className="is-primary" onClick={onReloadCrashed}>
              <RotateCw size={14} aria-hidden="true" />
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (tab.blocked) {
    const { title, body } = describeBrowserBlock(tab.blocked.reason, tab.blocked.detail);
    const blockedUrl = tab.blocked.url;
    return (
      <div className="browser-workbench-notice" role="alert">
        <div className="browser-workbench-notice-card">
          <ShieldOff className="browser-workbench-notice-icon" size={22} aria-hidden="true" />
          <h3>{title}</h3>
          <p>{body}</p>
          <code className="browser-workbench-notice-url" title={blockedUrl}>
            {blockedUrl}
          </code>
          <div className="browser-workbench-notice-actions">
            {tab.blocked.reason === "local_preview" && (
              <button type="button" className="is-primary" onClick={onRetry}>
                Allow and open
              </button>
            )}
            {tab.canGoBack && (
              <button type="button" onClick={onGoBack}>
                Go back
              </button>
            )}
            {tab.blocked.reason === "policy" && onOpenAccessSettings && (
              <button type="button" onClick={onOpenAccessSettings}>
                Access settings
              </button>
            )}
            {isWebUrl(blockedUrl) && tab.blocked.reason !== "local_preview" && (
              <button type="button" onClick={() => onOpenExternal(blockedUrl)}>
                <ExternalLink size={14} aria-hidden="true" />
                Open in browser
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (tab.loadError) {
    const failedUrl = tab.loadError.url;
    return (
      <div className="browser-workbench-notice" role="alert">
        <div className="browser-workbench-notice-card">
          <AlertTriangle className="browser-workbench-notice-icon" size={22} aria-hidden="true" />
          <h3>This page couldn't load</h3>
          <p>{tab.loadError.description}</p>
          <code className="browser-workbench-notice-url" title={failedUrl}>
            {failedUrl}
          </code>
          <div className="browser-workbench-notice-actions">
            <button type="button" className="is-primary" onClick={onRetry}>
              <RotateCw size={14} aria-hidden="true" />
              Try again
            </button>
            {tab.canGoBack && (
              <button type="button" onClick={onGoBack}>
                Go back
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
