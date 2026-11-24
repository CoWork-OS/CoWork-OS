import { useState, useEffect } from "react";
import { SearchProviderType, SearchConfigStatus, SearchProviderInfo } from "../../shared/types";
import { SEARCH_SETTINGS_CHANGED } from "../hooks/useClosingSearchProvider";
import {
  resolvePrimarySearchProvider,
  supportsSearchFallback,
} from "../utils/search-provider-selection";

/** A closing provider stays visible only for people who already set it up. */
export function isProviderOffered(provider: SearchProviderInfo): boolean {
  return !provider.retirement || provider.configured;
}

export function formatEndDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

interface SearchSettingsProps {
  onStatusChange?: (configured: boolean) => void;
}

export function SearchSettings({ onStatusChange }: SearchSettingsProps) {
  const [configStatus, setConfigStatus] = useState<SearchConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingProvider, setTestingProvider] = useState<SearchProviderType | null>(null);
  const [testResult, setTestResult] = useState<{
    provider: SearchProviderType;
    success: boolean;
    error?: string;
  } | null>(null);

  // Form state
  const [primaryProvider, setPrimaryProvider] = useState<SearchProviderType | null>(null);
  const [fallbackProvider, setFallbackProvider] = useState<SearchProviderType | null>(null);

  // API Key form state
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [exaApiKey, setExaApiKey] = useState("");
  const [braveApiKey, setBraveApiKey] = useState("");
  const [serpapiApiKey, setSerpapiApiKey] = useState("");
  const [googleApiKey, setGoogleApiKey] = useState("");
  const [googleSearchEngineId, setGoogleSearchEngineId] = useState("");
  const [searxngBaseUrl, setSearxngBaseUrl] = useState("");
  const [searxngAllowPrivate, setSearxngAllowPrivate] = useState(false);
  const [keenableEnabled, setKeenableEnabled] = useState(false);
  const [keenableApiKey, setKeenableApiKey] = useState("");

  // Track which provider is active in the tab view
  const [activeProvider, setActiveProvider] = useState<SearchProviderType | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const status = await window.electronAPI.getSearchConfigStatus();
      setConfigStatus(status);
      setPrimaryProvider(status.primaryProvider);
      setFallbackProvider(status.fallbackProvider);
      setSearxngBaseUrl(status.searxng.baseUrl || "");
      setSearxngAllowPrivate(status.searxng.allowPrivate);
      setKeenableEnabled(status.keenable?.enabled === true);
      const offered = status.providers.filter(isProviderOffered);
      setActiveProvider((prev) => {
        if (prev && offered.some((provider) => provider.type === prev)) {
          return prev;
        }
        return (
          offered.find((provider) => provider.type === status.primaryProvider)?.type ??
          offered[0]?.type ??
          null
        );
      });
      onStatusChange?.(status.isConfigured);
    } catch (error) {
      console.error("Failed to load search config:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setTestResult(null);
      await window.electronAPI.saveSearchSettings({
        primaryProvider,
        fallbackProvider,
        tavily: tavilyApiKey ? { apiKey: tavilyApiKey } : undefined,
        exa: exaApiKey ? { apiKey: exaApiKey } : undefined,
        brave: braveApiKey ? { apiKey: braveApiKey } : undefined,
        serpapi: serpapiApiKey ? { apiKey: serpapiApiKey } : undefined,
        google:
          googleApiKey || googleSearchEngineId
            ? {
                apiKey: googleApiKey || undefined,
                searchEngineId: googleSearchEngineId || undefined,
              }
            : undefined,
        searxng: {
          baseUrl: searxngBaseUrl.trim() || undefined,
          allowPrivate: searxngAllowPrivate,
        },
        keenable: {
          enabled: keenableEnabled,
          apiKey: keenableApiKey.trim() || undefined,
        },
      });
      // Clear the input fields after saving
      setTavilyApiKey("");
      setExaApiKey("");
      setBraveApiKey("");
      setSerpapiApiKey("");
      setGoogleApiKey("");
      setGoogleSearchEngineId("");
      setKeenableApiKey("");
      await loadConfig();
      window.dispatchEvent(new Event(SEARCH_SETTINGS_CHANGED));
    } catch (error: Any) {
      console.error("Failed to save search settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleTestProvider = async (providerType: SearchProviderType) => {
    try {
      setTestingProvider(providerType);
      setTestResult(null);
      const result = await window.electronAPI.testSearchProvider(providerType);
      setTestResult({ provider: providerType, ...result });
    } catch (error: Any) {
      setTestResult({ provider: providerType, success: false, error: error.message });
    } finally {
      setTestingProvider(null);
    }
  };

  const offeredProviders = configStatus?.providers.filter(isProviderOffered) || [];
  const configuredProviders = offeredProviders.filter((provider) => provider.configured);
  const selectedPrimary =
    resolvePrimarySearchProvider(configuredProviders, primaryProvider)?.type ?? null;
  const fallbackOptions = configuredProviders.filter(
    (provider) => provider.type !== selectedPrimary && provider.type !== "duckduckgo",
  );
  const activeProviderConfig = offeredProviders.find((p) => p.type === activeProvider) || null;

  if (loading) {
    return <div className="settings-loading">Loading search settings...</div>;
  }

  return (
    <div className="search-settings">
      <div className="settings-section">
        <h3>Configure Search Providers</h3>
        <p className="settings-description">
          Configure API-backed or self-hosted web search. You can add multiple providers and set a
          primary and fallback.
        </p>

        <div className="llm-provider-tabs">
          {offeredProviders.map((provider) => (
            <button
              key={provider.type}
              className={`llm-provider-tab ${activeProvider === provider.type ? "active" : ""}`}
              onClick={() => {
                setActiveProvider(provider.type);
                setTestResult(null);
              }}
            >
              <span className="llm-provider-tab-label">{provider.name}</span>
              {provider.configured && <span className="llm-provider-tab-status" />}
            </button>
          ))}
        </div>

        {activeProviderConfig ? (
          <div className="settings-card provider-config-panel">
            <div className="provider-config-form">
              <p className="provider-description">{activeProviderConfig.description}</p>
              {activeProviderConfig.retirement && (
                <p className="settings-hint warning" role="note">
                  {activeProviderConfig.retirement.notice}
                </p>
              )}
              <p className="provider-types">
                Supports: {activeProviderConfig.supportedTypes.join(", ")}
              </p>

              {activeProviderConfig.type === "tavily" && (
                <div className="settings-field">
                  <label>Tavily API Key</label>
                  <input
                    type="password"
                    className="settings-input"
                    placeholder={activeProviderConfig.configured ? "••••••••••••••••" : "tvly-..."}
                    value={tavilyApiKey}
                    onChange={(e) => setTavilyApiKey(e.target.value)}
                  />
                  <p className="settings-hint">
                    Get your API key from{" "}
                    <a href="https://tavily.com/" target="_blank" rel="noopener noreferrer">
                      tavily.com
                    </a>
                  </p>
                </div>
              )}

              {activeProviderConfig.type === "exa" && (
                <div className="settings-field">
                  <label>Exa API Key</label>
                  <input
                    type="password"
                    className="settings-input"
                    placeholder={activeProviderConfig.configured ? "••••••••••••••••" : "exa_..."}
                    value={exaApiKey}
                    onChange={(e) => setExaApiKey(e.target.value)}
                  />
                  <p className="settings-hint">
                    Get your API key from{" "}
                    <a href="https://exa.ai/" target="_blank" rel="noopener noreferrer">
                      exa.ai
                    </a>
                  </p>
                </div>
              )}

              {activeProviderConfig.type === "brave" && (
                <div className="settings-field">
                  <label>Brave Search API Key</label>
                  <input
                    type="password"
                    className="settings-input"
                    placeholder={activeProviderConfig.configured ? "••••••••••••••••" : "BSA..."}
                    value={braveApiKey}
                    onChange={(e) => setBraveApiKey(e.target.value)}
                  />
                  <p className="settings-hint">
                    Get your API key from{" "}
                    <a
                      href="https://brave.com/search/api/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      brave.com/search/api
                    </a>
                  </p>
                </div>
              )}

              {activeProviderConfig.type === "serpapi" && (
                <div className="settings-field">
                  <label>SerpAPI Key</label>
                  <input
                    type="password"
                    className="settings-input"
                    placeholder={
                      activeProviderConfig.configured ? "••••••••••••••••" : "Enter API key"
                    }
                    value={serpapiApiKey}
                    onChange={(e) => setSerpapiApiKey(e.target.value)}
                  />
                  <p className="settings-hint">
                    Get your API key from{" "}
                    <a href="https://serpapi.com/" target="_blank" rel="noopener noreferrer">
                      serpapi.com
                    </a>
                  </p>
                </div>
              )}

              {activeProviderConfig.type === "google" && (
                <>
                  <div className="settings-field">
                    <label>Google API Key</label>
                    <input
                      type="password"
                      className="settings-input"
                      placeholder={activeProviderConfig.configured ? "••••••••••••••••" : "AIza..."}
                      value={googleApiKey}
                      onChange={(e) => setGoogleApiKey(e.target.value)}
                    />
                  </div>
                  <div className="settings-field">
                    <label>Search Engine ID</label>
                    <input
                      type="text"
                      className="settings-input"
                      placeholder="Enter Search Engine ID"
                      value={googleSearchEngineId}
                      onChange={(e) => setGoogleSearchEngineId(e.target.value)}
                    />
                    <p className="settings-hint">
                      Uses the key and Search Engine ID you already have.{" "}
                      <a
                        href="https://developers.google.com/custom-search/v1/overview"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Google&apos;s notice
                      </a>
                    </p>
                  </div>
                </>
              )}

              {activeProviderConfig.type === "searxng" && (
                <>
                  <div className="settings-field">
                    <label>SearXNG Instance URL</label>
                    <input
                      type="url"
                      className="settings-input"
                      placeholder={
                        activeProviderConfig.configured
                          ? "Configured SearXNG URL"
                          : "https://search.example.com"
                      }
                      value={searxngBaseUrl}
                      onChange={(e) => setSearxngBaseUrl(e.target.value)}
                    />
                    <p className="settings-hint">
                      JSON output must be enabled in the instance&apos;s <code>search.formats</code>
                      . No commercial API key is required. Clearing this URL and saving removes the
                      provider. SearXNG queries never fall through to another provider.{" "}
                      <a
                        href="https://docs.searxng.org/dev/search_api.html"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        SearXNG API guide
                      </a>
                    </p>
                  </div>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={searxngAllowPrivate}
                      onChange={(e) => setSearxngAllowPrivate(e.target.checked)}
                    />
                    <span>
                      Allow a private or local instance (for example localhost or a home/server LAN)
                    </span>
                  </label>
                </>
              )}

              {activeProviderConfig.type === "keenable" && (
                <>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={keenableEnabled}
                      onChange={(e) => setKeenableEnabled(e.target.checked)}
                    />
                    <span>Use Keenable for web search</span>
                  </label>
                  <div className="settings-field">
                    <label>Keenable API Key (optional)</label>
                    <input
                      type="password"
                      className="settings-input"
                      placeholder={
                        configStatus?.keenable?.hasApiKey ? "••••••••••••••••" : "keen_..."
                      }
                      value={keenableApiKey}
                      onChange={(e) => setKeenableApiKey(e.target.value)}
                    />
                    <p className="settings-hint">
                      Works without a key, limited to 1,000 searches an hour per IP address. A key
                      removes that limit. Keenable logs and stores search queries for keyless use
                      and on its default data policy.{" "}
                      <a
                        href="https://docs.keenable.ai/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Get a Keenable API key
                      </a>
                    </p>
                  </div>
                </>
              )}

              {activeProviderConfig.type === "duckduckgo" && (
                <div className="ddg-free-badge" style={{ margin: "8px 0" }}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "2px 8px",
                      borderRadius: "4px",
                      background: "var(--color-success, #22c55e)",
                      color: "#fff",
                      fontSize: "12px",
                      fontWeight: 600,
                    }}
                  >
                    Built-in (Free)
                  </span>
                  <p className="settings-hint" style={{ marginTop: "6px" }}>
                    DuckDuckGo search works out of the box with no configuration needed. It is used
                    only when no configured provider is available or it is explicitly selected.
                  </p>
                </div>
              )}

              {activeProviderConfig.configured && (
                <button
                  className="button-small button-secondary"
                  onClick={() => handleTestProvider(activeProviderConfig.type)}
                  disabled={testingProvider === activeProviderConfig.type}
                >
                  {testingProvider === activeProviderConfig.type ? "Testing..." : "Test Connection"}
                </button>
              )}

              {testResult?.provider === activeProviderConfig.type && (
                <div className={`test-result-inline ${testResult.success ? "success" : "error"}`}>
                  {testResult.success ? "✓ Connection successful" : `✗ ${testResult.error}`}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="settings-empty">Select a provider to configure.</div>
        )}
      </div>

      {configuredProviders.length > 1 && (
        <>
          <div className="settings-section">
            <h3>Primary Provider</h3>
            <p className="settings-description">Select which search provider to use by default.</p>

            <div className="provider-options">
              {configuredProviders.map((provider) => (
                <label
                  key={provider.type}
                  className={`provider-option ${selectedPrimary === provider.type ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="primaryProvider"
                    checked={selectedPrimary === provider.type}
                    onChange={() => {
                      setPrimaryProvider(provider.type);
                      if (
                        !supportsSearchFallback(provider.type) ||
                        fallbackProvider === provider.type
                      ) {
                        setFallbackProvider(null);
                      }
                    }}
                  />
                  <div className="provider-option-content">
                    <span className="provider-name">{provider.name}</span>
                    <span className="provider-types">
                      Supports: {provider.supportedTypes.join(", ")}
                    </span>
                    {provider.retirement && (
                      <span className="settings-hint warning">
                        Ends {formatEndDate(provider.retirement.endsOn)}
                      </span>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {fallbackOptions.length > 0 && supportsSearchFallback(selectedPrimary) && (
            <div className="settings-section">
              <h3>Fallback Provider</h3>
              <p className="settings-description">
                If the primary provider fails, the fallback will be used automatically.
              </p>

              <div className="provider-options">
                <label className={`provider-option ${fallbackProvider === null ? "selected" : ""}`}>
                  <input
                    type="radio"
                    name="fallbackProvider"
                    checked={fallbackProvider === null}
                    onChange={() => setFallbackProvider(null)}
                  />
                  <div className="provider-option-content">
                    <span className="provider-name">None</span>
                    <span className="provider-description">
                      Strict: do not send the query to any other provider
                    </span>
                  </div>
                </label>

                {fallbackOptions.map((provider) => (
                  <label
                    key={provider.type}
                    className={`provider-option ${fallbackProvider === provider.type ? "selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="fallbackProvider"
                      checked={fallbackProvider === provider.type}
                      onChange={() => setFallbackProvider(provider.type)}
                    />
                    <div className="provider-option-content">
                      <span className="provider-name">{provider.name}</span>
                      <span className="provider-types">
                        Supports: {provider.supportedTypes.join(", ")}
                      </span>
                      {provider.retirement && (
                        <span className="settings-hint warning">
                          Ends {formatEndDate(provider.retirement.endsOn)}
                        </span>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="settings-actions">
        <button className="button-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
