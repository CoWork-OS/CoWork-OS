import { useState, useEffect } from "react";

interface WorktreeSettingsData {
  enabled: boolean;
  autoCommitOnComplete: boolean;
  autoCleanOnMerge: boolean;
  branchPrefix: string;
  commitMessagePrefix: string;
}

const DEFAULT_SETTINGS: WorktreeSettingsData = {
  enabled: false,
  autoCommitOnComplete: true,
  autoCleanOnMerge: true,
  branchPrefix: "cowork/",
  commitMessagePrefix: "[cowork] ",
};

export function WorktreeSettings() {
  const [settings, setSettings] = useState<WorktreeSettingsData>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.getWorktreeSettings().then((s: WorktreeSettingsData) => {
      if (s) setSettings({ ...DEFAULT_SETTINGS, ...s });
    });
  }, []);

  const handleSave = async (updated: WorktreeSettingsData) => {
    const previous = settings;
    setSettings(updated);
    setSaveError(null);
    try {
      const result = await window.electronAPI.saveWorktreeSettings(updated);
      if (!result?.success) {
        throw new Error(result?.error || "Failed to save settings");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setSettings(previous);
      setSaved(false);
      const message = error instanceof Error ? error.message : "Failed to save settings";
      setSaveError(message);
    }
  };

  const toggleField = (field: keyof WorktreeSettingsData) => {
    const updated = { ...settings, [field]: !settings[field] };
    void handleSave(updated);
  };

  const updateField = (field: keyof WorktreeSettingsData, value: string) => {
    const updated = { ...settings, [field]: value };
    void handleSave(updated);
  };

  return (
    <div className="settings-panel">
      <div className="settings-section">
        <h2>Git Worktree Isolation</h2>
        <p className="settings-description">
          When enabled, each task gets its own isolated git branch and working directory (worktree).
          Multiple agents can work on the same repository simultaneously without conflicts.
        </p>

        <div className="settings-field">
          <div className="settings-field-header">
            <label>Enable Worktree Isolation</label>
            <p className="settings-field-description">
              Each new task in a git repository will automatically get its own branch and worktree.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={() => toggleField("enabled")}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="settings-field">
          <div className="settings-field-header">
            <label>Auto-Commit on Completion</label>
            <p className="settings-field-description">
              Automatically commit all changes when a task completes successfully.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={settings.autoCommitOnComplete}
              onChange={() => toggleField("autoCommitOnComplete")}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="settings-field">
          <div className="settings-field-header">
            <label>Auto-Cleanup After Merge</label>
            <p className="settings-field-description">
              Remove the worktree directory and branch after a successful merge.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={settings.autoCleanOnMerge}
              onChange={() => toggleField("autoCleanOnMerge")}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="settings-field">
          <div className="settings-field-header">
            <label>Branch Prefix</label>
            <p className="settings-field-description">
              Prefix for auto-generated branch names (e.g., "cowork/" creates branches like
              "cowork/fix-login-abc123").
            </p>
          </div>
          <input
            type="text"
            className="settings-input"
            value={settings.branchPrefix}
            onChange={(e) => updateField("branchPrefix", e.target.value)}
            disabled={!settings.enabled}
            placeholder="cowork/"
          />
        </div>

        <div className="settings-field">
          <div className="settings-field-header">
            <label>Commit Message Prefix</label>
            <p className="settings-field-description">Prefix for auto-generated commit messages.</p>
          </div>
          <input
            type="text"
            className="settings-input"
            value={settings.commitMessagePrefix}
            onChange={(e) => updateField("commitMessagePrefix", e.target.value)}
            disabled={!settings.enabled}
            placeholder="[cowork] "
          />
        </div>
      </div>

      <div className="settings-section">
        <h2>Agent Comparison Mode</h2>
        <p className="settings-description">
          Run the same prompt on multiple agents or LLM providers simultaneously and compare their
          results side-by-side. Each agent works in its own isolated worktree branch.
        </p>
        <p className="settings-description" style={{ opacity: 0.7 }}>
          To start a comparison, use the comparison button when creating a new task. Worktree
          isolation must be enabled for comparison mode to create separate branches.
        </p>
      </div>

      {saved && <div className="settings-save-indicator">Settings saved</div>}
      {saveError && <div className="settings-save-indicator error">{saveError}</div>}
    </div>
  );
}
