/**
 * ContextPolicySettings - Per-context security policy configuration
 *
 * Allows configuring different security modes for DM vs group chats:
 * - Security mode (open, allowlist, pairing)
 * - Tool restrictions per context
 */

import { useState } from "react";
import { ContextType, SecurityMode, ContextPolicy } from "../../shared/types";

interface ContextPolicySettingsProps {
  /** Channel ID for the policies */
  channelId: string;
  /** Channel type (telegram, discord, etc.) */
  channelType: string;
  /** Initial policies from backend */
  policies?: {
    dm?: Partial<ContextPolicy>;
    group?: Partial<ContextPolicy>;
  };
  /** Callback when policy changes */
  onPolicyChange: (
    contextType: ContextType,
    updates: { securityMode?: SecurityMode; toolRestrictions?: string[] },
  ) => void;
  /** Whether changes are being saved */
  isSaving?: boolean;
}

// Tool groups that can be restricted
const TOOL_GROUPS = [
  {
    id: "group:memory",
    name: "Memory Tools",
    description: "Clipboard read/write access",
    defaultDeniedInGroup: true,
  },
  {
    id: "group:system",
    name: "System Tools",
    description: "Screenshot, app launch, system info",
    defaultDeniedInGroup: false,
  },
  {
    id: "group:network",
    name: "Network Tools",
    description: "Browser and web access",
    defaultDeniedInGroup: false,
  },
  {
    id: "group:destructive",
    name: "Destructive Tools",
    description: "File deletion and shell commands",
    defaultDeniedInGroup: false,
  },
];

const SECURITY_MODES: { value: SecurityMode; label: string; description: string }[] = [
  {
    value: "pairing",
    label: "Pairing (Recommended)",
    description: "Users must enter a pairing code to connect",
  },
  {
    value: "allowlist",
    label: "Allowlist",
    description: "Only pre-approved users can interact",
  },
  {
    value: "open",
    label: "Open",
    description: "Anyone can interact (use with caution)",
  },
];

