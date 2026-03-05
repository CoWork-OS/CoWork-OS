import { useEffect, useMemo, useState } from "react";
import type { MemoryFeaturesSettings, Workspace, WorkspaceKitStatus } from "../../shared/types";
import { MemorySettings } from "./MemorySettings";

const DEFAULT_FEATURES: MemoryFeaturesSettings = {
  contextPackInjectionEnabled: true,
  heartbeatMaintenanceEnabled: true,
};

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
  const [newProjectId, setNewProjectId] = useState("");

  const selectedWorkspace = useMemo(() => {
    return workspaces.find((w) => w.id === selectedWorkspaceId) || null;
  }, [workspaces, selectedWorkspaceId]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setKitStatus(null);
      return;
    }
    void refreshKit();
  }, [selectedWorkspaceId]);

  const loadAll = async () => {
    try {
      setLoading(true);

      const [loadedFeatures, loadedWorkspaces, tempWorkspace] = await Promise.all([
        window.electronAPI.getMemoryFeaturesSettings().catch(() => DEFAULT_FEATURES),
        window.electronAPI.listWorkspaces().catch(() => [] as Workspace[]),
        window.electronAPI.getTempWorkspace().catch(() => null as Workspace | null),
      ]);

      const combined: Workspace[] = [
        ...(tempWorkspace ? [tempWorkspace] : []),
        ...loadedWorkspaces.filter((w) => w.id !== tempWorkspace?.id),
      ];

      setFeatures(loadedFeatures);
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

  const initKit = async () => {
    if (!selectedWorkspaceId) return;
    try {
      setKitBusy(true);
      const status = await window.electronAPI.initWorkspaceKit({
        workspaceId: selectedWorkspaceId,
        mode: "missing",
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
                When enabled, lead agents can create a daily maintenance task if{" "}
                <code>.cowork/HEARTBEAT.md</code> exists.
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
                <div
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                >
                  <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                    Missing: <strong>{kitStatus.missingCount}</strong>
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                    {kitStatus.hasKitDir ? "Found .cowork/" : "No .cowork/ directory"}
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
                    <div
                      style={{
                        marginTop: "8px",
                        border: "1px solid var(--color-border)",
                        borderRadius: "6px",
                      }}
                    >
                      {kitStatus.files.map((f) => (
                        <div
                          key={f.relPath}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: "10px",
                            padding: "8px 10px",
                            borderBottom: "1px solid var(--color-border)",
                            fontSize: "12px",
                          }}
                        >
                          <code style={{ color: "var(--color-text-primary)" }}>{f.relPath}</code>
                          <span
                            style={{
                              color: f.exists
                                ? "var(--color-success, #22c55e)"
                                : "var(--color-error, #ef4444)",
                            }}
                          >
                            {f.exists ? "OK" : "MISSING"}
                          </span>
                        </div>
                      ))}
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
