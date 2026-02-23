import { useState, useEffect, useCallback } from "react";

const ipcAPI = window.electronAPI;

interface ScrapingSettingsData {
  enabled: boolean;
  defaultFetcher: "default" | "stealth" | "playwright";
  headless: boolean;
  timeout: number;
  maxContentLength: number;
  proxy: {
    enabled: boolean;
    url: string;
  };
  rateLimiting: {
    enabled: boolean;
    requestsPerMinute: number;
  };
  pythonPath: string;
}

interface ScrapingStatus {
  installed: boolean;
  pythonAvailable: boolean;
  version: string | null;
  error?: string;
}

export function ScrapingSettings() {
  const [settings, setSettings] = useState<ScrapingSettingsData | null>(null);
  const [status, setStatus] = useState<ScrapingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [settingsRes, statusRes] = await Promise.all([
        ipcAPI.scrapingGetSettings(),
        ipcAPI.scrapingGetStatus(),
      ]);
      setSettings(settingsRes);
      setStatus(statusRes);
    } catch (error) {
      console.error("Failed to load scraping settings:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async (updated: ScrapingSettingsData) => {
    setSettings(updated);
    try {
      await ipcAPI.scrapingSaveSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error("Failed to save scraping settings:", error);
    }
  };

  const handleCheckStatus = async () => {
    setChecking(true);
    try {
      const statusRes = await ipcAPI.scrapingGetStatus();
      setStatus(statusRes);
    } catch (error) {
      console.error("Failed to check status:", error);
    } finally {
      setChecking(false);
    }
  };

  const handleReset = async () => {
    if (!confirm("This will reset all scraping settings to defaults.\n\nContinue?")) return;
    try {
      await ipcAPI.scrapingReset();
      await loadData();
    } catch (error) {
      console.error("Reset failed:", error);
    }
  };

  if (loading) {
    return <div style={{ padding: "24px", opacity: 0.6 }}>Loading scraping settings...</div>;
  }

  if (!settings) {
    return (
      <div style={{ padding: "24px", color: "var(--error)" }}>Failed to load scraping settings</div>
    );
  }

  return (
    <div style={{ maxWidth: 640, padding: "0 24px 24px 24px" }}>
      <h2
        style={{
          fontSize: 18,
          fontWeight: 600,
          marginBottom: 4,
          color: "var(--text-primary)",
        }}
      >
        Web Scraping
      </h2>
      <p
        style={{
          fontSize: 13,
          color: "var(--text-secondary)",
          marginBottom: 20,
        }}
      >
        Advanced web scraping powered by{" "}
        <a
          href="https://github.com/D4Vinci/Scrapling"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent)" }}
        >
          Scrapling
        </a>
        . Anti-bot bypass, stealth browsing, adaptive element tracking, and structured data
        extraction.
      </p>

      {/* Status Banner */}
      <div
        style={{
          padding: "12px 16px",
          borderRadius: 8,
          marginBottom: 20,
          background: status?.installed
            ? "var(--bg-success, rgba(16, 185, 129, 0.1))"
            : "var(--bg-warning, rgba(245, 158, 11, 0.1))",
          border: `1px solid ${status?.installed ? "var(--border-success, rgba(16, 185, 129, 0.3))" : "var(--border-warning, rgba(245, 158, 11, 0.3))"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: "var(--text-primary)",
            }}
          >
            {status?.installed
              ? `Scrapling v${status.version} installed`
              : "Scrapling not installed"}
          </div>
          {!status?.installed && (
            <div
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                marginTop: 2,
              }}
            >
              {status?.error || "Run: pip install scrapling && scrapling install"}
            </div>
          )}
        </div>
        <button
          onClick={handleCheckStatus}
          disabled={checking}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            color: "var(--text-primary)",
            cursor: checking ? "wait" : "pointer",
            opacity: checking ? 0.6 : 1,
          }}
        >
          {checking ? "Checking..." : "Check Status"}
        </button>
      </div>

      {/* Enable Toggle */}
      <SettingRow
        label="Enable Scraping Tools"
        description="Make scraping tools available to agents"
      >
        <ToggleSwitch
          checked={settings.enabled}
          onChange={(enabled) => handleSave({ ...settings, enabled })}
        />
      </SettingRow>

      {settings.enabled && (
        <>
          {/* Default Fetcher */}
          <SettingRow
            label="Default Fetcher"
            description="HTTP engine used when no fetcher is specified"
          >
            <select
              value={settings.defaultFetcher}
              onChange={(e) =>
                handleSave({
                  ...settings,
                  defaultFetcher: e.target.value as ScrapingSettingsData["defaultFetcher"],
                })
              }
              style={selectStyle}
            >
              <option value="default">Default (fast HTTP + TLS fingerprinting)</option>
              <option value="stealth">Stealth (Cloudflare bypass)</option>
              <option value="playwright">Playwright (full browser)</option>
            </select>
          </SettingRow>

          {/* Headless Mode */}
          <SettingRow
            label="Headless Mode"
            description="Run browser fetchers without visible window"
          >
            <ToggleSwitch
              checked={settings.headless}
              onChange={(headless) => handleSave({ ...settings, headless })}
            />
          </SettingRow>

          {/* Timeout */}
          <SettingRow label="Timeout (ms)" description="Maximum time to wait for a page to load">
            <input
              type="number"
              value={settings.timeout}
              onChange={(e) =>
                handleSave({
                  ...settings,
                  timeout: Math.max(5000, Math.min(120000, parseInt(e.target.value) || 30000)),
                })
              }
              style={inputStyle}
              min={5000}
              max={120000}
              step={1000}
            />
          </SettingRow>

          {/* Max Content Length */}
          <SettingRow
            label="Max Content Length"
            description="Maximum characters to return per page"
          >
            <input
              type="number"
              value={settings.maxContentLength}
              onChange={(e) =>
                handleSave({
                  ...settings,
                  maxContentLength: Math.max(
                    10000,
                    Math.min(500000, parseInt(e.target.value) || 100000),
                  ),
                })
              }
              style={inputStyle}
              min={10000}
              max={500000}
              step={10000}
            />
          </SettingRow>

          {/* Python Path */}
          <SettingRow label="Python Path" description="Path to Python 3 binary">
            <input
              type="text"
              value={settings.pythonPath}
              onChange={(e) => handleSave({ ...settings, pythonPath: e.target.value || "python3" })}
              style={inputStyle}
              placeholder="python3"
            />
          </SettingRow>

          {/* Proxy Settings */}
          <div style={{ marginTop: 16, marginBottom: 8 }}>
            <h3
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text-primary)",
                marginBottom: 8,
              }}
            >
              Proxy
            </h3>
          </div>

          <SettingRow label="Enable Proxy" description="Route scraping requests through a proxy">
            <ToggleSwitch
              checked={settings.proxy.enabled}
              onChange={(enabled) =>
                handleSave({ ...settings, proxy: { ...settings.proxy, enabled } })
              }
            />
          </SettingRow>

          {settings.proxy.enabled && (
            <SettingRow label="Proxy URL" description="HTTP/HTTPS/SOCKS5 proxy address">
              <input
                type="text"
                value={settings.proxy.url}
                onChange={(e) =>
                  handleSave({
                    ...settings,
                    proxy: { ...settings.proxy, url: e.target.value },
                  })
                }
                style={inputStyle}
                placeholder="http://proxy:8080 or socks5://proxy:1080"
              />
            </SettingRow>
          )}

          {/* Rate Limiting */}
          <div style={{ marginTop: 16, marginBottom: 8 }}>
            <h3
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text-primary)",
                marginBottom: 8,
              }}
            >
              Rate Limiting
            </h3>
          </div>

          <SettingRow label="Enable Rate Limiting" description="Limit scraping request frequency">
            <ToggleSwitch
              checked={settings.rateLimiting.enabled}
              onChange={(enabled) =>
                handleSave({
                  ...settings,
                  rateLimiting: { ...settings.rateLimiting, enabled },
                })
              }
            />
          </SettingRow>

          {settings.rateLimiting.enabled && (
            <SettingRow label="Requests/Minute" description="Maximum scraping requests per minute">
              <input
                type="number"
                value={settings.rateLimiting.requestsPerMinute}
                onChange={(e) =>
                  handleSave({
                    ...settings,
                    rateLimiting: {
                      ...settings.rateLimiting,
                      requestsPerMinute: Math.max(1, Math.min(120, parseInt(e.target.value) || 30)),
                    },
                  })
                }
                style={inputStyle}
                min={1}
                max={120}
              />
            </SettingRow>
          )}

          {/* Reset */}
          <div style={{ marginTop: 24, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <button
              onClick={handleReset}
              style={{
                padding: "8px 16px",
                fontSize: 13,
                borderRadius: 6,
                border: "1px solid var(--border-error, rgba(239, 68, 68, 0.3))",
                background: "transparent",
                color: "var(--error, #ef4444)",
                cursor: "pointer",
              }}
            >
              Reset to Defaults
            </button>
          </div>
        </>
      )}

      {/* Saved indicator */}
      {saved && (
        <div
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            padding: "8px 16px",
            borderRadius: 8,
            background: "var(--accent)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 500,
            zIndex: 1000,
          }}
        >
          Settings saved
        </div>
      )}
    </div>
  );
}

// ─── Shared sub-components ─────────────────────────

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 0",
        borderBottom: "1px solid var(--border-subtle, rgba(255,255,255,0.06))",
      }}
    >
      <div style={{ flex: 1, marginRight: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
          {description}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        cursor: "pointer",
        background: checked ? "var(--accent)" : "var(--bg-tertiary, #333)",
        position: "relative",
        transition: "background 0.2s",
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          background: "#fff",
          position: "absolute",
          top: 3,
          left: checked ? 21 : 3,
          transition: "left 0.2s",
        }}
      />
    </button>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-secondary)",
  color: "var(--text-primary)",
  minWidth: 200,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-secondary)",
  color: "var(--text-primary)",
  width: 200,
};
