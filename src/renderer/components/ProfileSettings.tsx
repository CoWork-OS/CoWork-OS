import { useEffect, useState } from "react";
import type { AppProfileSummary } from "../../shared/types";

export function ProfileSettings() {
  const [profiles, setProfiles] = useState<AppProfileSummary[]>([]);
  const [newProfileName, setNewProfileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importProfileName, setImportProfileName] = useState("");

  const loadProfiles = async () => {
    if (!window.electronAPI?.listProfiles) return;
    try {
      const nextProfiles = await window.electronAPI.listProfiles();
      setProfiles(nextProfiles);
    } catch (loadError: Any) {
      setError(loadError?.message || "Failed to load profiles.");
    }
  };

  useEffect(() => {
    void loadProfiles();
  }, []);

  const handleCreate = async () => {
    const trimmed = newProfileName.trim();
    if (!trimmed || !window.electronAPI?.createProfile) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const created = await window.electronAPI.createProfile(trimmed);
      setNewProfileName("");
      setStatus(`Created profile "${created.label}".`);
      await loadProfiles();
    } catch (createError: Any) {
      setError(createError?.message || "Failed to create profile.");
    } finally {
      setBusy(false);
    }
  };

  const handleSwitch = async (profileId: string) => {
    if (!window.electronAPI?.switchProfile) return;
    setBusy(true);
    setError(null);
    setStatus(`Switching to profile "${profileId}" and restarting...`);
    try {
      await window.electronAPI.switchProfile(profileId);
    } catch (switchError: Any) {
      setError(switchError?.message || "Failed to switch profile.");
      setStatus(null);
      setBusy(false);
    }
  };

  const handleExport = async (profileId: string) => {
    if (!window.electronAPI?.selectFolder || !window.electronAPI?.exportProfile) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const destinationRoot = await window.electronAPI.selectFolder();
      if (!destinationRoot) {
        setBusy(false);
        return;
      }
      const result = await window.electronAPI.exportProfile(profileId, destinationRoot);
      setStatus(`Exported "${result.profile.label}" to ${result.bundlePath}.`);
    } catch (exportError: Any) {
      setError(exportError?.message || "Failed to export profile.");
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!window.electronAPI?.selectFolder || !window.electronAPI?.importProfile) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const sourcePath = await window.electronAPI.selectFolder();
      if (!sourcePath) {
        setBusy(false);
        return;
      }
      const imported = await window.electronAPI.importProfile(
        sourcePath,
        importProfileName.trim() || undefined,
      );
      setImportProfileName("");
      setStatus(`Imported profile "${imported.label}".`);
      await loadProfiles();
    } catch (importError: Any) {
      setError(importError?.message || "Failed to import profile.");
    } finally {
      setBusy(false);
    }
  };

  const activeProfile = profiles.find((profile) => profile.isActive) ?? null;

  return (
    <div className="settings-section">
      <p className="settings-description">
        Profiles keep CoWork data isolated by user data directory. Switching restarts the app into
        the selected profile.
      </p>

      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div
          style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
        >
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Active profile: {activeProfile?.label || "default"}
            </div>
            <div className="settings-description" style={{ marginBottom: 0 }}>
              {activeProfile?.userDataDir || "Using the default data directory."}
            </div>
          </div>
          <span className="settings-badge">{activeProfile?.id || "default"}</span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        {profiles.map((profile) => (
          <div
            key={profile.id}
            className={`settings-card ${profile.isActive ? "is-selected" : ""}`}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                alignItems: "start",
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{profile.label}</div>
                <div className="settings-description" style={{ marginBottom: 0 }}>
                  {profile.userDataDir}
                </div>
              </div>
              <span className="settings-badge">{profile.isDefault ? "Default" : profile.id}</span>
            </div>
            <button
              type="button"
              className={profile.isActive ? "button-secondary" : "button-primary"}
              onClick={() => void handleSwitch(profile.id)}
              disabled={busy || profile.isActive}
            >
              {profile.isActive ? "Current Profile" : "Switch Profile"}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => void handleExport(profile.id)}
              disabled={busy}
            >
              Export
            </button>
          </div>
        ))}
      </div>

      <div className="settings-card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Create profile</div>
        <p className="settings-description">
          Enter a label like `work`, `personal`, or a project/team name. The storage path is created
          automatically.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <input
            type="text"
            value={newProfileName}
            onChange={(event) => setNewProfileName(event.target.value)}
            placeholder="New profile name"
            disabled={busy}
            style={{ flex: "1 1 240px" }}
          />
          <button
            type="button"
            className="button-primary"
            onClick={() => void handleCreate()}
            disabled={busy || newProfileName.trim().length === 0}
          >
            Create
          </button>
        </div>
        {status ? (
          <p className="settings-description" style={{ marginTop: 12, marginBottom: 0 }}>
            {status}
          </p>
        ) : null}
        {error ? (
          <p
            className="settings-description"
            style={{ marginTop: 12, marginBottom: 0, color: "var(--color-danger)" }}
          >
            {error}
          </p>
        ) : null}
      </div>

      <div className="settings-card" style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Import profile</div>
        <p className="settings-description">
          Pick a previously exported profile folder. Leave the name blank to reuse the imported
          profile label.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <input
            type="text"
            value={importProfileName}
            onChange={(event) => setImportProfileName(event.target.value)}
            placeholder="Optional profile name override"
            disabled={busy}
            style={{ flex: "1 1 240px" }}
          />
          <button
            type="button"
            className="button-secondary"
            onClick={() => void handleImport()}
            disabled={busy}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
