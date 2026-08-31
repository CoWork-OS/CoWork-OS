import { useEffect, useMemo, useState } from "react";
import type {
  PermissionMode,
  PermissionRule,
  PermissionRuleScope,
  PermissionSettingsData,
  PersistedPermissionRule,
} from "../../shared/types";
import {
  BUILTIN_ACCESS_PROFILE_IDS,
  BUILTIN_ACCESS_PROFILES,
  type AccessProfileDefinition,
  type AccessFilesystemRule,
  type AccessProfileId,
} from "../../shared/access-profiles";
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
  defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
  accessProfiles: [],
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

const DEFAULT_CUSTOM_PROFILE: AccessProfileDefinition = {
  id: "custom_workspace",
  label: "Custom workspace",
  description: "A named CoWork access profile.",
  sandbox: "workspace-write",
  approval: "on-request",
  reviewer: "user",
  network: "on-request",
};

function updateProfileList(
  profiles: AccessProfileDefinition[],
  profileId: AccessProfileId,
  patch: Partial<AccessProfileDefinition>,
): AccessProfileDefinition[] {
  return profiles.map((profile) =>
    profile.id === profileId ? { ...profile, ...patch, id: profile.id } : profile,
  );
}

function normalizeProfileList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeFilesystemRules(value: string): AccessFilesystemRule[] {
  const rules = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf(":");
      const access = separator >= 0 ? item.slice(0, separator).trim() : "";
      const rulePath = separator >= 0 ? item.slice(separator + 1).trim() : "";
      if (!rulePath || !["read", "write", "deny"].includes(access)) return null;
      return { access: access as AccessFilesystemRule["access"], path: rulePath };
    })
    .filter((rule): rule is AccessFilesystemRule => rule !== null);
  return rules;
}

