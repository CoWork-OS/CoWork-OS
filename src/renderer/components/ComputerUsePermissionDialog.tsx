/**
 * Permission dialog for Computer Use Agent sessions.
 *
 * When the CUA wants to interact with a desktop app, this dialog asks the
 * user to approve access at a specific level (full_control or view_only).
 */

interface AppPermissionItem {
  appName: string;
  bundleId?: string;
  requestedLevel: "full_control" | "view_only";
}

interface ComputerUsePermissionDialogProps {
  apps: AppPermissionItem[];
  reason: string;
  onAllow: (level: "full_control" | "view_only") => void;
  onDeny: () => void;
}

export function ComputerUsePermissionDialog({
  apps,
  reason,
  onAllow,
  onDeny,
}: ComputerUsePermissionDialogProps) {
  return (
    <div
      style={{
        background: "var(--bg-primary, #fff)",
        border: "1px solid var(--border-primary, #e0e0e0)",
        borderRadius: 12,
        padding: 20,
        maxWidth: 400,
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          marginBottom: 8,
          color: "var(--text-primary, #1a1a1a)",
        }}
      >
        Turn on computer use?
      </div>

      <p
        style={{
          fontSize: 13,
          color: "var(--text-secondary, #666)",
          lineHeight: 1.5,
          marginBottom: 16,
        }}
      >
        Claude will take screenshots of your screen and control your mouse and keyboard. You&apos;ll
        approve each app, but not confirm each step Claude performs.
      </p>

      <div
        style={{
          fontSize: 12,
          color: "var(--text-secondary, #888)",
          marginBottom: 12,
        }}
      >
        <strong>Keep in mind:</strong>
        <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
          <li>Some actions can&apos;t be undone.</li>
          <li>Apps you approve could open other apps you haven&apos;t approved.</li>
          <li>Close anything sensitive you don&apos;t want Claude to see.</li>
        </ul>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-secondary, #888)",
            marginBottom: 8,
          }}
        >
          Claude wants to use:
        </div>
        {apps.map((app) => (
          <div
            key={app.appName}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 0",
              borderBottom: "1px solid var(--border-secondary, #f0f0f0)",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 500 }}>{app.appName}</span>
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 4,
                background:
                  app.requestedLevel === "full_control"
                    ? "rgba(224, 122, 58, 0.12)"
                    : "rgba(100, 160, 230, 0.12)",
                color: app.requestedLevel === "full_control" ? "#c05a20" : "#3a7bbf",
              }}
            >
              {app.requestedLevel === "full_control" ? "Full control" : "View only"}
            </span>
          </div>
        ))}
      </div>

      {reason && (
        <p style={{ fontSize: 12, color: "var(--text-tertiary, #999)", marginBottom: 16 }}>
          {reason}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onDeny}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            borderRadius: 8,
            border: "1px solid var(--border-primary, #e0e0e0)",
            background: "transparent",
            cursor: "pointer",
            color: "var(--text-primary, #333)",
          }}
        >
          Deny
        </button>
        <button
          onClick={() => onAllow(apps[0]?.requestedLevel ?? "view_only")}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            borderRadius: 8,
            border: "none",
            background: "var(--accent-primary, #1a1a1a)",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Allow for this session
        </button>
      </div>
    </div>
  );
}
