import { useState, useEffect } from 'react';
import { SearchProviderType, SearchConfigStatus } from '../../shared/types';

interface SearchSettingsProps {
  onStatusChange?: (configured: boolean) => void;
}

export function SearchSettings({ onStatusChange }: SearchSettingsProps) {
  const [configStatus, setConfigStatus] = useState<SearchConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingProvider, setTestingProvider] = useState<SearchProviderType | null>(null);
  const [testResult, setTestResult] = useState<{ provider: SearchProviderType; success: boolean; error?: string } | null>(null);

  // Form state
  const [primaryProvider, setPrimaryProvider] = useState<SearchProviderType | null>(null);
  const [fallbackProvider, setFallbackProvider] = useState<SearchProviderType | null>(null);

  // API Key form state
  const [tavilyApiKey, setTavilyApiKey] = useState('');
  const [braveApiKey, setBraveApiKey] = useState('');
  const [serpapiApiKey, setSerpapiApiKey] = useState('');
  const [googleApiKey, setGoogleApiKey] = useState('');
  const [googleSearchEngineId, setGoogleSearchEngineId] = useState('');

  // Track which sections are expanded
  const [expandedProvider, setExpandedProvider] = useState<SearchProviderType | null>(null);

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
      onStatusChange?.(status.isConfigured);
    } catch (error) {
      console.error('Failed to load search config:', error);
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
        brave: braveApiKey ? { apiKey: braveApiKey } : undefined,
        serpapi: serpapiApiKey ? { apiKey: serpapiApiKey } : undefined,
        google: (googleApiKey || googleSearchEngineId) ? {
          apiKey: googleApiKey || undefined,
          searchEngineId: googleSearchEngineId || undefined,
        } : undefined,
      });
      // Clear the input fields after saving
      setTavilyApiKey('');
      setBraveApiKey('');
      setSerpapiApiKey('');
      setGoogleApiKey('');
      setGoogleSearchEngineId('');
      await loadConfig();
    } catch (error: any) {
      console.error('Failed to save search settings:', error);
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
    } catch (error: any) {
      setTestResult({ provider: providerType, success: false, error: error.message });
    } finally {
      setTestingProvider(null);
    }
  };

  const configuredProviders = configStatus?.providers.filter(p => p.configured) || [];
  const hasMultipleProviders = configuredProviders.length > 1;

  if (loading) {
    return <div className="settings-loading">Loading search settings...</div>;
  }

  return (
    <div className="search-settings">
      <div className="settings-section">
        <h3>Configure Search Providers</h3>
        <p className="settings-description">
          Add API keys to enable web search. You can configure multiple providers and set a primary and fallback.
        </p>

        <div className="provider-config-list">
          {configStatus?.providers.map(provider => (
            <div key={provider.type} className="provider-config-item">
              <div
                className="provider-config-header"
                onClick={() => setExpandedProvider(
                  expandedProvider === provider.type ? null : provider.type
                )}
              >
                <div className="provider-config-info">
                  <span className="provider-name">{provider.name}</span>
                  <span className={`provider-status ${provider.configured ? 'configured' : 'not-configured'}`}>
                    {provider.configured ? '✓ Configured' : '○ Not configured'}
                  </span>
                </div>
                <span className="provider-expand-icon">
                  {expandedProvider === provider.type ? '▼' : '▶'}
                </span>
              </div>

              {expandedProvider === provider.type && (
                <div className="provider-config-form">
                  <p className="provider-description">{provider.description}</p>
                  <p className="provider-types">
                    Supports: {provider.supportedTypes.join(', ')}
                  </p>

                  {provider.type === 'tavily' && (
                    <div className="settings-field">
                      <label>Tavily API Key</label>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder={provider.configured ? '••••••••••••••••' : 'tvly-...'}
                        value={tavilyApiKey}
                        onChange={(e) => setTavilyApiKey(e.target.value)}
                      />
                      <p className="settings-hint">
                        Get your API key from <a href="https://tavily.com/" target="_blank" rel="noopener noreferrer">tavily.com</a>
                      </p>
                    </div>
                  )}

                  {provider.type === 'brave' && (
                    <div className="settings-field">
                      <label>Brave Search API Key</label>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder={provider.configured ? '••••••••••••••••' : 'BSA...'}
                        value={braveApiKey}
                        onChange={(e) => setBraveApiKey(e.target.value)}
                      />
                      <p className="settings-hint">
                        Get your API key from <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer">brave.com/search/api</a>
                      </p>
                    </div>
                  )}

                  {provider.type === 'serpapi' && (
                    <div className="settings-field">
                      <label>SerpAPI Key</label>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder={provider.configured ? '••••••••••••••••' : 'Enter API key'}
                        value={serpapiApiKey}
                        onChange={(e) => setSerpapiApiKey(e.target.value)}
                      />
                      <p className="settings-hint">
                        Get your API key from <a href="https://serpapi.com/" target="_blank" rel="noopener noreferrer">serpapi.com</a>
                      </p>
                    </div>
                  )}

                  {provider.type === 'google' && (
                    <>
                      <div className="settings-field">
                        <label>Google API Key</label>
                        <input
                          type="password"
                          className="settings-input"
                          placeholder={provider.configured ? '••••••••••••••••' : 'AIza...'}
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
                          Get your credentials from <a href="https://developers.google.com/custom-search/v1/introduction" target="_blank" rel="noopener noreferrer">Google Custom Search</a>
                        </p>
                      </div>
                    </>
                  )}

                  {provider.configured && (
                    <button
                      className="button-small button-secondary"
                      onClick={() => handleTestProvider(provider.type)}
                      disabled={testingProvider === provider.type}
                    >
                      {testingProvider === provider.type ? 'Testing...' : 'Test Connection'}
                    </button>
                  )}

                  {testResult?.provider === provider.type && (
                    <div className={`test-result-inline ${testResult.success ? 'success' : 'error'}`}>
                      {testResult.success ? '✓ Connection successful' : `✗ ${testResult.error}`}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {configuredProviders.length > 0 && (
        <>
          <div className="settings-section">
            <h3>Primary Provider</h3>
            <p className="settings-description">
              Select which search provider to use by default.
            </p>

            <div className="provider-options">
              {configuredProviders.map(provider => (
                <label
                  key={provider.type}
                  className={`provider-option ${primaryProvider === provider.type ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="primaryProvider"
                    checked={primaryProvider === provider.type}
                    onChange={() => {
                      setPrimaryProvider(provider.type);
                      // Clear fallback if same as new primary
                      if (fallbackProvider === provider.type) {
                        setFallbackProvider(null);
                      }
                    }}
                  />
                  <div className="provider-option-content">
                    <span className="provider-name">{provider.name}</span>
                    <span className="provider-types">
                      Supports: {provider.supportedTypes.join(', ')}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {hasMultipleProviders && (
            <div className="settings-section">
              <h3>Fallback Provider</h3>
              <p className="settings-description">
                If the primary provider fails, the fallback will be used automatically.
              </p>

              <div className="provider-options">
                <label
                  className={`provider-option ${fallbackProvider === null ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="fallbackProvider"
                    checked={fallbackProvider === null}
                    onChange={() => setFallbackProvider(null)}
                  />
                  <div className="provider-option-content">
                    <span className="provider-name">None</span>
                    <span className="provider-description">No fallback - fail if primary is unavailable</span>
                  </div>
                </label>

                {configuredProviders
                  .filter(p => p.type !== primaryProvider)
                  .map(provider => (
                    <label
                      key={provider.type}
                      className={`provider-option ${fallbackProvider === provider.type ? 'selected' : ''}`}
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
                          Supports: {provider.supportedTypes.join(', ')}
                        </span>
                      </div>
                    </label>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="settings-actions">
        <button
          className="button-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
