import { useState, useEffect, useCallback } from "react";

interface AdminPolicies {
  version: number;
  updatedAt: string;
  packs: {
    allowed: string[];
    blocked: string[];
    required: string[];
  };
  connectors: {
    blocked: string[];
  };
  agents: {
    maxHeartbeatFrequencySec: number;
    maxConcurrentAgents: number;
  };
  everydayAgent: {
    blocked: boolean;
    blockedBundles: string[];
    forceReviewOnly: boolean;
    maxHeartbeatCadenceMinutes: number;
    maxConcurrentBackgroundWork: number;
    activeHours: {
      enabled: boolean;
      timezone?: string;
      windows: Array<{ days: number[]; start: string; end: string }>;
    };
  };
  runtime: ShellRuntimePolicies & {
    agentSecurity: {
      enabled: boolean;
      mode: "monitor" | "enforce";
      ruleProfile: "builtin" | "recommended" | "custom";
      customRuleDirs: string[];
      failurePolicy: "open" | "deny_high_risk";
      timeoutMs: number;
      retentionDays: number;
      scheduledScan: {
        enabled: boolean;
        intervalHours: number;
      };
      externalHooks: {
        management: "manual";
      };
    };
  };
  general: {
    allowCustomPacks: boolean;
    allowGitInstall: boolean;
    allowUrlInstall: boolean;
    orgName?: string;
    orgPluginDir?: string;
  };
}

type SandboxBackend = "macos" | "docker" | "none";

/** Shell sandbox and shell network fields of AdminPolicies.runtime. */
export interface ShellRuntimePolicies {
  requireSandboxForShell?: boolean;
  allowUnsandboxedShell?: boolean;
  allowedSandboxTypes?: SandboxBackend[];
  network?: { allowShellNetwork?: boolean };
}

const SANDBOX_BACKEND_LABELS: Record<SandboxBackend, string> = {
  macos: "macOS sandbox",
  docker: "Docker",
  none: "none (unsandboxed)",
};

function formatPolicyFlag(value: boolean | undefined): string {
  return typeof value === "boolean" ? (value ? "On" : "Off") : "Not reported";
}

/**
 * Read-only view of the admin policies that decide whether shell commands run
 * in an OS sandbox and whether they can reach the network. They are changed
 * through the admin policy file, and any loosening through the update path
 * asks for confirmation in a system dialog, so there are no controls here.
 */
export function ShellSandboxPolicySummary({
  runtime,
}: {
  runtime: ShellRuntimePolicies | undefined;
}) {
  const sandboxTypes = runtime?.allowedSandboxTypes;
  const rows: Array<{ label: string; value: string; effect: string }> = [
    {
      label: "Require OS sandbox for shell commands",
      value: formatPolicyFlag(runtime?.requireSandboxForShell),
      effect:
        "On: every shell command runs inside an OS sandbox, Full access profiles fall back to " +
        "Default for shell work, and commands are refused on a computer with no sandbox. Off: " +
        "a Full access profile may run shell commands outside the sandbox.",
    },
    {
      label: "Allow unsandboxed shell fallback",
      value: formatPolicyFlag(runtime?.allowUnsandboxedShell),
      effect:
        "On: when no allowed OS sandbox is available, a command can run without one after you " +
        "approve that single command (only while the sandbox is not required), or without a " +
        "prompt under Full access when COWORK_ALLOW_UNSANDBOXED_SHELL=1 is set. Off: such " +
        "commands are refused.",
    },
    {
      label: "Allowed sandbox backends",
      value: Array.isArray(sandboxTypes)
        ? sandboxTypes.length > 0
          ? sandboxTypes.map((type) => SANDBOX_BACKEND_LABELS[type] ?? type).join(", ")
          : "None"
        : "Not reported",
      effect:
        "Sandboxes shell commands may run in. A command whose available sandbox is not listed " +
        "is refused unless the unsandboxed fallback applies.",
    },
    {
      label: "Allow network access from shell commands",
      value: formatPolicyFlag(runtime?.network?.allowShellNetwork),
      effect:
        "On: shell commands may use the network when the workspace allows network access, the " +
        "access profile has no domain rules, and the admin network policy is unrestricted " +
        "(default allow, no allowed or blocked domains). Off: shell commands get no outbound " +
        "network access.",
    },
  ];

  return (
    <div className="settings-section">
      <h3>Shell Sandbox &amp; Network</h3>
      <p className="ap-hint">
        Read-only. Your administrator sets these in policies.json in the CoWork data folder;
        loosening any of them asks for confirmation in a system dialog.
      </p>
      {rows.map((row) => (
        <div className="ap-field" key={row.label}>
          <div className="ap-policy-row">
            <span className="ap-label">{row.label}</span>
            <span className="ap-policy-value">{row.value}</span>
          </div>
          <span className="ap-hint">{row.effect}</span>
        </div>
      ))}
    </div>
  );
}

