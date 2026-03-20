import { useEffect, useMemo, useState } from "react";
import type {
  AutonomyConfig,
  AutonomyDecision,
  AutonomyAction,
  ChiefOfStaffWorldModel,
  AwarenessBelief,
  AwarenessConfig,
  AwarenessSource,
  AwarenessSummary,
  MemoryFeaturesSettings,
  Workspace,
  WorkspaceKitStatus,
} from "../../shared/types";
import { MemorySettings } from "./MemorySettings";

const DEFAULT_FEATURES: MemoryFeaturesSettings = {
  contextPackInjectionEnabled: true,
  heartbeatMaintenanceEnabled: true,
};

type BadgeTone = "neutral" | "success" | "warning" | "error";

function badgeClass(tone: BadgeTone) {
  return `settings-badge settings-badge--${tone}`;
}

function formatTimestamp(timestamp?: number): string | null {
  if (!timestamp) return null;
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return null;
  }
}

function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatConfidence(confidence?: number): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "n/a";
  return `${Math.round(confidence * 100)}%`;
}

export function MemoryHubSettings(props?: {
  initialWorkspaceId?: string;
  onSettingsChanged?: () => void;
}) {
  const [features, setFeatures] = useState<MemoryFeaturesSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [kitStatus, setKitStatus] = useState<WorkspaceKitStatus | null>(null);
  const [kitLoading, setKitLoading] = useState(false);
  const [kitBusy, setKitBusy] = useState(false);
  const [kitPreset, setKitPreset] = useState<"default" | "venture_operator">("default");
  const [newProjectId, setNewProjectId] = useState("");
  const [awarenessConfig, setAwarenessConfig] = useState<AwarenessConfig | null>(null);
  const [awarenessBeliefs, setAwarenessBeliefs] = useState<AwarenessBelief[]>([]);
  const [awarenessSummary, setAwarenessSummary] = useState<AwarenessSummary | null>(null);
  const [awarenessSaving, setAwarenessSaving] = useState(false);
  const [autonomyConfig, setAutonomyConfig] = useState<AutonomyConfig | null>(null);
  const [autonomyState, setAutonomyState] = useState<ChiefOfStaffWorldModel | null>(null);
  const [autonomyDecisions, setAutonomyDecisions] = useState<AutonomyDecision[]>([]);
  const [autonomyActions, setAutonomyActions] = useState<AutonomyAction[]>([]);
  const [autonomySaving, setAutonomySaving] = useState(false);

  const selectedWorkspace = useMemo(() => {
    return workspaces.find((w) => w.id === selectedWorkspaceId) || null;
  }, [workspaces, selectedWorkspaceId]);

  const kitHealth = useMemo(() => {
    const files = kitStatus?.files || [];
    return {
      staleCount: files.filter((file) => file.stale).length,
      warningCount: kitStatus?.lintWarningCount || 0,
      errorCount: kitStatus?.lintErrorCount || 0,
    };
  }, [kitStatus]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setKitStatus(null);
      setAwarenessBeliefs([]);
      setAwarenessSummary(null);
      setAutonomyState(null);
      setAutonomyDecisions([]);
      setAutonomyActions([]);
      return;
    }
    void refreshKit();
    void refreshAwareness();
    void refreshAutonomy();
  }, [selectedWorkspaceId]);

  const loadAll = async () => {
    try {
      setLoading(true);

      const [
        loadedFeatures,
        loadedWorkspaces,
        tempWorkspace,
        loadedAwarenessConfig,
        loadedAutonomyConfig,
      ] = await Promise.all([
        window.electronAPI.getMemoryFeaturesSettings().catch(() => DEFAULT_FEATURES),
        window.electronAPI.listWorkspaces().catch(() => [] as Workspace[]),
        window.electronAPI.getTempWorkspace().catch(() => null as Workspace | null),
        window.electronAPI.getAwarenessConfig().catch(() => null as AwarenessConfig | null),
        window.electronAPI.getAutonomyConfig().catch(() => null as AutonomyConfig | null),
      ]);

      const combined: Workspace[] = [
        ...(tempWorkspace ? [tempWorkspace] : []),
        ...loadedWorkspaces.filter((w) => w.id !== tempWorkspace?.id),
      ];

      setFeatures(loadedFeatures);
      setAwarenessConfig(loadedAwarenessConfig);
      setAutonomyConfig(loadedAutonomyConfig);
      setWorkspaces(combined);
      setSelectedWorkspaceId((prev) => {
        const preferred = (props?.initialWorkspaceId || "").trim();
        if (preferred && combined.some((w) => w.id === preferred)) return preferred;
        if (prev && combined.some((w) => w.id === prev)) return prev;
        return combined[0]?.id || "";
      });
    } finally {
      setLoading(false);
    }
  };

  const refreshKit = async () => {
    if (!selectedWorkspaceId) return;
    try {
      setKitLoading(true);
      const status = await window.electronAPI.getWorkspaceKitStatus(selectedWorkspaceId);
      setKitStatus(status);
    } catch (error) {
      console.error("Failed to load workspace kit status:", error);
      setKitStatus(null);
    } finally {
      setKitLoading(false);
    }
  };

  const refreshAwareness = async () => {
    if (!selectedWorkspaceId) return;
    try {
      const [beliefs, summary] = await Promise.all([
        window.electronAPI.listAwarenessBeliefs(selectedWorkspaceId).catch(() => [] as AwarenessBelief[]),
        window.electronAPI.getAwarenessSummary(selectedWorkspaceId).catch(() => null as AwarenessSummary | null),
      ]);
      setAwarenessBeliefs(beliefs);
      setAwarenessSummary(summary);
    } catch (error) {
      console.error("Failed to load awareness state:", error);
    }
  };

  const refreshAutonomy = async () => {
    if (!selectedWorkspaceId) return;
    try {
      const [worldModel, decisions, actions] = await Promise.all([
        window.electronAPI.getAutonomyState(selectedWorkspaceId).catch(() => null as ChiefOfStaffWorldModel | null),
        window.electronAPI.listAutonomyDecisions(selectedWorkspaceId).catch(() => [] as AutonomyDecision[]),
        window.electronAPI.listAutonomyActions(selectedWorkspaceId).catch(() => [] as AutonomyAction[]),
      ]);
      setAutonomyState(worldModel);
      setAutonomyDecisions(decisions);
      setAutonomyActions(actions);
    } catch (error) {
      console.error("Failed to load autonomy state:", error);
    }
  };

  const initKit = async () => {
    if (!selectedWorkspaceId) return;
    try {
      setKitBusy(true);
      const status = await window.electronAPI.initWorkspaceKit({
        workspaceId: selectedWorkspaceId,
        mode: "missing",
        templatePreset: kitPreset,
      });
      setKitStatus(status);
    } catch (error) {
      console.error("Failed to initialize workspace kit:", error);
    } finally {
      setKitBusy(false);
    }
  };

  const createProject = async () => {
    if (!selectedWorkspaceId) return;
    const projectId = newProjectId.trim();
    if (!projectId) return;
    try {
      setKitBusy(true);
      await window.electronAPI.createWorkspaceKitProject({
        workspaceId: selectedWorkspaceId,
        projectId,
      });
      setNewProjectId("");
      await refreshKit();
    } catch (error) {
      console.error("Failed to create project folder:", error);
    } finally {
      setKitBusy(false);
    }
  };

  const saveFeatures = async (updates: Partial<MemoryFeaturesSettings>) => {
    const next: MemoryFeaturesSettings = { ...(features || DEFAULT_FEATURES), ...updates };
    setFeatures(next);
    try {
      setSaving(true);
      await window.electronAPI.saveMemoryFeaturesSettings(next);
    } catch (error) {
      console.error("Failed to save memory feature settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const saveAwarenessConfig = async (nextConfig: AwarenessConfig) => {
    setAwarenessConfig(nextConfig);
    try {
      setAwarenessSaving(true);
      const saved = await window.electronAPI.saveAwarenessConfig(nextConfig);
      setAwarenessConfig(saved);
    } catch (error) {
      console.error("Failed to save awareness config:", error);
    } finally {
      setAwarenessSaving(false);
    }
  };

  const updateAwarenessSource = async (
    source: AwarenessSource,
    updates: Partial<AwarenessConfig["sources"][AwarenessSource]>,
  ) => {
    if (!awarenessConfig) return;
    await saveAwarenessConfig({
      ...awarenessConfig,
      sources: {
        ...awarenessConfig.sources,
        [source]: {
          ...awarenessConfig.sources[source],
          ...updates,
        },
      },
    });
  };

  const updateBelief = async (belief: AwarenessBelief, patch: Record<string, unknown>) => {
    try {
      await window.electronAPI.updateAwarenessBelief(belief.id, patch);
      await refreshAwareness();
    } catch (error) {
      console.error("Failed to update awareness belief:", error);
    }
  };

  const deleteBelief = async (beliefId: string) => {
    try {
      await window.electronAPI.deleteAwarenessBelief(beliefId);
      await refreshAwareness();
    } catch (error) {
      console.error("Failed to delete awareness belief:", error);
    }
  };

  const saveAutonomyConfig = async (nextConfig: AutonomyConfig) => {
    setAutonomyConfig(nextConfig);
    try {
      setAutonomySaving(true);
      const saved = await window.electronAPI.saveAutonomyConfig(nextConfig);
      setAutonomyConfig(saved);
    } catch (error) {
      console.error("Failed to save autonomy config:", error);
    } finally {
      setAutonomySaving(false);
    }
  };

  const updateDecision = async (decisionId: string, patch: Record<string, unknown>) => {
    try {
      await window.electronAPI.updateAutonomyDecision(decisionId, patch);
      await refreshAutonomy();
    } catch (error) {
      console.error("Failed to update autonomy decision:", error);
    }
  };

  if (loading || !features) {
    return (
      <div className="settings-section">
        <div className="settings-loading">Loading memory settings...</div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Memory</h2>
      <p className="settings-section-description">
        Control memory-related features globally and per workspace.
      </p>

      <div className="settings-subsection">
        <h3>Global Toggles</h3>

        <div className="settings-form-group">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "12px",
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                Enable Workspace Context Pack Injection
              </div>
              <p className="settings-form-hint" style={{ marginTop: "4px", marginBottom: 0 }}>
                When enabled, the app may inject redacted notes from <code>.cowork/</code> into
                agent context to improve continuity.
              </p>
            </div>
            <label className="settings-toggle" style={{ flexShrink: 0, marginTop: "2px" }}>
              <input
                type="checkbox"
                checked={features.contextPackInjectionEnabled}
                onChange={(e) => saveFeatures({ contextPackInjectionEnabled: e.target.checked })}
                disabled={saving}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>

        <div className="settings-form-group">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "12px",
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                Enable Maintenance Heartbeats
              </div>
              <p className="settings-form-hint" style={{ marginTop: "4px", marginBottom: 0 }}>
                When enabled, lead agents treat <code>.cowork/HEARTBEAT.md</code> as the recurring
                checks contract for proactive maintenance, while staying silent unless they find
                something actionable.
              </p>
            </div>
            <label className="settings-toggle" style={{ flexShrink: 0, marginTop: "2px" }}>
              <input
                type="checkbox"
                checked={features.heartbeatMaintenanceEnabled}
                onChange={(e) => saveFeatures({ heartbeatMaintenanceEnabled: e.target.checked })}
                disabled={saving}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>

      {awarenessConfig && (
        <div className="settings-subsection">
          <h3>Ambient Awareness</h3>
          <p className="settings-form-hint">
            Control which local signals CoWork can observe, promote into durable beliefs, inject
            into prompts, and use for heartbeats.
          </p>

          <div className="settings-form-group">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: "12px",
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                  Private Mode
                </div>
                <p className="settings-form-hint" style={{ marginTop: "4px", marginBottom: 0 }}>
                  Suspends higher-sensitivity collectors like browser, clipboard, and notifications
                  while keeping task execution available.
                </p>
              </div>
              <label className="settings-toggle" style={{ flexShrink: 0, marginTop: "2px" }}>
                <input
                  type="checkbox"
                  checked={awarenessConfig.privateModeEnabled}
                  onChange={(e) =>
                    void saveAwarenessConfig({
                      ...awarenessConfig,
                      privateModeEnabled: e.target.checked,
                    })
                  }
                  disabled={awarenessSaving}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="awareness-grid">
            <div className="awareness-grid-header">
              <div>Source</div>
              <div>Enabled</div>
              <div>Promote</div>
              <div>Inject</div>
              <div>Heartbeat</div>
              <div>TTL (min)</div>
            </div>
            {Object.entries(awarenessConfig.sources).map(([source, policy]) => (
              <div key={source} className="awareness-grid-row">
                <div>
                  <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{source}</div>
                  <div style={{ color: "var(--color-text-secondary)", marginTop: "4px" }}>
                    TTL {policy.ttlMinutes} min
                  </div>
                </div>
                <label className="settings-toggle" title="Enabled">
                  <input
                    type="checkbox"
                    checked={policy.enabled}
                    onChange={(e) =>
                      void updateAwarenessSource(source as AwarenessSource, { enabled: e.target.checked })
                    }
                    disabled={awarenessSaving}
                  />
                  <span className="toggle-slider" />
                </label>
                <label className="settings-toggle" title="Promote to beliefs">
                  <input
                    type="checkbox"
                    checked={policy.allowPromotion}
                    onChange={(e) =>
                      void updateAwarenessSource(source as AwarenessSource, {
                        allowPromotion: e.target.checked,
                      })
                    }
                    disabled={awarenessSaving}
                  />
                  <span className="toggle-slider" />
                </label>
                <label className="settings-toggle" title="Inject into prompts">
                  <input
                    type="checkbox"
                    checked={policy.allowPromptInjection}
                    onChange={(e) =>
                      void updateAwarenessSource(source as AwarenessSource, {
                        allowPromptInjection: e.target.checked,
                      })
                    }
                    disabled={awarenessSaving}
                  />
                  <span className="toggle-slider" />
                </label>
                <label className="settings-toggle" title="Use for heartbeat">
                  <input
                    type="checkbox"
                    checked={policy.allowHeartbeat}
                    onChange={(e) =>
                      void updateAwarenessSource(source as AwarenessSource, {
                        allowHeartbeat: e.target.checked,
                      })
                    }
                    disabled={awarenessSaving}
                  />
                  <span className="toggle-slider" />
                </label>
                <input
                  className="settings-input"
                  type="number"
                  min={5}
                  max={24 * 60}
                  value={policy.ttlMinutes}
                  onChange={(e) =>
                    void updateAwarenessSource(source as AwarenessSource, {
                      ttlMinutes: Math.max(5, Number(e.target.value) || 5),
                    })
                  }
                  disabled={awarenessSaving}
                />
              </div>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: "12px",
              marginTop: "12px",
            }}
          >
            <div className="settings-card">
              <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
                What CoWork Currently Believes
              </div>
              <p className="settings-form-hint" style={{ marginTop: "6px" }}>
                Stable beliefs promoted from conversation and local computer context.
              </p>
              {awarenessBeliefs.length === 0 ? (
                <div className="settings-empty">No promoted beliefs yet for this workspace.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {awarenessBeliefs.slice(0, 12).map((belief) => (
                    <div
                      key={belief.id}
                      className="settings-card"
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: "8px",
                          alignItems: "center",
                        }}
                      >
                        <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                          {belief.subject}
                        </div>
                        <span className={badgeClass(belief.promotionStatus === "confirmed" ? "success" : "neutral")}>
                          {belief.promotionStatus}
                        </span>
                      </div>
                      <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--color-text-primary)" }}>
                        {belief.value}
                      </div>
                      <div
                        style={{
                          marginTop: "6px",
                          display: "flex",
                          gap: "8px",
                          flexWrap: "wrap",
                          color: "var(--color-text-secondary)",
                          fontSize: "11px",
                        }}
                      >
                        <span>{belief.beliefType}</span>
                        <span>confidence {formatConfidence(belief.confidence)}</span>
                        <span>source {belief.source}</span>
                      </div>
                      <div style={{ marginTop: "8px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        <button
                          className="settings-button"
                          onClick={() =>
                            void updateBelief(belief, {
                              promotionStatus: "confirmed",
                              confidence: 1,
                            })
                          }
                        >
                          Confirm
                        </button>
                        <button
                          className="settings-button"
                          onClick={() =>
                            void updateBelief(belief, {
                              confidence: Math.max(0.1, belief.confidence - 0.15),
                            })
                          }
                        >
                          Lower confidence
                        </button>
                        <button
                          className="settings-button"
                          onClick={() => void deleteBelief(belief.id)}
                        >
                          Forget
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="settings-card">
              <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
                Current Awareness Summary
              </div>
              <p className="settings-form-hint" style={{ marginTop: "6px" }}>
                Live summary of focus, high-signal context changes, and due-soon items.
              </p>
              <div style={{ fontSize: "12px", color: "var(--color-text-primary)" }}>
                <strong>Current focus:</strong> {awarenessSummary?.currentFocus || "Unknown"}
              </div>
              <div style={{ marginTop: "10px" }}>
                <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>What matters now</div>
                {(awarenessSummary?.whatMattersNow || []).slice(0, 5).map((item) => (
                  <div key={item.id} style={{ marginTop: "8px", fontSize: "12px" }}>
                    <div style={{ color: "var(--color-text-primary)" }}>{item.title}</div>
                    {item.detail && (
                      <div style={{ color: "var(--color-text-secondary)", marginTop: "2px" }}>
                        {item.detail}
                      </div>
                    )}
                  </div>
                ))}
                {(awarenessSummary?.whatMattersNow || []).length === 0 && (
                  <p className="settings-form-hint">No current high-signal awareness items.</p>
                )}
              </div>
              <div style={{ marginTop: "12px" }}>
                <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>Due soon</div>
                {(awarenessSummary?.dueSoon || []).slice(0, 5).map((item) => (
                  <div key={item.id} style={{ marginTop: "8px", fontSize: "12px" }}>
                    <div style={{ color: "var(--color-text-primary)" }}>{item.title}</div>
                    {item.detail && (
                      <div style={{ color: "var(--color-text-secondary)", marginTop: "2px" }}>
                        {item.detail}
                      </div>
                    )}
                  </div>
                ))}
                {(awarenessSummary?.dueSoon || []).length === 0 && (
                  <p className="settings-form-hint">No due-soon signals right now.</p>
                )}
              </div>
            </div>
          </div>

          {autonomyConfig && (
            <div style={{ marginTop: "12px" }}>
              <div className="settings-card">
                <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
                  Chief of Staff Mode
                </div>
                <p className="settings-form-hint" style={{ marginTop: "6px" }}>
                  Controls goal-driven planning, intervention generation, and bounded local
                  execution.
                </p>
                <div style={{ display: "grid", gap: "10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                    <span style={{ fontSize: "13px", color: "var(--color-text-primary)" }}>Enable chief-of-staff engine</span>
                    <label className="settings-toggle" style={{ flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        checked={autonomyConfig.enabled}
                        onChange={(e) =>
                          void saveAutonomyConfig({
                            ...autonomyConfig,
                            enabled: e.target.checked,
                          })
                        }
                        disabled={autonomySaving}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                    <span style={{ fontSize: "13px", color: "var(--color-text-primary)" }}>Auto-evaluate on ambient changes</span>
                    <label className="settings-toggle" style={{ flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        checked={autonomyConfig.autoEvaluate}
                        onChange={(e) =>
                          void saveAutonomyConfig({
                            ...autonomyConfig,
                            autoEvaluate: e.target.checked,
                          })
                        }
                        disabled={autonomySaving}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: "10px",
                    }}
                  >
                    {Object.entries(autonomyConfig.actionPolicies).map(([actionType, policy]) => (
                      <div key={actionType} className="settings-card">
                        <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                          {actionType}
                        </div>
                        <div style={{ marginTop: "8px" }}>
                          <select
                            className="settings-select"
                            value={policy.level}
                            onChange={(e) =>
                              void saveAutonomyConfig({
                                ...autonomyConfig,
                                actionPolicies: {
                                  ...autonomyConfig.actionPolicies,
                                  [actionType]: {
                                    ...policy,
                                    level: e.target.value as typeof policy.level,
                                  },
                                },
                              })
                            }
                            disabled={autonomySaving}
                          >
                            <option value="observe_only">Observe only</option>
                            <option value="suggest_only">Suggest only</option>
                            <option value="execute_local">Execute local</option>
                            <option value="execute_with_approval">Approval required</option>
                            <option value="never">Never</option>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      className="settings-button"
                      onClick={() => void refreshAutonomy()}
                      disabled={autonomySaving}
                    >
                      Refresh state
                    </button>
                    <button
                      className="settings-button primary"
                      onClick={async () => {
                        await window.electronAPI.triggerAutonomyEvaluation(selectedWorkspaceId);
                        await refreshAutonomy();
                      }}
                      disabled={autonomySaving}
                    >
                      Evaluate now
                    </button>
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                  gap: "12px",
                  marginTop: "12px",
                }}
              >
                <div className="settings-card">
                  <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
                    World Model
                  </div>
                  <p className="settings-form-hint" style={{ marginTop: "6px" }}>
                    What CoWork thinks is active right now.
                  </p>
                  <div style={{ fontSize: "12px", color: "var(--color-text-primary)" }}>
                    <strong>Focus:</strong> {autonomyState?.focusSession?.focusLabel || "Unknown"}
                  </div>
                  <div style={{ marginTop: "10px" }}>
                    <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>Goals</div>
                    {(autonomyState?.goals || []).slice(0, 4).map((goal) => (
                      <div key={goal.id} style={{ marginTop: "8px", fontSize: "12px" }}>
                        <div>{goal.title}</div>
                        <div style={{ color: "var(--color-text-secondary)" }}>
                          {goal.status} • confidence {formatConfidence(goal.confidence)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: "10px" }}>
                    <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>Open loops</div>
                    {(autonomyState?.openLoops || []).slice(0, 4).map((loop) => (
                      <div key={loop.id} style={{ marginTop: "8px", fontSize: "12px" }}>
                        <div>{loop.title}</div>
                        <div style={{ color: "var(--color-text-secondary)" }}>
                          {loop.dueAt ? formatTimestamp(loop.dueAt) : "No due date"}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: "10px" }}>
                    <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>Routines</div>
                    {(autonomyState?.routines || []).slice(0, 3).map((routine) => (
                      <div key={routine.id} style={{ marginTop: "8px", fontSize: "12px" }}>
                        <div>{routine.title}</div>
                        <div style={{ color: "var(--color-text-secondary)" }}>{routine.description}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="settings-card">
                  <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
                    Pending Interventions
                  </div>
                  <p className="settings-form-hint" style={{ marginTop: "6px" }}>
                    What chief-of-staff mode wants to do next and why.
                  </p>
                  {(autonomyDecisions || []).slice(0, 8).map((decision) => (
                    <div key={decision.id} className="settings-card" style={{ marginTop: "8px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                        <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                          {decision.title}
                        </div>
                        <span className={badgeClass(decision.priority === "high" ? "warning" : "neutral")}>
                          {decision.status}
                        </span>
                      </div>
                      <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--color-text-primary)" }}>
                        {decision.description}
                      </div>
                      <div style={{ marginTop: "6px", fontSize: "11px", color: "var(--color-text-secondary)" }}>
                        {decision.actionType} • {decision.policyLevel} • {decision.reason}
                      </div>
                      <div style={{ marginTop: "8px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        {decision.status !== "done" && (
                          <button className="settings-button" onClick={() => void updateDecision(decision.id, { status: "done" })}>
                            Mark done
                          </button>
                        )}
                        {decision.status !== "dismissed" && (
                          <button className="settings-button" onClick={() => void updateDecision(decision.id, { status: "dismissed" })}>
                            Dismiss
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {autonomyDecisions.length === 0 && (
                    <div className="settings-empty">No pending chief-of-staff interventions.</div>
                  )}
                </div>

                <div className="settings-card">
                  <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
                    Recent Actions
                  </div>
                  <p className="settings-form-hint" style={{ marginTop: "6px" }}>
                    Local actions the engine already attempted.
                  </p>
                  {(autonomyActions || []).slice(0, 8).map((action) => (
                    <div key={action.id} style={{ marginTop: "8px", fontSize: "12px" }}>
                      <div style={{ color: "var(--color-text-primary)" }}>{action.summary}</div>
                      <div style={{ color: "var(--color-text-secondary)" }}>
                        {action.actionType} • {action.status} • {formatTimestamp(action.createdAt)}
                      </div>
                    </div>
                  ))}
                  {autonomyActions.length === 0 && (
                    <div className="settings-empty">No recent chief-of-staff actions yet.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="settings-subsection">
        <h3>Per Workspace</h3>

        {workspaces.length === 0 ? (
          <p className="settings-form-hint">No workspaces found.</p>
        ) : (
          <div className="settings-form-group">
            <label className="settings-label">Workspace</label>
            <select
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="settings-select"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {selectedWorkspace?.path && (
              <p className="settings-form-hint">
                Path: <code>{selectedWorkspace.path}</code>
              </p>
            )}
            <div style={{ marginTop: "10px" }}>
              <label className="settings-label">Kit Preset</label>
              <select
                value={kitPreset}
                onChange={(e) =>
                  setKitPreset(
                    e.target.value === "venture_operator" ? "venture_operator" : "default",
                  )
                }
                className="settings-select"
              >
                <option value="default">Default workspace kit</option>
                <option value="venture_operator">Venture operator kit</option>
              </select>
              <p className="settings-form-hint">
                Venture operator mode seeds company, KPI, and operating-loop files for founder-led
                autonomous workflows.
              </p>
            </div>
          </div>
        )}

        {selectedWorkspaceId && (
          <div className="settings-form-group" style={{ marginTop: "10px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
              }}
            >
              <div>
                <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                  Workspace Kit
                </div>
                <p className="settings-form-hint" style={{ margin: 0 }}>
                  Creates recommended <code>.cowork/</code> files for shared, durable context.
                </p>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  className="settings-button"
                  onClick={() => void refreshKit()}
                  disabled={kitLoading || kitBusy}
                >
                  {kitLoading ? "Refreshing…" : "Refresh"}
                </button>
                <button
                  className="settings-button primary"
                  onClick={() => void initKit()}
                  disabled={kitBusy}
                >
                  {kitBusy ? "Working…" : "Initialize"}
                </button>
              </div>
            </div>

            {kitStatus && (
              <div style={{ marginTop: "10px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  <span className={badgeClass(kitStatus.hasKitDir ? "success" : "warning")}>
                    {kitStatus.hasKitDir ? ".cowork ready" : ".cowork missing"}
                  </span>
                  <span className={badgeClass(kitStatus.missingCount > 0 ? "error" : "success")}>
                    {kitStatus.missingCount} missing
                  </span>
                  <span className={badgeClass(kitHealth.errorCount > 0 ? "error" : "neutral")}>
                    {kitHealth.errorCount} lint error{kitHealth.errorCount === 1 ? "" : "s"}
                  </span>
                  <span className={badgeClass(kitHealth.warningCount > 0 ? "warning" : "neutral")}>
                    {kitHealth.warningCount} warning{kitHealth.warningCount === 1 ? "" : "s"}
                  </span>
                  <span className={badgeClass(kitHealth.staleCount > 0 ? "warning" : "neutral")}>
                    {kitHealth.staleCount} stale
                  </span>
                  {kitStatus.onboarding && (
                    <span
                      className={badgeClass(
                        kitStatus.onboarding.onboardingCompletedAt
                          ? "success"
                          : kitStatus.onboarding.bootstrapPresent
                            ? "warning"
                            : "neutral",
                      )}
                    >
                      {kitStatus.onboarding.onboardingCompletedAt
                        ? "Onboarding completed"
                        : kitStatus.onboarding.bootstrapPresent
                          ? "Bootstrap active"
                          : "Bootstrap missing"}
                    </span>
                  )}
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "10px",
                    marginTop: "8px",
                    fontSize: "12px",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  <div>{kitStatus.workspacePath ? `Path: ${kitStatus.workspacePath}` : ""}</div>
                  <div>
                    {kitStatus.onboarding?.bootstrapSeededAt
                      ? `Bootstrap seeded ${formatTimestamp(kitStatus.onboarding.bootstrapSeededAt)}`
                      : "Bootstrap not yet seeded"}
                  </div>
                </div>

                {kitStatus.files.length > 0 && (
                  <details style={{ marginTop: "8px" }}>
                    <summary
                      style={{
                        cursor: "pointer",
                        fontSize: "12px",
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      Show kit files
                    </summary>
                    <div className="memory-list" style={{ marginTop: "8px", maxHeight: "none" }}>
                      {kitStatus.files.map((f) => {
                        const warningCount = f.issues?.filter((issue) => issue.level === "warning").length || 0;
                        const errorCount = f.issues?.filter((issue) => issue.level === "error").length || 0;
                        const modifiedAt = formatTimestamp(f.modifiedAt);
                        const sizeLabel = formatBytes(f.sizeBytes);
                        const metadata = [
                          f.title,
                          modifiedAt ? `updated ${modifiedAt}` : null,
                          sizeLabel,
                          typeof f.revisionCount === "number" ? `${f.revisionCount} revision${f.revisionCount === 1 ? "" : "s"}` : null,
                        ].filter(Boolean);

                        return (
                          <div
                            key={f.relPath}
                            className="memory-list-item"
                            style={{ fontSize: "12px" }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: "10px",
                                alignItems: "flex-start",
                              }}
                            >
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    flexWrap: "wrap",
                                  }}
                                >
                                  <code style={{ color: "var(--color-text-primary)" }}>{f.relPath}</code>
                                  {f.specialHandling === "heartbeat" && (
                                    <span className={badgeClass("warning")}>heartbeat</span>
                                  )}
                                  {f.specialHandling === "bootstrap" && (
                                    <span className={badgeClass("neutral")}>bootstrap</span>
                                  )}
                                </div>
                                {metadata.length > 0 && (
                                  <div
                                    style={{
                                      marginTop: "6px",
                                      color: "var(--color-text-secondary)",
                                      display: "flex",
                                      gap: "8px",
                                      flexWrap: "wrap",
                                    }}
                                  >
                                    {metadata.map((item) => (
                                      <span key={`${f.relPath}:${item}`}>{item}</span>
                                    ))}
                                  </div>
                                )}
                                {f.issues && f.issues.length > 0 && (
                                  <ul
                                    style={{
                                      marginTop: "8px",
                                      marginBottom: 0,
                                      paddingLeft: "18px",
                                      color: "var(--color-text-secondary)",
                                    }}
                                  >
                                    {f.issues.map((issue) => (
                                      <li key={`${f.relPath}:${issue.code}:${issue.message}`}>
                                        <strong
                                          style={{
                                            color:
                                              issue.level === "error"
                                                ? "var(--color-error, #ef4444)"
                                                : "var(--color-warning, #f59e0b)",
                                          }}
                                        >
                                          {issue.code}
                                        </strong>{" "}
                                        {issue.message}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>

                              <div
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: "6px",
                                  justifyContent: "flex-end",
                                  maxWidth: "40%",
                                }}
                              >
                                <span className={badgeClass(f.exists ? "success" : "error")}>
                                  {f.exists ? "OK" : "MISSING"}
                                </span>
                                {f.stale && <span className={badgeClass("warning")}>stale</span>}
                                {errorCount > 0 && (
                                  <span className={badgeClass("error")}>
                                    {errorCount} error{errorCount === 1 ? "" : "s"}
                                  </span>
                                )}
                                {warningCount > 0 && (
                                  <span className={badgeClass("warning")}>
                                    {warningCount} warning{warningCount === 1 ? "" : "s"}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>
            )}

            <div style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                className="settings-input"
                value={newProjectId}
                onChange={(e) => setNewProjectId(e.target.value)}
                placeholder="New project id (e.g. website-redesign)"
                style={{ flex: 1 }}
              />
              <button
                className="settings-button"
                onClick={() => void createProject()}
                disabled={kitBusy || !newProjectId.trim()}
              >
                Create project
              </button>
            </div>

            <div style={{ marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                className="settings-button"
                onClick={() =>
                  void window.electronAPI.openWorkspaceKitFile({
                    workspaceId: selectedWorkspaceId,
                    relPath: ".cowork/USER.md",
                  })
                }
                disabled={!selectedWorkspaceId || kitBusy}
              >
                Open USER.md
              </button>
              <button
                className="settings-button"
                onClick={() =>
                  void window.electronAPI.openWorkspaceKitFile({
                    workspaceId: selectedWorkspaceId,
                    relPath: ".cowork/MEMORY.md",
                  })
                }
                disabled={!selectedWorkspaceId || kitBusy}
              >
                Open MEMORY.md
              </button>
            </div>
          </div>
        )}

        {selectedWorkspaceId && (
          <MemorySettings
            workspaceId={selectedWorkspaceId}
            onSettingsChanged={props?.onSettingsChanged}
          />
        )}
      </div>
    </div>
  );
}
