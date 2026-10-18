import { useEffect, useState } from "react";
import {
  normalizeDeclaredAgentSettings,
  normalizeHttpsOrigin,
  type AgentIdentityDirectoryResult,
  type DeclaredAgentSettings,
} from "../../shared/browser-settings";

const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/**
 * Settings > Browser > Agent identity: whether CoWork labels and signs the requests it makes
 * for you, the key directory origin, and the domains that keep a browser user agent.
 */
export function DeclaredAgentSettingsGroup({
  value,
  onChange,
}: {
  value: DeclaredAgentSettings;
  onChange: (next: DeclaredAgentSettings) => void;
}) {
  const [origin, setOrigin] = useState(value.signatureAgent);
  const [domains, setDomains] = useState(value.compatibleUserAgentDomains.join("\n"));
  const [directory, setDirectory] = useState<{ keyid: string; directory: string } | null>(null);
  const [keyError, setKeyError] = useState("");
  const [message, setMessage] = useState("");

  const applyDirectory = (result: AgentIdentityDirectoryResult) => {
    if (result && "error" in result) {
      setDirectory(null);
      setKeyError(result.error);
      return;
    }
    setKeyError("");
    setDirectory(result);
  };

  useEffect(() => setOrigin(value.signatureAgent), [value.signatureAgent]);
  useEffect(
    () => setDomains(value.compatibleUserAgentDomains.join("\n")),
    [value.compatibleUserAgentDomains],
  );
  useEffect(() => {
    if (!value.enabled || !window.electronAPI?.getAgentIdentityDirectory) return;
    void window.electronAPI
      .getAgentIdentityDirectory()
      .then(applyDirectory)
      .catch(() => setDirectory(null));
  }, [value.enabled]);

  const save = (partial: Partial<DeclaredAgentSettings>) =>
    onChange(normalizeDeclaredAgentSettings({ ...value, ...partial }));

  const saveOrigin = () => {
    const normalized = normalizeHttpsOrigin(origin);
    if (origin.trim() && !normalized) {
      setMessage("Use an https origin with no path, for example https://agent.example.com.");
      return;
    }
    setMessage("");
    save({ signatureAgent: normalized });
  };

  const rotate = async () => {
    if (!window.electronAPI?.rotateAgentIdentityKey) return;
    // Null: the user cancelled the confirmation.
    const next = await window.electronAPI.rotateAgentIdentityKey().catch(() => null);
    if (!next) return;
    applyDirectory(next);
    setMessage(
      "error" in next ? "" : "New key created. Publish the new directory before sites see it.",
    );
  };

  return (
    <div className="settings-group">
      <h3 className="settings-label">Agent identity</h3>
      <p className="settings-description">
        How CoWork identifies itself on the requests it makes for you (web fetch, HTTP requests and
        pages it opens). Your own browsing is not changed.
      </p>
      <div className="settings-field browser-settings-toggle-row">
        <div>
          <span className="settings-label">Identify CoWork as an agent</span>
          <p className="settings-description">
            Sends a CoWork-OS user agent instead of a browser&apos;s, and signs each https request
            with a key you publish (Web Bot Auth) when a key directory is set. Some sites block
            agents; add them below to keep a browser user agent there.
          </p>
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            aria-label="Identify CoWork as an agent"
            checked={value.enabled}
            onChange={(event) => save({ enabled: event.target.checked })}
          />
          <span className="toggle-slider" />
        </label>
      </div>
      {value.enabled && (
        <>
          <div className="settings-field">
            <label className="settings-label" htmlFor="declared-agent-origin">
              Key directory origin
            </label>
            <p className="settings-description">
              The https origin that serves {DIRECTORY_PATH}. A self-hosted coworkd with a public
              address serves it for you; otherwise host the directory below yourself. Requests are
              signed only when this is set.
            </p>
            <input
              id="declared-agent-origin"
              className="settings-input"
              type="url"
              placeholder="https://agent.example.com"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              onBlur={saveOrigin}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label" htmlFor="declared-agent-domains">
              Keep a browser user agent on these domains
            </label>
            <p className="settings-description">One domain per line; subdomains included.</p>
            <textarea
              id="declared-agent-domains"
              className="settings-input"
              rows={3}
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              onBlur={() => save({ compatibleUserAgentDomains: domains.split(/\s+/) })}
            />
          </div>
          {directory && (
            <div className="settings-field">
              <span className="settings-label">Public key directory</span>
              <p className="settings-description">
                Serve this JSON at {DIRECTORY_PATH} with content type
                application/http-message-signatures-directory+json. It holds only public keys
                (current key id {directory.keyid}); a replaced key stays listed for 7 days.
              </p>
              <pre className="browser-settings-code">{directory.directory}</pre>
              <div className="settings-actions">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void navigator.clipboard?.writeText(directory.directory)}
                >
                  Copy directory
                </button>
                <button type="button" className="button-secondary" onClick={() => void rotate()}>
                  Replace key
                </button>
              </div>
            </div>
          )}
          {keyError && (
            <div className="settings-field">
              <p className="settings-description" role="alert">
                {keyError} Replacing the key creates a new one; publish its directory afterwards.
              </p>
              <div className="settings-actions">
                <button type="button" className="button-secondary" onClick={() => void rotate()}>
                  Replace key
                </button>
              </div>
            </div>
          )}
          {message && (
            <p className="settings-description" role="status">
              {message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