export function AdminPoliciesPanel() {
  const [policies, setPolicies] = useState<AdminPolicies | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Editable fields
  const [blockedPacks, setBlockedPacks] = useState("");
  const [requiredPacks, setRequiredPacks] = useState("");
  const [allowedPacks, setAllowedPacks] = useState("");
  const [blockedConnectors, setBlockedConnectors] = useState("");
  const [maxHeartbeat, setMaxHeartbeat] = useState(60);
  const [maxAgents, setMaxAgents] = useState(10);
  const [everydayBlocked, setEverydayBlocked] = useState(false);
  const [everydayBlockedBundles, setEverydayBlockedBundles] = useState("");
  const [everydayReviewOnly, setEverydayReviewOnly] = useState(false);
  const [everydayMaxCadence, setEverydayMaxCadence] = useState(60);
  const [everydayMaxWork, setEverydayMaxWork] = useState(1);
  const [allowCustom, setAllowCustom] = useState(true);
  const [allowGit, setAllowGit] = useState(true);
  const [allowUrl, setAllowUrl] = useState(true);
  const [orgName, setOrgName] = useState("");
  const [orgDir, setOrgDir] = useState("");
  const [agentSecurityEnabled, setAgentSecurityEnabled] = useState(false);
  const [agentSecurityMode, setAgentSecurityMode] = useState<"monitor" | "enforce">("monitor");
  const [agentSecurityRuleProfile, setAgentSecurityRuleProfile] = useState<
    "builtin" | "recommended" | "custom"
  >("recommended");
  const [agentSecurityCustomRuleDirs, setAgentSecurityCustomRuleDirs] = useState("");
  const [agentSecurityFailurePolicy, setAgentSecurityFailurePolicy] = useState<
    "open" | "deny_high_risk"
  >("open");
  const [agentSecurityTimeoutMs, setAgentSecurityTimeoutMs] = useState(1500);
  const [agentSecurityRetentionDays, setAgentSecurityRetentionDays] = useState(30);
  const [agentSecurityScheduledScan, setAgentSecurityScheduledScan] = useState(false);
  const [agentSecurityScanIntervalHours, setAgentSecurityScanIntervalHours] = useState(24);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await window.electronAPI.getAdminPolicies();
      setPolicies(data);
      setBlockedPacks(data.packs.blocked.join(", "));
      setRequiredPacks(data.packs.required.join(", "));
      setAllowedPacks(data.packs.allowed.join(", "));
      setBlockedConnectors(data.connectors.blocked.join(", "));
      setMaxHeartbeat(data.agents.maxHeartbeatFrequencySec);
      setMaxAgents(data.agents.maxConcurrentAgents);
      setEverydayBlocked(data.everydayAgent?.blocked === true);
      setEverydayBlockedBundles((data.everydayAgent?.blockedBundles || []).join(", "));
      setEverydayReviewOnly(data.everydayAgent?.forceReviewOnly === true);
      setEverydayMaxCadence(data.everydayAgent?.maxHeartbeatCadenceMinutes || 60);
      setEverydayMaxWork(data.everydayAgent?.maxConcurrentBackgroundWork || 1);
      setAllowCustom(data.general.allowCustomPacks);
      setAllowGit(data.general.allowGitInstall);
      setAllowUrl(data.general.allowUrlInstall);
      setOrgName(data.general.orgName || "");
      setOrgDir(data.general.orgPluginDir || "");
      const security = data.runtime.agentSecurity;
      setAgentSecurityEnabled(security.enabled);
      setAgentSecurityMode(security.mode);
      setAgentSecurityRuleProfile(security.ruleProfile);
      setAgentSecurityCustomRuleDirs(security.customRuleDirs.join(", "));
      setAgentSecurityFailurePolicy(security.failurePolicy);
      setAgentSecurityTimeoutMs(security.timeoutMs);
      setAgentSecurityRetentionDays(security.retentionDays);
      setAgentSecurityScheduledScan(security.scheduledScan.enabled);
      setAgentSecurityScanIntervalHours(security.scheduledScan.intervalHours);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load policies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const parseList = (val: string): string[] =>
    val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await window.electronAPI.updateAdminPolicies({
        packs: {
          allowed: parseList(allowedPacks),
          blocked: parseList(blockedPacks),
          required: parseList(requiredPacks),
        },
        connectors: {
          blocked: parseList(blockedConnectors),
        },
        agents: {
          maxHeartbeatFrequencySec: Math.max(60, maxHeartbeat),
          maxConcurrentAgents: Math.max(1, maxAgents),
        },
        everydayAgent: {
          blocked: everydayBlocked,
          blockedBundles: parseList(everydayBlockedBundles),
          forceReviewOnly: everydayReviewOnly,
          maxHeartbeatCadenceMinutes: Math.max(5, everydayMaxCadence),
          maxConcurrentBackgroundWork: Math.max(1, everydayMaxWork),
        },
        runtime: {
          agentSecurity: {
            enabled: agentSecurityEnabled,
            mode: agentSecurityMode,
            ruleProfile: agentSecurityRuleProfile,
            customRuleDirs: parseList(agentSecurityCustomRuleDirs),
            failurePolicy: agentSecurityFailurePolicy,
            timeoutMs: Math.min(5000, Math.max(250, agentSecurityTimeoutMs)),
            retentionDays: Math.min(365, Math.max(1, agentSecurityRetentionDays)),
            scheduledScan: {
              enabled: agentSecurityScheduledScan,
              intervalHours: Math.min(168, Math.max(1, agentSecurityScanIntervalHours)),
            },
          },
        },
        general: {
          allowCustomPacks: allowCustom,
          allowGitInstall: allowGit,
          allowUrlInstall: allowUrl,
          orgName: orgName || undefined,
          orgPluginDir: orgDir || undefined,
        },
      });
      setPolicies(updated);
      setSuccess("Policies saved successfully");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save policies");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-panel">
        <h2>Admin Policies</h2>
        <p className="settings-description">Loading...</p>
      </div>
    );
  }

  return (
    <div className="settings-panel">
      <h2>Admin Policies</h2>
      <p className="settings-description">
        Configure organization-level policies for plugin packs, connectors, and agents. These
        policies apply to all users in the organization.
      </p>

      {error && <div className="ap-message ap-error">{error}</div>}
      {success && <div className="ap-message ap-success">{success}</div>}

      {/* Organization Settings */}
      <div className="settings-section">
        <h3>Organization</h3>
        <div className="ap-field">
          <label className="ap-label">Organization Name</label>
          <input
            type="text"
            className="ap-input"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="My Organization"
          />
        </div>
        <div className="ap-field">
          <label className="ap-label">Organization Plugin Directory</label>
          <input
            type="text"
            className="ap-input"
            value={orgDir}
            onChange={(e) => setOrgDir(e.target.value)}
            placeholder="/path/to/org-plugins"
          />
          <span className="ap-hint">
            Directory containing org-managed plugin packs. Packs here are loaded with scope
            "organization".
          </span>
        </div>
      </div>

      {/* Pack Policies */}
      <div className="settings-section">
        <h3>Plugin Pack Policies</h3>
        <div className="ap-field">
          <label className="ap-label">Blocked Packs</label>
          <input
            type="text"
            className="ap-input"
            value={blockedPacks}
            onChange={(e) => setBlockedPacks(e.target.value)}
            placeholder="pack-id-1, pack-id-2"
          />
          <span className="ap-hint">Comma-separated pack IDs that are blocked from use.</span>
        </div>
        <div className="ap-field">
          <label className="ap-label">Required Packs</label>
          <input
            type="text"
            className="ap-input"
            value={requiredPacks}
            onChange={(e) => setRequiredPacks(e.target.value)}
            placeholder="pack-id-1, pack-id-2"
          />
          <span className="ap-hint">
            Comma-separated pack IDs that are auto-activated and cannot be disabled.
          </span>
        </div>
        <div className="ap-field">
          <label className="ap-label">Allowed Packs (whitelist)</label>
          <input
            type="text"
            className="ap-input"
            value={allowedPacks}
            onChange={(e) => setAllowedPacks(e.target.value)}
            placeholder="Leave empty to allow all"
          />
          <span className="ap-hint">
            If set, only these packs are allowed. Leave empty to allow all.
          </span>
        </div>
      </div>

      {/* Connector Policies */}
      <div className="settings-section">
        <h3>Connector Policies</h3>
        <div className="ap-field">
          <label className="ap-label">Blocked Connectors</label>
          <input
            type="text"
            className="ap-input"
            value={blockedConnectors}
            onChange={(e) => setBlockedConnectors(e.target.value)}
            placeholder="connector-id-1, connector-id-2"
          />
          <span className="ap-hint">
            Comma-separated connector IDs that are blocked. Matches a connector type such as jira, a
            registry ID, an MCP server ID, or an exact server name. Blocked connectors cannot
            connect or run tools.
          </span>
        </div>
      </div>

      {/* Agent Policies */}
      <div className="settings-section">
        <h3>Agent Policies</h3>
        <div className="ap-row">
          <div className="ap-field ap-field-half">
            <label className="ap-label">Max Heartbeat Frequency (sec)</label>
            <input
              type="number"
              className="ap-input"
              value={maxHeartbeat}
              min={60}
              onChange={(e) => setMaxHeartbeat(parseInt(e.target.value) || 60)}
            />
            <span className="ap-hint">Minimum 60 seconds between heartbeats.</span>
          </div>
          <div className="ap-field ap-field-half">
            <label className="ap-label">Max Concurrent Agents</label>
            <input
              type="number"
              className="ap-input"
              value={maxAgents}
              min={1}
              max={50}
              onChange={(e) => setMaxAgents(parseInt(e.target.value) || 10)}
            />
            <span className="ap-hint">Maximum agents per workspace.</span>
          </div>
        </div>
      </div>

      {/* Everyday Agent Policies */}
      <div className="settings-section">
        <h3>Everyday Agent</h3>
        <label className="ap-toggle-row">
          <input
            type="checkbox"
            checked={everydayBlocked}
            onChange={(e) => setEverydayBlocked(e.target.checked)}
          />
          <span>Block Everyday Agent entirely</span>
        </label>
        <label className="ap-toggle-row">
          <input
            type="checkbox"
            checked={everydayReviewOnly}
            onChange={(e) => setEverydayReviewOnly(e.target.checked)}
          />
          <span>Force review-only mode</span>
        </label>
        <div className="ap-field">
          <label className="ap-label">Blocked Capability Bundles</label>
          <input
            type="text"
            className="ap-input"
            value={everydayBlockedBundles}
            onChange={(e) => setEverydayBlockedBundles(e.target.value)}
            placeholder="inbox, browser, memory"
          />
          <span className="ap-hint">
            Valid IDs: inbox, calendar, browser, files, docs, messages, github_work, memory,
            screen_context, remote_devices, automations.
          </span>
        </div>
        <div className="ap-row">
          <div className="ap-field ap-field-half">
            <label className="ap-label">Max Heartbeat Cadence (min)</label>
            <input
              type="number"
              className="ap-input"
              value={everydayMaxCadence}
              min={5}
              onChange={(e) => setEverydayMaxCadence(parseInt(e.target.value) || 60)}
            />
          </div>
          <div className="ap-field ap-field-half">
            <label className="ap-label">Max Background Work</label>
            <input
              type="number"
              className="ap-input"
              value={everydayMaxWork}
              min={1}
              max={20}
              onChange={(e) => setEverydayMaxWork(parseInt(e.target.value) || 1)}
            />
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3>Agent Security Runtime</h3>
        <label className="ap-toggle-row">
          <input
            type="checkbox"
            checked={agentSecurityEnabled}
            onChange={(event) => setAgentSecurityEnabled(event.target.checked)}
          />
          <span>Enable Numbat inspection for CoWork agent actions</span>
        </label>
        <div className="ap-row">
          <div className="ap-field ap-field-half">
            <label className="ap-label">Mode</label>
            <select
              className="ap-input"
              value={agentSecurityMode}
              onChange={(event) =>
                setAgentSecurityMode(event.target.value as "monitor" | "enforce")
              }
            >
              <option value="monitor">Monitor</option>
              <option value="enforce">Enforce</option>
            </select>
            <span className="ap-hint">
              Enforcement can only deny an action; it cannot bypass CoWork permissions.
            </span>
          </div>
          <div className="ap-field ap-field-half">
            <label className="ap-label">Rule Profile</label>
            <select
              className="ap-input"
              value={agentSecurityRuleProfile}
              onChange={(event) =>
                setAgentSecurityRuleProfile(
                  event.target.value as "builtin" | "recommended" | "custom",
                )
              }
            >
              <option value="recommended">CoWork recommended</option>
              <option value="builtin">Numbat built-in</option>
              <option value="custom">Custom directories</option>
            </select>
          </div>
        </div>
        {agentSecurityRuleProfile === "custom" && (
          <div className="ap-field">
            <label className="ap-label">Custom Rule Directories</label>
            <input
              type="text"
              className="ap-input"
              value={agentSecurityCustomRuleDirs}
              onChange={(event) => setAgentSecurityCustomRuleDirs(event.target.value)}
              placeholder="/absolute/path/to/rules"
            />
            <span className="ap-hint">
              Comma-separated absolute directories. Unsafe ownership or permissions are rejected at
              runtime.
            </span>
          </div>
        )}
        <div className="ap-row">
          <div className="ap-field ap-field-half">
            <label className="ap-label">Runtime Failure Policy</label>
            <select
              className="ap-input"
              value={agentSecurityFailurePolicy}
              onChange={(event) =>
                setAgentSecurityFailurePolicy(event.target.value as "open" | "deny_high_risk")
              }
            >
              <option value="open">Fail open with diagnostic</option>
              <option value="deny_high_risk">Deny high-risk actions</option>
            </select>
          </div>
          <div className="ap-field ap-field-half">
            <label className="ap-label">Hook Timeout (ms)</label>
            <input
              type="number"
              className="ap-input"
              min={250}
              max={5000}
              value={agentSecurityTimeoutMs}
              onChange={(event) =>
                setAgentSecurityTimeoutMs(Number.parseInt(event.target.value, 10) || 1500)
              }
            />
          </div>
        </div>
        <div className="ap-row">
          <div className="ap-field ap-field-half">
            <label className="ap-label">Retention (days)</label>
            <input
              type="number"
              className="ap-input"
              min={1}
              max={365}
              value={agentSecurityRetentionDays}
              onChange={(event) =>
                setAgentSecurityRetentionDays(Number.parseInt(event.target.value, 10) || 30)
              }
            />
          </div>
          <div className="ap-field ap-field-half">
            <label className="ap-label">Scheduled Scan Interval (hours)</label>
            <input
              type="number"
              className="ap-input"
              min={1}
              max={168}
              disabled={!agentSecurityScheduledScan}
              value={agentSecurityScanIntervalHours}
              onChange={(event) =>
                setAgentSecurityScanIntervalHours(Number.parseInt(event.target.value, 10) || 24)
              }
            />
            <label className="ap-toggle-row">
              <input
                type="checkbox"
                checked={agentSecurityScheduledScan}
                onChange={(event) => setAgentSecurityScheduledScan(event.target.checked)}
              />
              <span>Enable scheduled scans</span>
            </label>
          </div>
        </div>
      </div>

      <ShellSandboxPolicySummary runtime={policies?.runtime} />

      {/* Installation Policies */}
      <div className="settings-section">
        <h3>Installation Permissions</h3>
        <label className="ap-toggle-row">
          <input
            type="checkbox"
            checked={allowCustom}
            onChange={(e) => setAllowCustom(e.target.checked)}
          />
          <span>Allow users to install custom plugin packs</span>
        </label>
        <label className="ap-toggle-row">
          <input
            type="checkbox"
            checked={allowGit}
            onChange={(e) => setAllowGit(e.target.checked)}
          />
          <span>Allow installation from Git repositories</span>
        </label>
        <label className="ap-toggle-row">
          <input
            type="checkbox"
            checked={allowUrl}
            onChange={(e) => setAllowUrl(e.target.checked)}
          />
          <span>Allow installation from URLs</span>
        </label>
      </div>

      {/* Save */}
      <div className="ap-actions">
        <button type="button" className="button-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Policies"}
        </button>
        <button type="button" className="button-secondary" onClick={load}>
          Reset
        </button>
        {policies && (
          <span className="ap-updated">
            Last updated: {new Date(policies.updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      <style>{`
        .ap-message {
          padding: 10px 14px;
          border-radius: 6px;
          margin-bottom: 16px;
          font-size: 13px;
        }
        .ap-error {
          background: rgba(239, 68, 68, 0.12);
          color: var(--color-error, #ef4444);
          border: 1px solid rgba(239, 68, 68, 0.25);
        }
        .ap-success {
          background: rgba(34, 197, 94, 0.12);
          color: var(--color-success, #22c55e);
          border: 1px solid rgba(34, 197, 94, 0.25);
        }
        .ap-field {
          margin-bottom: 14px;
        }
        .ap-field-half {
          flex: 1;
          min-width: 0;
        }
        .ap-label {
          display: block;
          font-size: 13px;
          font-weight: 500;
          color: var(--color-text-primary);
          margin-bottom: 5px;
        }
        .ap-input {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 6px;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          font-size: 13px;
          box-sizing: border-box;
        }
        .ap-input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .ap-hint {
          display: block;
          font-size: 11px;
          color: var(--color-text-muted);
          margin-top: 4px;
        }
        .ap-row {
          display: flex;
          gap: 16px;
        }
        .ap-policy-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }
        .ap-policy-row .ap-label {
          margin-bottom: 0;
        }
        .ap-policy-value {
          font-size: 13px;
          font-weight: 600;
          color: var(--color-text-primary);
          white-space: nowrap;
        }
        .ap-toggle-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 0;
          font-size: 13px;
          color: var(--color-text-primary);
          cursor: pointer;
        }
        .ap-toggle-row input[type="checkbox"] {
          width: 16px;
          height: 16px;
          accent-color: var(--accent);
        }
        .ap-actions {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px solid var(--color-border-subtle);
        }
        .ap-updated {
          font-size: 11px;
          color: var(--color-text-muted);
          margin-left: auto;
        }
      `}</style>
    </div>
  );
}
