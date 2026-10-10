import { useCallback, useEffect, useState } from "react";
import { Globe2, Trash2 } from "lucide-react";
import type {
  BrowserAgentPermission,
  BrowserDownloadLocation,
  BrowserSearchEngine,
  BrowserSettings,
  BrowserSitePermissionEntry,
} from "../../shared/browser-settings";
import { useBrowserSettings } from "../hooks/useBrowserSettings";

type HistoryEntry = {
  id: string;
  url: string;
  title: string;
  visitCount: number;
  lastVisitAt: number;
};

const SEARCH_ENGINE_LABELS: Record<BrowserSearchEngine, string> = {
  google: "Google",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  brave: "Brave",
  kagi: "Kagi",
};

const PERMISSION_LABELS: Record<string, string> = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications",
  "clipboard-read": "Clipboard",
  midi: "MIDI devices",
  midiSysex: "MIDI device control",
  hid: "HID devices",
  serial: "Serial ports",
  usb: "USB devices",
  pointerLock: "Pointer lock",
  keyboardLock: "Keyboard lock",
  fileSystem: "File editing",
  openExternal: "Opening apps",
  "display-capture": "Screen sharing",
};

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="settings-field browser-settings-toggle-row">
      <div>
        <span className="settings-label">{label}</span>
        {description && <p className="settings-description">{description}</p>}
      </div>
      <label className="settings-toggle">
        <input
          type="checkbox"
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-slider" />
      </label>
    </div>
  );
}

function SelectField<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-field">
      <label>{label}</label>
      {description && <p className="settings-description">{description}</p>}
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const AGENT_OPTIONS: Array<{ value: BrowserAgentPermission; label: string }> = [
  { value: "ask", label: "Ask each time" },
  { value: "allow", label: "Allow" },
  { value: "block", label: "Block" },
];

