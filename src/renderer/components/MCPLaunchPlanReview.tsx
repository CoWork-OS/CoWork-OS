export interface MCPLaunchPlan {
  entryId: string;
  name: string;
  publisher?: string;
  transport: "stdio" | "sse" | "websocket" | "streamable-http";
  command?: string;
  args: string[];
  envKeys: string[];
  url?: string;
}

export interface MCPLaunchPlanPreview {
  approvalToken: string;
  expiresAt: number;
  plan: MCPLaunchPlan;
}

export function MCPLaunchPlanReview({
  plan,
  expiresAt,
  action,
  busy = false,
  disabled = false,
  onApprove,
  onCancel,
}: {
  plan: MCPLaunchPlan;
  expiresAt: number;
  action: "install" | "update";
  busy?: boolean;
  disabled?: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const verb = action === "install" ? "installation" : "update";
  const approval = action === "install" ? "Approve and install" : "Approve and update";

  return (
    <div className="mcp-modal-overlay" onClick={onCancel}>
      <div
        className="mcp-modal registry-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-launch-review-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mcp-modal-header">
          <h3 id="mcp-launch-review-title">Review MCP server {verb}</h3>
          <button
            className="mcp-modal-close"
            aria-label="Cancel launch plan review"
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <div className="mcp-modal-content">
          <p>
            {action === "install" ? "Installing" : "Updating"} <strong>{plan.name}</strong> will
            save this launch configuration on the connected host. Review the exact command and
            arguments before continuing.
          </p>
          <div className="registry-details-section">
            <div className="registry-detail-row">
              <span className="registry-detail-label">Publisher</span>
              <span className="registry-detail-value">{plan.publisher || "Unknown"}</span>
            </div>
            <div className="registry-detail-row">
              <span className="registry-detail-label">Transport</span>
              <span className="registry-detail-value">{plan.transport}</span>
            </div>
            {plan.command && (
              <div className="registry-details-command">
                <span className="registry-detail-label">Command</span>
                <code>{plan.command}</code>
              </div>
            )}
            <div className="registry-details-command">
              <span className="registry-detail-label">Arguments</span>
              {plan.args.length > 0 ? (
                <ol>
                  {plan.args.map((arg, index) => (
                    <li key={`${index}-${arg}`}>
                      <code>{arg}</code>
                    </li>
                  ))}
                </ol>
              ) : (
                <code>(none)</code>
              )}
            </div>
            {plan.envKeys.length > 0 && (
              <div className="registry-details-env">
                <span className="registry-detail-label">Environment keys</span>
                <ul>
                  {plan.envKeys.map((key) => (
                    <li key={key}>
                      <code>{key}</code> (values stay on the host)
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {plan.url && (
              <div className="registry-detail-row">
                <span className="registry-detail-label">Server URL</span>
                <code>{plan.url}</code>
              </div>
            )}
          </div>
          <p className="settings-hint">
            This approval expires at {new Date(expiresAt).toLocaleTimeString()} and applies only to
            the launch plan shown above. A changed registry plan requires a new review.
          </p>
          <div className="registry-details-actions">
            <button className="button-secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="button-primary" onClick={onApprove} disabled={disabled || busy}>
              {busy ? `${action === "install" ? "Installing" : "Updating"}...` : approval}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