function normalizeDomainRules(value: string): NonNullable<AccessProfileDefinition["domainRules"]> {
  const rules = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf(":");
      const access = separator >= 0 ? item.slice(0, separator).trim() : "";
      const pattern = separator >= 0 ? item.slice(separator + 1).trim() : "";
      if (!pattern || !["allow", "deny"].includes(access)) return null;
      return { access: access as "allow" | "deny", pattern };
    })
    .filter((rule): rule is { access: "allow" | "deny"; pattern: string } => rule !== null);
  return rules;
}

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
      return scope.toolName ? `Path: ${scope.path} (${scope.toolName})` : `Path: ${scope.path}`;
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
      defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.approveForMe,
      defaultPermissionAccess: "default",
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
      defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
      defaultPermissionAccess: "default",
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
    (permissionSettings.defaultAccessProfileId === BUILTIN_ACCESS_PROFILE_IDS.approveForMe ||
      permissionSettings.defaultMode === "dangerous_only") &&
    builtinSettings.runCommandApprovalMode === "single_bundle"
  ) {
    return "fewer_prompts";
  }
  if (
    (permissionSettings.defaultAccessProfileId === BUILTIN_ACCESS_PROFILE_IDS.askForApproval ||
      permissionSettings.defaultMode === "default") &&
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
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);
  const [newProfile, setNewProfile] = useState<AccessProfileDefinition>(DEFAULT_CUSTOM_PROFILE);

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    void loadBuiltinSettings();
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
      window.dispatchEvent(
        new CustomEvent("cowork:permission-settings-updated", {
          detail: next.permissionSettings,
        }),
      );
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

  const addCustomProfile = () => {
    const id = newProfile.id.trim();
    const label = newProfile.label.trim();
    if (!id || !label || BUILTIN_ACCESS_PROFILES.some((profile) => profile.id === id)) {
      setStatusMessage("Choose a unique custom profile ID and label.");
      return;
    }
    if (settings.accessProfiles?.some((profile) => profile.id === id)) {
      setStatusMessage("That custom profile ID is already in use.");
      return;
    }
    setSettings({
      ...settings,
      accessProfiles: [...(settings.accessProfiles || []), { ...newProfile, id, label }],
    });
    setNewProfile({
      ...DEFAULT_CUSTOM_PROFILE,
      id: `custom_${(settings.accessProfiles?.length || 0) + 2}`,
      label: "Custom profile",
    });
    setStatusMessage("Custom profile added locally. Save to persist it.");
  };

  const removeCustomProfile = (profileId: AccessProfileId) => {
    const nextProfiles = (settings.accessProfiles || []).filter(
      (profile) => profile.id !== profileId,
    );
    setSettings({
      ...settings,
      accessProfiles: nextProfiles,
      ...(settings.defaultAccessProfileId === profileId
        ? { defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval }
        : {}),
    });
    setStatusMessage("Custom profile removed locally. Save to persist it.");
  };

  const inheritanceOptions = [...BUILTIN_ACCESS_PROFILES, ...(settings.accessProfiles || [])];

  if (loading) {
    return <div className="settings-loading">Loading permission settings...</div>;
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h3>Permissions</h3>
      </div>
      <p className="settings-description">
        Configure task access profiles, the legacy permission fallback, global profile rules, and
        workspace-local rules for the current workspace.
      </p>

      <div className="settings-subsection">
        <h4 style={{ margin: "0 0 8px" }}>Approval experience</h4>
        <p className="settings-hint">
          Fewer prompts keeps approvals for deletes, risky command tools, browser/system actions,
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
        <label className="settings-label">Legacy fallback mode (advanced)</label>
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
          Named access profiles control new tasks. This compatibility fallback is retained for older
          tasks and API callers that do not select a profile.
        </p>
      </div>

      <div className="settings-subsection">
        <h4 style={{ margin: "0 0 8px" }}>Default access</h4>
        <label className="settings-label" style={{ marginTop: "12px" }}>
          New task access
        </label>
        <select
          className="settings-select"
          value={
            settings.defaultAccessProfileId ||
            (settings.defaultPermissionAccess === "full"
              ? BUILTIN_ACCESS_PROFILE_IDS.fullAccess
              : BUILTIN_ACCESS_PROFILE_IDS.askForApproval)
          }
          onChange={(e) =>
            setSettings({
              ...settings,
              defaultAccessProfileId: e.target.value,
              defaultPermissionAccess:
                e.target.value === BUILTIN_ACCESS_PROFILE_IDS.fullAccess ? "full" : "default",
            })
          }
        >
          {BUILTIN_ACCESS_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
          {(settings.accessProfiles || []).map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
        <p className="settings-hint">
          Command tools are governed by this access profile. Ask and Approve for me use the
          workspace-write boundary; Full access disables the local sandbox and approval prompts.
          Custom profiles can narrow the command-tool surface further.
        </p>
      </div>

      <div className="settings-subsection">
        <h4 style={{ margin: "0 0 8px" }}>Custom access profiles</h4>
        <p className="settings-hint">
          Named profiles are stored in encrypted settings and applied by the main process. Use
          comma- or newline-separated paths and domains when a profile needs additional scope.
        </p>
        {(settings.accessProfiles || []).length === 0 ? (
          <p className="settings-hint">No custom profiles yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "12px" }}>
            {(settings.accessProfiles || []).map((profile) => (
              <div
                key={profile.id}
                className="settings-inline-input"
                style={{ display: "grid", gap: "8px" }}
              >
                <div className="settings-label">{profile.id}</div>
                <input
                  className="settings-input"
                  value={profile.label}
                  aria-label={`${profile.id} label`}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      accessProfiles: updateProfileList(settings.accessProfiles || [], profile.id, {
                        label: e.target.value,
                      }),
                    })
                  }
                />
                <input
                  className="settings-input"
                  value={profile.description}
                  aria-label={`${profile.id} description`}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      accessProfiles: updateProfileList(settings.accessProfiles || [], profile.id, {
                        description: e.target.value,
                      }),
                    })
                  }
                />
                <div className="settings-inline-input">
                  <label htmlFor={`${profile.id}-extends`}>Inherit from</label>
                  <select
                    id={`${profile.id}-extends`}
                    className="settings-select"
                    value={profile.extends || ""}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        accessProfiles: updateProfileList(
                          settings.accessProfiles || [],
                          profile.id,
                          {
                            extends: e.target.value
                              ? (e.target.value as AccessProfileId)
                              : undefined,
                          },
                        ),
                      })
                    }
                  >
                    <option value="">None</option>
                    {inheritanceOptions
                      .filter((candidate) => candidate.id !== profile.id)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.label}
                        </option>
                      ))}
                  </select>
                  <span className="settings-hint">
                    Inheritance can narrow access, but cannot widen the parent boundary.
                  </span>
                </div>
                <div className="settings-inline-input">
                  <label>Sandbox</label>
                  <select
                    className="settings-select"
                    value={profile.sandbox}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        accessProfiles: updateProfileList(
                          settings.accessProfiles || [],
                          profile.id,
                          {
                            sandbox: e.target.value as AccessProfileDefinition["sandbox"],
                          },
                        ),
                      })
                    }
                  >
                    <option value="read-only">Read-only</option>
                    <option value="workspace-write">Workspace-write</option>
                    <option value="danger-full-access">Danger full access</option>
                  </select>
                </div>
                <div className="settings-inline-input">
                  <label>Approval</label>
                  <select
                    className="settings-select"
                    value={profile.approval}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        accessProfiles: updateProfileList(
                          settings.accessProfiles || [],
                          profile.id,
                          {
                            approval: e.target.value as AccessProfileDefinition["approval"],
                          },
                        ),
                      })
                    }
                  >
                    <option value="untrusted">Untrusted</option>
                    <option value="on-request">On request</option>
                    <option value="never">Never</option>
                  </select>
                </div>
                <div className="settings-inline-input">
                  <label>Reviewer</label>
                  <select
                    className="settings-select"
                    value={profile.reviewer}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        accessProfiles: updateProfileList(
                          settings.accessProfiles || [],
                          profile.id,
                          {
                            reviewer: e.target.value as AccessProfileDefinition["reviewer"],
                          },
                        ),
                      })
                    }
                  >
                    <option value="user">User</option>
                    <option value="auto-review">Auto-review</option>
                    <option value="none">None</option>
                  </select>
                </div>
                <div className="settings-inline-input">
                  <label>Network</label>
                  <select
                    className="settings-select"
                    value={profile.network}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        accessProfiles: updateProfileList(
                          settings.accessProfiles || [],
                          profile.id,
                          {
                            network: e.target.value as AccessProfileDefinition["network"],
                          },
                        ),
                      })
                    }
                  >
                    <option value="disabled">Disabled</option>
                    <option value="on-request">On request</option>
                    <option value="enabled">Enabled</option>
                  </select>
                </div>
                <p className="settings-help">
                  Command tools follow this profile&apos;s access mode. There is no separate shell
                  switch.
                </p>
                <input
                  className="settings-input"
                  value={(profile.workspaceRoots || []).join(", ")}
                  aria-label={`${profile.id} additional roots`}
                  placeholder="Additional workspace roots"
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      accessProfiles: updateProfileList(settings.accessProfiles || [], profile.id, {
                        workspaceRoots: normalizeProfileList(e.target.value),
                      }),
                    })
                  }
                />
                <input
                  className="settings-input"
                  value={(profile.filesystemRules || [])
                    .map((rule) => `${rule.access}:${rule.path}`)
                    .join(", ")}
                  aria-label={`${profile.id} filesystem rules`}
                  placeholder="Filesystem rules: read:/path, write:/path, deny:/path"
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      accessProfiles: updateProfileList(settings.accessProfiles || [], profile.id, {
                        filesystemRules: normalizeFilesystemRules(e.target.value),
                      }),
                    })
                  }
                />
                <input
                  className="settings-input"
                  value={(profile.domainRules || [])
                    .map((rule) => `${rule.access}:${rule.pattern}`)
                    .join(", ")}
                  aria-label={`${profile.id} domain rules`}
                  placeholder="Domain rules: allow:example.com, deny:private.example.com"
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      accessProfiles: updateProfileList(settings.accessProfiles || [], profile.id, {
                        domainRules: normalizeDomainRules(e.target.value),
                      }),
                    })
                  }
                />
                <button
                  className="button-small button-secondary"
                  onClick={() => removeCustomProfile(profile.id)}
                >
                  Remove profile
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className="settings-inline-input"
          style={{ display: "grid", gap: "8px", marginTop: "12px" }}
        >
          <label>New profile ID</label>
          <input
            className="settings-input"
            value={newProfile.id}
            onChange={(e) => setNewProfile((profile) => ({ ...profile, id: e.target.value }))}
            placeholder="custom_workspace"
          />
          <label>Display label</label>
          <input
            className="settings-input"
            value={newProfile.label}
            onChange={(e) => setNewProfile((profile) => ({ ...profile, label: e.target.value }))}
            placeholder="Custom workspace"
          />
          <label htmlFor="new-access-profile-extends">Inherit from</label>
          <select
            id="new-access-profile-extends"
            className="settings-select"
            value={newProfile.extends || ""}
            onChange={(e) =>
              setNewProfile((profile) => ({
                ...profile,
                extends: e.target.value ? (e.target.value as AccessProfileId) : undefined,
              }))
            }
          >
            <option value="">None</option>
            {inheritanceOptions
              .filter((candidate) => candidate.id !== newProfile.id)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
          </select>
          <button className="button-secondary" onClick={addCustomProfile} disabled={saving}>
            Add custom profile
          </button>
        </div>
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
        <button
          className="button-primary"
          onClick={() => void saveSettings(settings)}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
