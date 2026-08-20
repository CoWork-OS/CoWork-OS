import { useEffect, useMemo, useState } from "react";
import type {
  PermissionMode,
  PermissionRule,
  PermissionRuleScope,
  PermissionSettingsData,
  PersistedPermissionRule,
} from "../../shared/types";
import type { BuiltinToolsSettings as BuiltinToolsSettingsData } from "../../electron/agent/tools/builtin-settings";

type RuleDraft = {
  effect: "allow" | "deny" | "ask";
  scopeKind: PermissionRuleScope["kind"];
  toolName: string;
  domain: string;
  path: string;
  prefix: string;
  serverName: string;
};

type ApprovalExperiencePreset = "standard" | "fewer_prompts" | "custom";

const DEFAULT_SETTINGS: PermissionSettingsData = {
  version: 1,
  defaultMode: "dangerous_only",
  defaultShellEnabled: false,
  defaultPermissionAccess: "default",
  rules: [],
};

const DEFAULT_RULE_DRAFT: RuleDraft = {
  effect: "allow",
  scopeKind: "tool",
  toolName: "run_command",
  domain: "",
  path: "",
  prefix: "",
  serverName: "",
};

interface PermissionSettingsPanelProps {
  workspaceId?: string;
}

export function scopeToLabel(scope: PermissionRuleScope): string {
  switch (scope.kind) {
    case "tool":
      return `Tool: ${scope.toolName}`;
    case "domain":
      if (scope.toolName) {
        return `Domain: ${scope.domain} (${scope.toolName})`;
      }
      if (scope.toolPrefix) {
        return `Domain: ${scope.domain} (${scope.toolPrefix}*)`;
      }
      return `Domain: ${scope.domain}`;
    case "path":
      return scope.toolName
        ? `Path: ${scope.path} (${scope.toolName})`
        : `Path: ${scope.path}`;
    case "command_prefix":
      return `Command prefix: ${scope.prefix}`;
    case "mcp_server":
      return `MCP server: ${scope.serverName}`;
  }
  const exhaustiveCheck: never = scope;
  return exhaustiveCheck;
}

export function buildScope(draft: RuleDraft): PermissionRuleScope {
  switch (draft.scopeKind) {
    case "domain":
      return {
        kind: "domain",
        domain: draft.domain.trim(),
        ...(draft.toolName.trim() ? { toolName: draft.toolName.trim() } : {}),
      };
    case "path":
      return {
        kind: "path",
        path: draft.path.trim(),
        ...(draft.toolName.trim() ? { toolName: draft.toolName.trim() } : {}),
      };
    case "command_prefix":
      return { kind: "command_prefix", prefix: draft.prefix.trim() };
    case "mcp_server":
      return { kind: "mcp_server", serverName: draft.serverName.trim() };
    case "tool":
    default:
      return { kind: "tool", toolName: draft.toolName.trim() };
  }
}

export function applyFewerApprovalPromptsPreset<T extends BuiltinToolsSettingsData>(
  permissionSettings: PermissionSettingsData,
  builtinSettings: T,
): {
  permissionSettings: PermissionSettingsData;
  builtinSettings: T;
} {
  return {
    permissionSettings: {
      ...DEFAULT_SETTINGS,
      ...permissionSettings,
      defaultMode: "dangerous_only",
    },
    builtinSettings: {
      ...builtinSettings,
      runCommandApprovalMode: "single_bundle",
    },
  };
}

export function applyStandardApprovalPromptsPreset<T extends BuiltinToolsSettingsData>(
  permissionSettings: PermissionSettingsData,
  builtinSettings: T,
): {
  permissionSettings: PermissionSettingsData;
  builtinSettings: T;
} {
  return {
    permissionSettings: {
      ...DEFAULT_SETTINGS,
      ...permissionSettings,
      defaultMode: "default",
    },
    builtinSettings: {
      ...builtinSettings,
      runCommandApprovalMode: "per_command",
    },
  };
}

export function detectApprovalExperiencePreset(
  permissionSettings: PermissionSettingsData,
  builtinSettings: Pick<BuiltinToolsSettingsData, "runCommandApprovalMode">,
): ApprovalExperiencePreset {
  if (
    permissionSettings.defaultMode === "dangerous_only" &&
    builtinSettings.runCommandApprovalMode === "single_bundle"
  ) {
    return "fewer_prompts";
  }
  if (
    permissionSettings.defaultMode === "default" &&
    builtinSettings.runCommandApprovalMode === "per_command"
  ) {
    return "standard";
  }
  return "custom";
}