export function ContextPolicySettings({
  channelId: _channelId,
  channelType,
  policies = {},
  onPolicyChange,
  isSaving = false,
}: ContextPolicySettingsProps) {
  const [activeTab, setActiveTab] = useState<ContextType>("dm");

  // Get policy for current tab
  const currentPolicy = activeTab === "dm" ? policies.dm : policies.group;
  const securityMode = currentPolicy?.securityMode || "pairing";
  const toolRestrictions = currentPolicy?.toolRestrictions || [];

  const handleSecurityModeChange = (mode: SecurityMode) => {
    onPolicyChange(activeTab, { securityMode: mode });
  };

  const handleToolRestrictionToggle = (toolGroup: string) => {
    const newRestrictions = toolRestrictions.includes(toolGroup)
      ? toolRestrictions.filter((t) => t !== toolGroup)
      : [...toolRestrictions, toolGroup];
    onPolicyChange(activeTab, { toolRestrictions: newRestrictions });
  };

  // Check if this channel type supports groups
  const supportsGroups = [
    "telegram",
    "discord",
    "slack",
    "signal",
    "matrix",
    "mattermost",
    "teams",
    "googlechat",
    "feishu",
    "wecom",
  ].includes(channelType);

  return (
    <div className="context-policy-settings">
      {/* Context Tabs */}
      {supportsGroups && (
        <div className="context-tabs">
          <button
            className={`tab ${activeTab === "dm" ? "active" : ""}`}
            onClick={() => setActiveTab("dm")}
          >
            <DMIcon />
            Direct Messages
          </button>
          <button
            className={`tab ${activeTab === "group" ? "active" : ""}`}
            onClick={() => setActiveTab("group")}
          >
            <GroupIcon />
            Group Chats
          </button>
        </div>
      )}

      {/* Security Mode */}
      <div className="settings-section">
        <h4>Security Mode</h4>
        <p className="section-description">
          How users are authorized to interact in{" "}
          {activeTab === "dm" ? "direct messages" : "group chats"}
        </p>
        <div className="security-mode-options">
          {SECURITY_MODES.map((mode) => (
            <label
              key={mode.value}
              className={`mode-option ${securityMode === mode.value ? "selected" : ""}`}
            >
              <input
                type="radio"
                name={`security-mode-${activeTab}`}
                value={mode.value}
                checked={securityMode === mode.value}
                onChange={() => handleSecurityModeChange(mode.value)}
                disabled={isSaving}
              />
              <div className="mode-content">
                <span className="mode-label">{mode.label}</span>
                <span className="mode-description">{mode.description}</span>
              </div>
              {securityMode === mode.value && <CheckIcon />}
            </label>
          ))}
        </div>

        {securityMode === "open" && (
          <div className="warning-banner">
            <WarningIcon />
            <span>
              Open mode allows anyone to interact with the bot. Use only in trusted environments.
            </span>
          </div>
        )}
      </div>

      {/* Tool Restrictions */}
      <div className="settings-section">
        <h4>Tool Restrictions</h4>
        <p className="section-description">
          Restrict which tool groups are available in this context
        </p>
        <div className="tool-restrictions">
          {TOOL_GROUPS.map((group) => {
            const isDenied = toolRestrictions.includes(group.id);
            const isDefaultDenied = activeTab === "group" && group.defaultDeniedInGroup;

            return (
              <label key={group.id} className={`tool-option ${isDenied ? "denied" : "allowed"}`}>
                <div className="tool-toggle">
                  <input
                    type="checkbox"
                    checked={!isDenied}
                    onChange={() => handleToolRestrictionToggle(group.id)}
                    disabled={isSaving}
                  />
                  <span className="toggle-slider" />
                </div>
                <div className="tool-content">
                  <span className="tool-name">{group.name}</span>
                  <span className="tool-description">{group.description}</span>
                  {isDefaultDenied && !isDenied && (
                    <span className="tool-warning">Not recommended for groups</span>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      </div>

      {/* Context Comparison */}
      {supportsGroups && (
        <div className="context-comparison">
          <h4>Policy Comparison</h4>
          <table>
            <thead>
              <tr>
                <th>Setting</th>
                <th>DMs</th>
                <th>Groups</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Security Mode</td>
                <td>{policies.dm?.securityMode || "pairing"}</td>
                <td>{policies.group?.securityMode || "pairing"}</td>
              </tr>
              <tr>
                <td>Memory Tools</td>
                <td>
                  {policies.dm?.toolRestrictions?.includes("group:memory") ? "Denied" : "Allowed"}
                </td>
                <td>
                  {policies.group?.toolRestrictions?.includes("group:memory")
                    ? "Denied"
                    : "Allowed"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <style>{`
        .context-policy-settings {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .context-tabs {
          display: flex;
          gap: 8px;
          padding: 4px;
          background: var(--color-bg-tertiary, #0f0f1a);
          border-radius: 8px;
        }

        .tab {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 10px 16px;
          background: transparent;
          border: none;
          border-radius: 6px;
          color: var(--color-text-secondary, #a0a0b0);
          font-size: 14px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .tab:hover {
          color: var(--color-text-primary, #fff);
          background: var(--color-bg-secondary, #1a1a2e);
        }

        .tab.active {
          background: var(--color-accent, #6366f1);
          color: white;
        }

        .settings-section {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .settings-section h4 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          color: var(--color-text-primary, #fff);
        }

        .section-description {
          margin: 0;
          font-size: 13px;
          color: var(--color-text-secondary, #a0a0b0);
        }

        .security-mode-options {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .mode-option {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          background: var(--color-bg-tertiary, #0f0f1a);
          border: 2px solid transparent;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .mode-option:hover {
          border-color: var(--color-border, #2d2d44);
        }

        .mode-option.selected {
          border-color: var(--color-accent, #6366f1);
          background: rgba(99, 102, 241, 0.1);
        }

        .mode-option input {
          display: none;
        }

        .mode-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .mode-label {
          font-size: 14px;
          font-weight: 500;
          color: var(--color-text-primary, #fff);
        }

        .mode-description {
          font-size: 12px;
          color: var(--color-text-secondary, #a0a0b0);
        }

        .warning-banner {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          background: rgba(245, 158, 11, 0.1);
          border: 1px solid rgba(245, 158, 11, 0.3);
          border-radius: 6px;
          font-size: 13px;
          color: var(--color-warning, #f59e0b);
        }

        .tool-restrictions {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .tool-option {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          background: var(--color-bg-tertiary, #0f0f1a);
          border-radius: 8px;
          cursor: pointer;
        }

        .tool-toggle {
          position: relative;
          width: 44px;
          height: 24px;
        }

        .tool-toggle input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .toggle-slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: var(--color-error, #ef4444);
          transition: 0.3s;
          border-radius: 24px;
        }

        .toggle-slider:before {
          position: absolute;
          content: "";
          height: 18px;
          width: 18px;
          left: 3px;
          bottom: 3px;
          background-color: white;
          transition: 0.3s;
          border-radius: 50%;
        }

        .tool-toggle input:checked + .toggle-slider {
          background-color: var(--color-success, #22c55e);
        }

        .tool-toggle input:checked + .toggle-slider:before {
          transform: translateX(20px);
        }

        .tool-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .tool-name {
          font-size: 14px;
          font-weight: 500;
          color: var(--color-text-primary, #fff);
        }

        .tool-description {
          font-size: 12px;
          color: var(--color-text-secondary, #a0a0b0);
        }

        .tool-warning {
          font-size: 11px;
          color: var(--color-warning, #f59e0b);
          font-style: italic;
        }

        .context-comparison {
          padding: 16px;
          background: var(--color-bg-tertiary, #0f0f1a);
          border-radius: 8px;
        }

        .context-comparison h4 {
          margin: 0 0 12px 0;
          font-size: 13px;
          font-weight: 600;
          color: var(--color-text-secondary, #a0a0b0);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .context-comparison table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .context-comparison th,
        .context-comparison td {
          padding: 8px 12px;
          text-align: left;
          border-bottom: 1px solid var(--color-border, #2d2d44);
        }

        .context-comparison th {
          font-weight: 500;
          color: var(--color-text-secondary, #a0a0b0);
        }

        .context-comparison td {
          color: var(--color-text-primary, #fff);
        }

        .context-comparison tr:last-child td {
          border-bottom: none;
        }
      `}</style>
    </div>
  );
}

// Icon components
function DMIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export default ContextPolicySettings;
