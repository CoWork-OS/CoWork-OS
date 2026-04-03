import { useEffect, useMemo, useState } from "react";
import type {
  PermissionMode,
  PermissionRule,
  PermissionRuleScope,
  PermissionSettingsData,
  PersistedPermissionRule,
} from "../../shared/types";

type RuleDraft = {
  effect: "allow" | "deny" | "ask";
  scopeKind: PermissionRuleScope["kind"];
  toolName: string;
  path: string;
  prefix: string;
  serverName: string;
};

const DEFAULT_SETTINGS: PermissionSettingsData = {
  version: 1,
  defaultMode: "default",
  rules: [],
};

const DEFAULT_RULE_DRAFT: RuleDraft = {
  effect: "allow",
  scopeKind: "tool",
  toolName: "run_command",
  path: "",
  prefix: "",
  serverName: "",
};

interface PermissionSettingsPanelProps {
  workspaceId?: string;
}

function scopeToLabel(scope: PermissionRuleScope): string {
  switch (scope.kind) {
    case "tool":
      return `Tool: ${scope.toolName}`;
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

function buildScope(draft: RuleDraft): PermissionRuleScope {
  switch (draft.scopeKind) {
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

export function PermissionSettingsPanel({ workspaceId }: PermissionSettingsPanelProps) {
  const [settings, setSettings] = useState<PermissionSettingsData>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(DEFAULT_RULE_DRAFT);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [workspaceRules, setWorkspaceRules] = useState<PersistedPermissionRule[]>([]);
  const [workspaceRulesLoading, setWorkspaceRulesLoading] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    void loadWorkspaceRules(workspaceId);
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

  const saveSettings = async (next: PermissionSettingsData) => {
    try {
      setSaving(true);
      await window.electronAPI.savePermissionSettings(next);
      setSettings(next);
      setStatusMessage("Permission settings saved.");
    } catch (error) {
      console.error("Failed to save permission settings:", error);
      setStatusMessage("Failed to save permission settings.");
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
          <option value="accept_edits">Accept edits</option>
          <option value="dont_ask">Don't ask</option>
          <option value="bypass_permissions">Bypass permissions</option>
        </select>
        <p className="settings-hint">
          This mode applies when no explicit permission rule matches.
        </p>
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