export function PermissionSettingsPanel({ workspaceId }: PermissionSettingsPanelProps) {
  const [settings, setSettings] = useState<PermissionSettingsData>(DEFAULT_SETTINGS);
  const [builtinSettings, setBuiltinSettings] = useState<BuiltinToolsSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(DEFAULT_RULE_DRAFT);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [workspaceRules, setWorkspaceRules] = useState<PersistedPermissionRule[]>([]);
  const [workspaceRulesLoading, setWorkspaceRulesLoading] = useState(false);
  const [filesystemCheckpointsEnabled, setFilesystemCheckpointsEnabled] = useState(false);
  const [filesystemCheckpointsSaving, setFilesystemCheckpointsSaving] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    void loadBuiltinSettings();
  }, []);

  useEffect(() => {
    void loadWorkspaceRules(workspaceId);
    void loadWorkspaceCheckpointSetting(workspaceId);
  }, [workspaceId]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const loaded = await window.electronAPI.getPermissionSettings();
      setSettings(loaded);
    } catch (error) {
      console.error("Failed to load permission settings:", error);
      setSettings(DEFAULT_SETTINGS);
    } finally {
      setLoading(false);
    }
  };

  const loadBuiltinSettings = async () => {
    try {
      const loaded = await window.electronAPI.getBuiltinToolsSettings();
      setBuiltinSettings(loaded);
    } catch (error) {
      console.error("Failed to load built-in tools settings:", error);
      setBuiltinSettings(null);
    }
  };

  const saveSettings = async (next: PermissionSettingsData) => {
    try {
      setSaving(true);
      await window.electronAPI.savePermissionSettings(next);
      setSettings(next);
      window.dispatchEvent(new CustomEvent("cowork:permission-settings-updated", { detail: next }));
      setStatusMessage("Permission settings saved.");
    } catch (error) {
      console.error("Failed to save permission settings:", error);
      setStatusMessage("Failed to save permission settings.");
    } finally {
      setSaving(false);
    }
  };

  const approvalPreset = useMemo(() => {
    if (!builtinSettings) return "custom";
    return detectApprovalExperiencePreset(settings, builtinSettings);
  }, [builtinSettings, settings]);

  const applyApprovalPreset = async (preset: Exclude<ApprovalExperiencePreset, "custom">) => {
    if (!builtinSettings) {
      setStatusMessage("Built-in tools settings are unavailable right now.");
      return;
    }

    const next =
      preset === "fewer_prompts"
        ? applyFewerApprovalPromptsPreset(settings, builtinSettings)
        : applyStandardApprovalPromptsPreset(settings, builtinSettings);

    try {
      setSaving(true);
      await Promise.all([
        window.electronAPI.savePermissionSettings(next.permissionSettings),
        window.electronAPI.saveBuiltinToolsSettings(next.builtinSettings),
      ]);
      setSettings(next.permissionSettings);
      setBuiltinSettings(next.builtinSettings);
      setStatusMessage(
        preset === "fewer_prompts"
          ? "Fewer approval prompts enabled."
          : "Standard approval prompts restored.",
      );
    } catch (error) {
      console.error("Failed to apply approval preset:", error);
      setStatusMessage("Failed to update approval settings.");
    } finally {
      setSaving(false);
    }
  };

  const loadWorkspaceRules = async (nextWorkspaceId?: string) => {
    if (!nextWorkspaceId) {
      setWorkspaceRules([]);
      return;
    }
    try {
      setWorkspaceRulesLoading(true);
      const rules = await window.electronAPI.getWorkspacePermissionRules(nextWorkspaceId);
      setWorkspaceRules(rules);
    } catch (error) {
      console.error("Failed to load workspace permission rules:", error);
      setWorkspaceRules([]);
    } finally {
      setWorkspaceRulesLoading(false);
    }
  };

  const loadWorkspaceCheckpointSetting = async (nextWorkspaceId?: string) => {
    if (!nextWorkspaceId) {
      setFilesystemCheckpointsEnabled(false);
      return;
    }
    try {
      const workspaces = await window.electronAPI.listWorkspaces();
      const workspace = workspaces.find((candidate) => candidate.id === nextWorkspaceId);
      setFilesystemCheckpointsEnabled(workspace?.permissions.filesystemCheckpoints === true);
    } catch (error) {
      console.error("Failed to load filesystem checkpoint setting:", error);
      setFilesystemCheckpointsEnabled(false);
    }
  };

  const toggleFilesystemCheckpoints = async (enabled: boolean) => {
    if (!workspaceId) return;
    try {
      setFilesystemCheckpointsSaving(true);
      await window.electronAPI.updateWorkspacePermissions(workspaceId, {
        filesystemCheckpoints: enabled,
      });
      setFilesystemCheckpointsEnabled(enabled);
      setStatusMessage(
        enabled
          ? "Filesystem recovery checkpoints enabled for this workspace."
          : "Filesystem recovery checkpoints disabled for this workspace.",
      );
    } catch (error) {
      console.error("Failed to update filesystem checkpoint setting:", error);
      setStatusMessage("Failed to update filesystem checkpoint setting.");
    } finally {
      setFilesystemCheckpointsSaving(false);
    }
  };

  const addRule = () => {
    const scope = buildScope(ruleDraft);
    const nextRule: PermissionRule = {
      source: "profile",
      effect: ruleDraft.effect,
      scope,
    };
    const nextSettings: PermissionSettingsData = {
      ...settings,
      rules: [...settings.rules, nextRule],
    };
    setSettings(nextSettings);
    setRuleDraft(DEFAULT_RULE_DRAFT);
    setStatusMessage("Rule added locally. Save to persist it.");
  };

  const removeRule = (index: number) => {
    const nextSettings: PermissionSettingsData = {
      ...settings,
      rules: settings.rules.filter((_, ruleIndex) => ruleIndex !== index),
    };
    setSettings(nextSettings);
    setStatusMessage("Rule removed locally. Save to persist it.");
  };

  const removeWorkspaceRule = async (ruleId: string) => {
    if (!workspaceId) return;
    try {
      setDeletingRuleId(ruleId);
      const result = await window.electronAPI.deleteWorkspacePermissionRule({
        workspaceId,
        ruleId,
      });
      if (result.success && result.removed) {
        setStatusMessage(
          result.manifestRemoved
            ? "Workspace rule removed from the database and manifest."
            : result.manifestError
              ? `Workspace rule removed from the database. Manifest removal failed: ${result.manifestError}`
              : "Workspace rule removed.",
        );
        await loadWorkspaceRules(workspaceId);
      } else {
        setStatusMessage("Failed to remove workspace rule.");
      }
    } catch (error) {
      console.error("Failed to delete workspace permission rule:", error);
      setStatusMessage("Failed to remove workspace rule.");
    } finally {
      setDeletingRuleId(null);
    }
  };

  const canAddRule = useMemo(() => {
    switch (ruleDraft.scopeKind) {
      case "tool":
        return !!ruleDraft.toolName.trim();
      case "domain":
        return !!ruleDraft.domain.trim();
      case "path":
        return !!ruleDraft.path.trim();
      case "command_prefix":
        return !!ruleDraft.prefix.trim();
      case "mcp_server":
        return !!ruleDraft.serverName.trim();
      default:
        return false;
    }
  }, [ruleDraft]);

  if (loading) {
    return <div className="settings-loading">Loading permission settings...</div>;
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h3>Permissions</h3>
      </div>
      <p className="settings-description">
        Configure the default permission mode, global profile rules, and browse or remove
        workspace-local rules for the current workspace.
      </p>

      <div className="settings-subsection">
        <h4 style={{ margin: "0 0 8px" }}>Approval experience</h4>
        <p className="settings-hint">
          Fewer prompts keeps approvals for deletes, risky shell commands, browser/system actions,
          and external side effects, while letting routine repo work proceed with less friction.
        </p>
        <p className="settings-hint" style={{ marginTop: "6px" }}>
          Current:{" "}
          {approvalPreset === "fewer_prompts"
            ? "Fewer prompts"
            : approvalPreset === "standard"
              ? "Standard prompts"
              : "Custom"}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" }}>
          <button
            className="button-small button-secondary"
            onClick={() => void applyApprovalPreset("fewer_prompts")}
            disabled={saving || !builtinSettings}
          >
            Use fewer prompts
          </button>
          <button
            className="button-small button-secondary"
            onClick={() => void applyApprovalPreset("standard")}
            disabled={saving || !builtinSettings}
          >
            Restore standard prompts
          </button>
        </div>
      </div>

      <div className="settings-subsection">
        <label className="settings-label">Default permission mode</label>
        <select
          className="settings-select"
          value={settings.defaultMode}
          onChange={(e) =>
            setSettings({
              ...settings,
              defaultMode: e.target.value as PermissionMode,
            })
          }
        >
          <option value="default">Default</option>
          <option value="plan">Plan</option>
          <option value="dangerous_only">Dangerous only</option>
          <option value="accept_edits">Accept edits</option>
          <option value="dont_ask">Don't ask</option>
          <option value="bypass_permissions">Bypass permissions</option>
        </select>
        <p className="settings-hint">
          This mode applies when no explicit permission rule matches. For everyday repo work,
          `dangerous_only` is the lower-noise option.
        </p>
      </div>

      <div className="settings-subsection">
        <h4 style={{ margin: "0 0 8px" }}>Default access</h4>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.defaultShellEnabled}
            onChange={(e) =>
              setSettings({
                ...settings,
                defaultShellEnabled: e.target.checked,
              })
            }
          />
          <span>Enable Shell for new workspaces</span>
        </label>
        <p className="settings-hint">
          New workspaces will start with the Shell toggle on. Existing workspaces keep their
          current Shell setting.
        </p>

        <label className="settings-label" style={{ marginTop: "12px" }}>
          New task access
        </label>
        <select
          className="settings-select"
          value={settings.defaultPermissionAccess}
          onChange={(e) =>
            setSettings({
              ...settings,
              defaultPermissionAccess: e.target.value === "full" ? "full" : "default",
            })
          }
        >
          <option value="default">Default permissions</option>
          <option value="full">Full access</option>
        </select>
        <p className="settings-hint">
          Full access starts new tasks with permission bypass and Shell access enabled.
        </p>
      </div>

      <div className="settings-subsection">
        <h4 style={{ margin: "0 0 8px" }}>Filesystem recovery</h4>
        {!workspaceId ? (
          <p className="settings-hint">Open a workspace to enable recovery checkpoints.</p>
        ) : (
          <>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={filesystemCheckpointsEnabled}
                disabled={filesystemCheckpointsSaving}
                onChange={(event) => void toggleFilesystemCheckpoints(event.target.checked)}
              />
              <span>Snapshot files before agent mutations</span>
            </label>
            <p className="settings-hint">
              Opt-in recovery snapshots let you inspect changes and restore a prior workspace
              state. Git metadata, dependencies, generated output, and secret-looking files are
              excluded; files over 10 MB and filesystem ACL/xattr metadata are not covered. Up to
              50 checkpoints are retained per workspace.
            </p>
          </>
        )}
      </div>

      <div className="settings-subsection">
        <h4 style={{ margin: "0 0 8px" }}>Profile rules</h4>
        {settings.rules.length === 0 ? (
          <p className="settings-hint">No profile rules saved yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {settings.rules.map((rule, index) => (
              <div
                key={`${rule.source}:${index}:${scopeToLabel(rule.scope)}`}
                className="settings-inline-input"
                style={{ alignItems: "flex-start", justifyContent: "space-between" }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="settings-label" style={{ marginBottom: "4px" }}>
                    {rule.effect.toUpperCase()} via {rule.source}
                  </div>
                  <div className="settings-hint">{scopeToLabel(rule.scope)}</div>
                </div>
                <button className="button-small button-secondary" onClick={() => removeRule(index)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-subsection">
        <h4 style={{ margin: "0 0 8px" }}>Add rule</h4>
        <div className="settings-inline-input">
          <label>Effect</label>
          <select
            className="settings-select"
            value={ruleDraft.effect}
            onChange={(e) =>
              setRuleDraft((prev) => ({ ...prev, effect: e.target.value as RuleDraft["effect"] }))
            }
          >
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
            <option value="ask">Ask</option>
          </select>
        </div>

        <div className="settings-inline-input">
          <label>Scope</label>
          <select
            className="settings-select"
            value={ruleDraft.scopeKind}
            onChange={(e) =>
              setRuleDraft((prev) => ({
                ...prev,
                scopeKind: e.target.value as RuleDraft["scopeKind"],
              }))
            }
          >
            <option value="tool">Tool</option>
            <option value="domain">Domain</option>
            <option value="path">Path</option>
            <option value="command_prefix">Command prefix</option>
            <option value="mcp_server">MCP server</option>
          </select>
        </div>

        {ruleDraft.scopeKind === "tool" && (
          <div className="settings-inline-input">
            <label>Tool name</label>
            <input
              className="settings-input"
              value={ruleDraft.toolName}
              onChange={(e) => setRuleDraft((prev) => ({ ...prev, toolName: e.target.value }))}
              placeholder="run_command"
            />
          </div>
        )}

        {ruleDraft.scopeKind === "path" && (
          <>
            <div className="settings-inline-input">
              <label>Tool name</label>
              <input
                className="settings-input"
                value={ruleDraft.toolName}
                onChange={(e) => setRuleDraft((prev) => ({ ...prev, toolName: e.target.value }))}
                placeholder="edit_file"
              />
            </div>
            <div className="settings-inline-input">
              <label>Path prefix</label>
              <input
                className="settings-input"
                value={ruleDraft.path}
                onChange={(e) => setRuleDraft((prev) => ({ ...prev, path: e.target.value }))}
                placeholder="/Users/you/project/src"
              />
            </div>
          </>
        )}

        {ruleDraft.scopeKind === "domain" && (
          <>
            <div className="settings-inline-input">
              <label>Tool name</label>
              <input
                className="settings-input"
                value={ruleDraft.toolName}
                onChange={(e) => setRuleDraft((prev) => ({ ...prev, toolName: e.target.value }))}
                placeholder="http_request"
              />
            </div>
            <div className="settings-inline-input">
              <label>Domain</label>
              <input
                className="settings-input"
                value={ruleDraft.domain}
                onChange={(e) => setRuleDraft((prev) => ({ ...prev, domain: e.target.value }))}
                placeholder="api.example.com"
              />
            </div>
          </>
        )}

        {ruleDraft.scopeKind === "command_prefix" && (
          <div className="settings-inline-input">
            <label>Command prefix</label>
            <input
              className="settings-input"
              value={ruleDraft.prefix}
              onChange={(e) => setRuleDraft((prev) => ({ ...prev, prefix: e.target.value }))}
              placeholder="git status"
            />
          </div>
        )}

        {ruleDraft.scopeKind === "mcp_server" && (
          <div className="settings-inline-input">
            <label>MCP server name</label>
            <input
              className="settings-input"
              value={ruleDraft.serverName}
              onChange={(e) => setRuleDraft((prev) => ({ ...prev, serverName: e.target.value }))}
              placeholder="github"
            />
          </div>
        )}

        <div className="settings-actions">
          <button className="button-secondary" onClick={() => setRuleDraft(DEFAULT_RULE_DRAFT)}>
            Reset Draft
          </button>
          <button className="button-secondary" onClick={loadSettings}>
            Reload
          </button>
          <button className="button-primary" onClick={addRule} disabled={!canAddRule}>
            Add Rule
          </button>
        </div>
      </div>

      {statusMessage && <div className="settings-hint">{statusMessage}</div>}

      <div className="settings-subsection">
        <h4 style={{ margin: "0 0 8px" }}>Workspace-local rules</h4>
        <p className="settings-hint">
          These rules are persisted for the current workspace and can be removed directly here.
        </p>
        {!workspaceId ? (
          <p className="settings-hint">Open a workspace to manage its local rules.</p>
        ) : workspaceRulesLoading ? (
          <p className="settings-hint">Loading workspace rules...</p>
        ) : workspaceRules.length === 0 ? (
          <p className="settings-hint">No workspace-local rules saved yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {workspaceRules.map((rule) => (
              <div
                key={rule.id || `${rule.source}:${scopeToLabel(rule.scope)}`}
                className="settings-inline-input"
                style={{ alignItems: "flex-start", justifyContent: "space-between" }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="settings-label" style={{ marginBottom: "4px" }}>
                    {rule.effect.toUpperCase()} via workspace
                  </div>
                  <div className="settings-hint">{scopeToLabel(rule.scope)}</div>
                </div>
                <button
                  className="button-small button-secondary"
                  onClick={() => void removeWorkspaceRule(rule.id || "")}
                  disabled={!rule.id || deletingRuleId === rule.id}
                >
                  {deletingRuleId === rule.id ? "Removing..." : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-actions" style={{ marginTop: "12px" }}>
        <button className="button-primary" onClick={() => void saveSettings(settings)} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
