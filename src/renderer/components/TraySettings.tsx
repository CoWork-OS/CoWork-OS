import { useState, useEffect } from "react";
import { TraySettings as TraySettingsType } from "../../shared/types";

interface TraySettingsProps {
  onStatusChange?: (enabled: boolean) => void;
}

function detectPlatform(): string {
  if (window.electronAPI?.getPlatform) {
    return window.electronAPI.getPlatform();
  }
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "win32";
  if (platform.includes("mac")) return "darwin";
  return "linux";
}

export function TraySettings({ onStatusChange }: TraySettingsProps) {
  const [settings, setSettings] = useState<TraySettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [platform, setPlatform] = useState<string>(() => detectPlatform());
  const isMacOS = platform === "darwin";
  const supportsTraySettings = platform === "darwin" || platform === "win32";

  useEffect(() => {
    const detectedPlatform = detectPlatform();
    setPlatform(detectedPlatform);
    if (detectedPlatform === "darwin" || detectedPlatform === "win32") {
      loadSettings();
    } else {
      setLoading(false);
    }
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const traySettings = await window.electronAPI.getTraySettings();
      setSettings(traySettings);
      onStatusChange?.(traySettings.enabled);
    } catch (error) {
      console.error("Failed to load tray settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (newSettings: Partial<TraySettingsType>) => {
    try {
      setSaving(true);
      await window.electronAPI.saveTraySettings(newSettings);
      setSettings((prev) => (prev ? { ...prev, ...newSettings } : null));
      if (newSettings.enabled !== undefined) {
        onStatusChange?.(newSettings.enabled);
      }
    } catch (error) {
      console.error("Failed to save tray settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const trayLabel = isMacOS ? "Menu Bar" : "System Tray";

  if (!supportsTraySettings) {
    return (
      <div className="tray-settings">
        <div className="settings-section">
          <h3>Tray</h3>
          <div className="settings-warning">
            Tray settings are not available on this platform yet.
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="settings-loading">Loading {trayLabel.toLowerCase()} settings...</div>;
  }

  return (
    <div className="tray-settings">
      <div className="settings-section">
        <h3>{trayLabel}</h3>
        <p className="settings-description">
          Configure the {trayLabel.toLowerCase()} icon and behavior. The {trayLabel.toLowerCase()}{" "}
          provides quick access to workspaces and tasks.
        </p>

        <div className="settings-toggle-group">
          <div className="settings-toggle-item">
            <div className="toggle-info">
              <span className="toggle-label">Enable {trayLabel} Icon</span>
              <span className="toggle-description">
                Show CoWork OS icon in the {trayLabel.toLowerCase()}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.enabled ?? true}
                onChange={(e) => handleSave({ enabled: e.target.checked })}
                disabled={saving}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {/* Dock icon toggle is macOS-only */}
          {isMacOS && (
            <div className="settings-toggle-item">
              <div className="toggle-info">
                <span className="toggle-label">Show Dock Icon</span>
                <span className="toggle-description">
                  Show CoWork OS in the macOS Dock when running
                </span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings?.showDockIcon ?? true}
                  onChange={(e) => handleSave({ showDockIcon: e.target.checked })}
                  disabled={saving}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          )}

          <div className="settings-toggle-item">
            <div className="toggle-info">
              <span className="toggle-label">Start Minimized</span>
              <span className="toggle-description">
                Start with the main window hidden ({trayLabel.toLowerCase()} only)
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.startMinimized ?? false}
                onChange={(e) => handleSave({ startMinimized: e.target.checked })}
                disabled={saving}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="settings-toggle-item">
            <div className="toggle-info">
              <span className="toggle-label">Close to {trayLabel}</span>
              <span className="toggle-description">
                Closing the window minimizes to {trayLabel.toLowerCase()} instead of quitting
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.closeToTray ?? true}
                onChange={(e) => handleSave({ closeToTray: e.target.checked })}
                disabled={saving}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="settings-toggle-item">
            <div className="toggle-info">
              <span className="toggle-label">Show Notifications</span>
              <span className="toggle-description">
                Show system notifications for task completions and updates
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.showNotifications ?? true}
                onChange={(e) => handleSave({ showNotifications: e.target.checked })}
                disabled={saving}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h4>{trayLabel} Features</h4>
        <div className="settings-callout info">
          <strong>Quick Access:</strong>
          <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
            <li>Click the {trayLabel.toLowerCase()} icon to show/hide the main window</li>
            <li>
              Right-click (or click) to see the quick menu with:
              <ul style={{ paddingLeft: "20px", marginTop: "4px" }}>
                <li>Channel connection status</li>
                <li>Workspace selection</li>
                <li>New task shortcut</li>
                <li>Settings access</li>
              </ul>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
