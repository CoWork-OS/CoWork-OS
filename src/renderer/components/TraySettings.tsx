import { useState, useEffect } from "react";
import {
  NOTIFICATION_SOUND_NAMES,
  type CompletionNotificationMode,
  type NotificationSound,
  TraySettings as TraySettingsType,
} from "../../shared/types";

const COMPLETION_MODE_LABELS: Array<[CompletionNotificationMode, string]> = [
  ["never", "Never"],
  ["unfocused", "When CoWork is in the background"],
  ["always", "Always"],
];

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
      void loadSettings();
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
    } catch {
      setSettings(null);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (patch: Partial<TraySettingsType>) => {
    try {
      setSaving(true);
      const result = await window.electronAPI.saveTraySettings(patch);
      if (result.settings) {
        setSettings(result.settings);
        onStatusChange?.(result.settings.enabled);
      }
    } catch {
      await loadSettings();
    } finally {
      setSaving(false);
    }
  };

  const trayHeading = isMacOS ? "Menu Bar" : "System Tray";
  const trayLabel = isMacOS ? "menu bar" : "system tray";
  const trayIconOn = settings?.enabled ?? false;
  const alertsOn = settings?.showNotifications ?? true;

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
    return <div className="settings-loading">Loading {trayLabel} settings…</div>;
  }

  return (
    <div className="tray-settings">
      <div className="settings-section">
        <h3>{trayHeading}</h3>
        <p className="settings-description">
          {isMacOS ? (
            <>
              Control where CoWork appears when it runs: the menu bar icon, the Dock, and banner
              alerts. Changes apply immediately.
            </>
          ) : (
            <>
              Control the system tray icon and banner notifications for task updates. Changes apply
              immediately.
            </>
          )}
        </p>

        <div className="tray-settings-options">
          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">
                  {isMacOS ? "Show menu bar icon" : "Show system tray icon"}
                </span>
                <p className="tray-settings-option-desc">
                  {isMacOS ? (
                    <>
                      Adds the CoWork leopard to the menu bar for quick access. Off by default; the
                      app still runs from the Dock, and Quick Task stays on ⇧⌘Space.
                    </>
                  ) : (
                    <>
                      Adds the CoWork leopard to the notification area for quick access. Off by
                      default; Quick Task stays on Ctrl+Shift+Space.
                    </>
                  )}
                </p>
              </div>
              <label className="settings-toggle tray-settings-toggle">
                <input
                  type="checkbox"
                  checked={trayIconOn}
                  onChange={(e) => void handleSave({ enabled: e.target.checked })}
                  disabled={saving}
                  aria-label={isMacOS ? "Show menu bar icon" : "Show system tray icon"}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          {isMacOS && (
            <div className="settings-form-group tray-settings-option">
              <div className="tray-settings-option-inner">
                <div className="tray-settings-option-text">
                  <span className="tray-settings-option-title">Show Dock icon</span>
                  <p className="tray-settings-option-desc">
                    {trayIconOn ? (
                      <>
                        While CoWork is open, show its icon in the Dock. Turn off if you prefer to
                        work from the menu bar only (the Dock icon can still appear briefly when you
                        focus the app).
                      </>
                    ) : (
                      <>
                        The Dock icon stays while the menu bar icon is off, so CoWork can always be
                        reopened.
                      </>
                    )}
                  </p>
                </div>
                <label className="settings-toggle tray-settings-toggle">
                  <input
                    type="checkbox"
                    checked={trayIconOn ? (settings?.showDockIcon ?? true) : true}
                    onChange={(e) => void handleSave({ showDockIcon: e.target.checked })}
                    disabled={saving || !trayIconOn}
                    aria-label="Show Dock icon"
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          )}

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">Start with window closed</span>
                <p className="tray-settings-option-desc">
                  On launch, keep the main window hidden until you open it from the {trayLabel} menu
                  or elsewhere.
                </p>
              </div>
              <label className="settings-toggle tray-settings-toggle">
                <input
                  type="checkbox"
                  checked={settings?.startMinimized ?? false}
                  onChange={(e) => void handleSave({ startMinimized: e.target.checked })}
                  disabled={saving}
                  aria-label="Start with main window hidden"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">
                  Close button hides, does not quit
                </span>
                <p className="tray-settings-option-desc">
                  {isMacOS || trayIconOn ? (
                    <>
                      When you close the main window, CoWork keeps running in the background. Turn
                      off to make the close button quit the app.
                    </>
                  ) : (
                    <>
                      Needs the system tray icon, which is how you reopen a hidden window. Without
                      it, the close button quits CoWork.
                    </>
                  )}
                </p>
              </div>
              <label className="settings-toggle tray-settings-toggle">
                <input
                  type="checkbox"
                  checked={isMacOS || trayIconOn ? (settings?.closeToTray ?? true) : false}
                  onChange={(e) => void handleSave({ closeToTray: e.target.checked })}
                  disabled={saving || (!isMacOS && !trayIconOn)}
                  aria-label="Close window hides app instead of quitting"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          {isMacOS && (
            <div className="settings-form-group tray-settings-option">
              <div className="tray-settings-option-inner">
                <div className="tray-settings-option-text">
                  <span className="tray-settings-option-title">
                    Capture the window in front with ⌘⇧2
                  </span>
                  <p className="tray-settings-option-desc">
                    From any app, ⌘⇧2 attaches a picture of the window in front, its title and page
                    address to your message, and brings CoWork forward. Nothing is sent until you
                    send the message. Needs Screen Recording permission.
                  </p>
                </div>
                <label className="settings-toggle tray-settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings?.windowCaptureShortcut ?? true}
                    onChange={(e) => void handleSave({ windowCaptureShortcut: e.target.checked })}
                    disabled={saving}
                    aria-label="Capture the window in front with Shift Command 2"
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          )}

          {isMacOS && (
            <div className="settings-form-group tray-settings-option">
              <div className="tray-settings-option-inner">
                <div className="tray-settings-option-text">
                  <span className="tray-settings-option-title">
                    Dictate into any app with ⌃⇧Space
                  </span>
                  <p className="tray-settings-option-desc">
                    In any text field, press ⌃⇧Space, speak, and press it again. CoWork writes down
                    what you said and pastes it where your cursor is; Esc cancels. Your speech goes
                    to the speech-to-text provider from Settings &gt; Voice, even when voice mode is
                    off. Needs Microphone and Accessibility permission; without Accessibility the
                    text is copied for you to paste.
                  </p>
                </div>
                <label className="settings-toggle tray-settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings?.dictationShortcut ?? false}
                    onChange={(e) => void handleSave({ dictationShortcut: e.target.checked })}
                    disabled={saving}
                    aria-label="Dictate into any app with Control Shift Space"
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          )}

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">
                  Ask before quitting while tasks run
                </span>
                <p className="tray-settings-option-desc">
                  Quitting stops any task that is still running. With this on, CoWork asks first.
                </p>
              </div>
              <label className="settings-toggle tray-settings-toggle">
                <input
                  type="checkbox"
                  checked={settings?.confirmQuitWhileRunning ?? true}
                  onChange={(e) => void handleSave({ confirmQuitWhileRunning: e.target.checked })}
                  disabled={saving}
                  aria-label="Ask before quitting while tasks run"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">
                  Keep the computer awake while tasks run
                </span>
                <p className="tray-settings-option-desc">
                  Stops the computer from going to sleep on its own while a task is running. The
                  display can still sleep, and closing the lid still puts it to sleep.
                </p>
              </div>
              <label className="settings-toggle tray-settings-toggle">
                <input
                  type="checkbox"
                  checked={settings?.preventSleepWhileRunning ?? true}
                  onChange={(e) => void handleSave({ preventSleepWhileRunning: e.target.checked })}
                  disabled={saving}
                  aria-label="Keep the computer awake while tasks run"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">Banner notifications</span>
                <p className="tray-settings-option-desc">
                  Show short alerts for task updates, completions, and items that need your
                  attention.
                </p>
              </div>
              <label className="settings-toggle tray-settings-toggle">
                <input
                  type="checkbox"
                  checked={settings?.showNotifications ?? true}
                  onChange={(e) => void handleSave({ showNotifications: e.target.checked })}
                  disabled={saving}
                  aria-label="Show banner notifications"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">When a task finishes</span>
                <p className="tray-settings-option-desc">
                  Alert you when a task you started finishes or fails. Scheduled tasks and bots
                  follow their own notification settings.
                </p>
              </div>
              <select
                className="settings-select tray-settings-select"
                value={settings?.completionNotifications ?? "unfocused"}
                onChange={(e) =>
                  void handleSave({
                    completionNotifications: e.target.value as CompletionNotificationMode,
                  })
                }
                disabled={saving || !alertsOn}
                aria-label="When a task finishes"
              >
                {COMPLETION_MODE_LABELS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">Approval alerts</span>
                <p className="tray-settings-option-desc">
                  Alert you when a task is waiting for your approval. The request stays in your
                  inbox either way.
                </p>
              </div>
              <label className="settings-toggle tray-settings-toggle">
                <input
                  type="checkbox"
                  checked={alertsOn && (settings?.showApprovalNotifications ?? true)}
                  onChange={(e) => void handleSave({ showApprovalNotifications: e.target.checked })}
                  disabled={saving || !alertsOn}
                  aria-label="Show approval alerts"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">Question alerts</span>
                <p className="tray-settings-option-desc">
                  Alert you when a task asks a question or pauses for your input. The question stays
                  in your inbox either way.
                </p>
              </div>
              <label className="settings-toggle tray-settings-toggle">
                <input
                  type="checkbox"
                  checked={alertsOn && (settings?.showQuestionNotifications ?? true)}
                  onChange={(e) => void handleSave({ showQuestionNotifications: e.target.checked })}
                  disabled={saving || !alertsOn}
                  aria-label="Show question alerts"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">Alert sound</span>
                <p className="tray-settings-option-desc">
                  {isMacOS
                    ? "The sound an alert plays. System default follows your macOS notification settings."
                    : "Whether an alert plays the system notification sound."}
                </p>
              </div>
              <select
                className="settings-select tray-settings-select"
                value={settings?.notificationSound ?? "default"}
                onChange={(e) =>
                  void handleSave({ notificationSound: e.target.value as NotificationSound })
                }
                disabled={saving || !alertsOn}
                aria-label="Alert sound"
              >
                <option value="default">System default</option>
                <option value="none">None</option>
                {isMacOS &&
                  NOTIFICATION_SOUND_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="settings-form-group tray-settings-option">
            <div className="tray-settings-option-inner">
              <div className="tray-settings-option-text">
                <span className="tray-settings-option-title">Approval saved notifications</span>
                <p className="tray-settings-option-desc">
                  Show a banner when an approval decision is saved for reuse, such as after using
                  allow once or approve all. Off by default.
                </p>
              </div>
              <label className="settings-toggle tray-settings-toggle">
                <input
                  type="checkbox"
                  checked={settings?.showApprovalSavedNotifications ?? false}
                  onChange={(e) =>
                    void handleSave({ showApprovalSavedNotifications: e.target.checked })
                  }
                  disabled={saving}
                  aria-label="Show approval saved notifications"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section tray-settings-features">
        <h4>What you get from the {trayHeading} icon</h4>
        <div className="settings-callout info">
          <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
            <li>
              <strong>Open the menu:</strong> click the CoWork icon in the {trayLabel} to open the
              menu (channels, workspaces, quick task, window show/hide, settings, quit).
            </li>
            <li>
              <strong>Show or hide the window:</strong> choose &quot;Show Window&quot; or &quot;Hide
              Window&quot; from that menu.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