/** Settings > Browser: preferences, history, site permissions and developer mode. */
export function BrowserSettingsPanel({ workspaceId }: { workspaceId?: string }) {
  const { settings, policy, save } = useBrowserSettings();
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [profileId, setProfileId] = useState(workspaceId || "");
  const [historyQuery, setHistoryQuery] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [permissions, setPermissions] = useState<BrowserSitePermissionEntry[]>([]);
  const [notice, setNotice] = useState("");

  const update = (patch: Partial<BrowserSettings>) => void save(patch);

  useEffect(() => {
    void window.electronAPI
      .listWorkspaces?.()
      .then((list) => {
        const entries = (list || []).map((workspace: Any) => ({
          id: String(workspace.id),
          name: String(workspace.name || workspace.path || workspace.id),
        }));
        setWorkspaces(entries);
        setProfileId((current) => current || entries[0]?.id || "");
      })
      .catch(() => undefined);
  }, []);

  const loadHistory = useCallback(async () => {
    if (!profileId) return;
    const entries = await window.electronAPI
      .listBrowserHistory?.({
        workspaceId: profileId,
        limit: 100,
        query: historyQuery || undefined,
      })
      .catch(() => []);
    setHistory((entries || []) as HistoryEntry[]);
  }, [historyQuery, profileId]);

  const loadPermissions = useCallback(async () => {
    if (!profileId) return;
    const entries = await window.electronAPI
      .listBrowserSitePermissions?.({ workspaceId: profileId })
      .catch(() => []);
    setPermissions(entries || []);
  }, [profileId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadHistory(), 150);
    return () => window.clearTimeout(timer);
  }, [loadHistory]);

  useEffect(() => {
    void loadPermissions();
  }, [loadPermissions]);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2500);
  };

  return (
    <div className="settings-section browser-settings">
      <h2 className="settings-title browser-settings-title">
        <Globe2 size={18} />
        Browser
      </h2>
      <p className="settings-description">
        The in-app browser CoWork OS uses with you. Each workspace has its own browser profile:
        sign-ins, history and site permissions.
      </p>

      <div className="settings-group">
        <h3 className="settings-label">General</h3>
        <SelectField<BrowserSearchEngine>
          label="Search engine"
          description="Used when you type words instead of an address."
          value={settings.searchEngine}
          options={(Object.keys(SEARCH_ENGINE_LABELS) as BrowserSearchEngine[]).map((value) => ({
            value,
            label: SEARCH_ENGINE_LABELS[value],
          }))}
          onChange={(searchEngine) => update({ searchEngine })}
        />
        <Toggle
          label="Restore tabs"
          description="Reopen a task's tabs when you open its browser again."
          checked={settings.restoreTabs}
          onChange={(restoreTabs) => update({ restoreTabs })}
        />
        <Toggle
          label="Open links from conversations in the in-app browser"
          description="Off opens them in your system browser."
          checked={settings.openChatLinksInBrowser}
          onChange={(openChatLinksInBrowser) => update({ openChatLinksInBrowser })}
        />
        <Toggle
          label="Use a Chrome-compatible user agent"
          description="Lets sites that refuse embedded browsers (such as Google sign-in) work. Takes effect after restarting CoWork OS."
          checked={settings.chromeCompatibleUserAgent}
          onChange={(chromeCompatibleUserAgent) => update({ chromeCompatibleUserAgent })}
        />
      </div>

      <div className="settings-group">
        <h3 className="settings-label">Downloads</h3>
        <SelectField<BrowserDownloadLocation>
          label="Save your downloads to"
          description="Files CoWork downloads always go to the workspace's downloads folder."
          value={settings.downloadLocation}
          options={[
            { value: "system", label: "Downloads folder" },
            { value: "workspace", label: "Workspace downloads folder" },
            { value: "ask", label: "Ask where to save each file" },
          ]}
          onChange={(downloadLocation) => update({ downloadLocation })}
        />
      </div>

      <div className="settings-group">
        <h3 className="settings-label">CoWork in the browser</h3>
        <p className="settings-description">
          Access profiles and admin policies still decide which sites CoWork can reach; these
          settings cannot widen them.
        </p>
        <SelectField<BrowserAgentPermission>
          label="Downloads by CoWork"
          value={settings.agentDownloads}
          options={AGENT_OPTIONS}
          onChange={(agentDownloads) => update({ agentDownloads })}
        />
        <SelectField<BrowserAgentPermission>
          label="File uploads by CoWork"
          value={settings.agentUploads}
          options={AGENT_OPTIONS}
          onChange={(agentUploads) => update({ agentUploads })}
        />
        <Toggle
          label="Developer mode"
          description={
            policy?.developerModeLocked
              ? `Set by your organization's policy (${settings.developerMode ? "on" : "off"}).`
              : "Adds Inspect Element and lets CoWork run page scripts and read storage and traces (full DevTools access)."
          }
          checked={settings.developerMode}
          disabled={policy?.developerModeLocked}
          onChange={(developerMode) => update({ developerMode })}
        />
        {policy && policy.blockedSitePermissions.length > 0 && (
          <p className="settings-description">
            Your organization blocks these site permissions in the browser:{" "}
            {policy.blockedSitePermissions
              .map((permission) => PERMISSION_LABELS[permission] || permission)
              .join(", ")}
            .
          </p>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-section-header">
          <h3 className="settings-label">Browser profile</h3>
          {workspaces.length > 0 && (
            <select
              aria-label="Workspace"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {notice && <p className="settings-description">{notice}</p>}

        <Toggle
          label="Record browsing history"
          checked={settings.historyEnabled}
          onChange={(historyEnabled) => update({ historyEnabled })}
        />
        <div className="settings-field">
          <label>History</label>
          <div className="browser-settings-row">
            <input
              value={historyQuery}
              placeholder="Search history"
              aria-label="Search history"
              onChange={(event) => setHistoryQuery(event.target.value)}
            />
            <button
              type="button"
              className="settings-button small"
              disabled={!profileId}
              onClick={() => {
                if (!window.confirm("Clear all browsing history for this workspace?")) return;
                void window.electronAPI
                  .clearBrowserHistory?.({ workspaceId: profileId })
                  .then(() => {
                    showNotice("History cleared");
                    void loadHistory();
                  });
              }}
            >
              Clear history
            </button>
          </div>
          <ul className="browser-settings-list">
            {history.length === 0 && <li className="browser-settings-empty">No pages yet.</li>}
            {history.map((entry) => (
              <li key={entry.id}>
                <span className="browser-settings-list-main" title={entry.url}>
                  <strong>{entry.title || entry.url}</strong>
                  <span>{entry.url}</span>
                </span>
                <span className="browser-settings-list-meta">
                  {new Date(entry.lastVisitAt).toLocaleString()}
                </span>
                <button
                  type="button"
                  aria-label="Remove from history"
                  onClick={() =>
                    void window.electronAPI
                      .removeBrowserHistory?.({ workspaceId: profileId, ids: [entry.id] })
                      .then(() => void loadHistory())
                  }
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="settings-field">
          <label>Site permissions</label>
          <p className="settings-description">
            Choices you made with "Always allow" or "Never allow". Removing one asks again next
            time.
          </p>
          <ul className="browser-settings-list">
            {permissions.length === 0 && (
              <li className="browser-settings-empty">No remembered site permissions.</li>
            )}
            {permissions.map((entry) => (
              <li key={`${entry.origin}|${entry.permission}`}>
                <span className="browser-settings-list-main">
                  <strong>{entry.origin}</strong>
                  <span>
                    {PERMISSION_LABELS[entry.permission] || entry.permission}:{" "}
                    {entry.decision === "allow" ? "Allowed" : "Blocked"}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label="Reset permission"
                  onClick={() =>
                    void window.electronAPI
                      .resetBrowserSitePermission?.({
                        workspaceId: profileId,
                        origin: entry.origin,
                        permission: entry.permission,
                      })
                      .then(() => void loadPermissions())
                  }
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="settings-field">
          <label>Browsing data</label>
          <div className="browser-settings-row">
            <button
              type="button"
              className="settings-button small"
              disabled={!profileId}
              onClick={() => {
                if (!window.confirm("Clear cached files and site storage for this workspace?")) {
                  return;
                }
                void window.electronAPI
                  .clearBrowserData?.({ workspaceId: profileId, types: ["cache", "storage"] })
                  .then(() => showNotice("Cache and site storage cleared"));
              }}
            >
              Clear cache and storage
            </button>
            <button
              type="button"
              className="settings-button small"
              disabled={!profileId}
              onClick={() => {
                if (!window.confirm("Sign out of all sites in this workspace's browser?")) return;
                void window.electronAPI
                  .clearBrowserData?.({ workspaceId: profileId, types: ["cookies", "storage"] })
                  .then(() => showNotice("Signed out of all sites"));
              }}
            >
              Sign out of all sites
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
