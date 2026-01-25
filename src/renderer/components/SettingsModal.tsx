import { useState, useEffect } from 'react';
import { LLMSettingsData } from '../../shared/types';
import { TelegramSettings } from './TelegramSettings';
import { SearchSettings } from './SearchSettings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ModelOption {
  key: string;
  displayName: string;
}

interface ProviderInfo {
  type: string;
  name: string;
  configured: boolean;
}

type SettingsTab = 'llm' | 'search' | 'telegram';

// Helper to format bytes to human-readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('llm');
  const [settings, setSettings] = useState<LLMSettingsData>({
    providerType: 'anthropic',
    modelKey: 'sonnet-3-5',
  });
  const [models, setModels] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Form state for credentials (not persisted directly)
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [awsRegion, setAwsRegion] = useState('us-east-1');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsProfile, setAwsProfile] = useState('');
  const [useDefaultCredentials, setUseDefaultCredentials] = useState(true);

  // Ollama state
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3.2');
  const [ollamaApiKey, setOllamaApiKey] = useState('');
  const [ollamaModels, setOllamaModels] = useState<Array<{ name: string; size: number }>>([]);
  const [loadingOllamaModels, setLoadingOllamaModels] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadConfigStatus();
    }
  }, [isOpen]);

  const loadConfigStatus = async () => {
    try {
      setLoading(true);
      // Load config status which includes settings, providers, and models
      const configStatus = await window.electronAPI.getLLMConfigStatus();

      // Set providers
      setProviders(configStatus.providers || []);
      setModels(configStatus.models || []);

      // Load full settings separately for bedrock config
      const loadedSettings = await window.electronAPI.getLLMSettings();
      setSettings(loadedSettings);

      // Set form state from loaded settings
      if (loadedSettings.bedrock?.region) {
        setAwsRegion(loadedSettings.bedrock.region);
      }
      if (loadedSettings.bedrock?.profile) {
        setAwsProfile(loadedSettings.bedrock.profile);
      }
      setUseDefaultCredentials(loadedSettings.bedrock?.useDefaultCredentials ?? true);

      // Set Ollama form state
      if (loadedSettings.ollama?.baseUrl) {
        setOllamaBaseUrl(loadedSettings.ollama.baseUrl);
      }
      if (loadedSettings.ollama?.model) {
        setOllamaModel(loadedSettings.ollama.model);
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadOllamaModels = async (baseUrl?: string) => {
    try {
      setLoadingOllamaModels(true);
      const models = await window.electronAPI.getOllamaModels(baseUrl || ollamaBaseUrl);
      setOllamaModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (models && models.length > 0 && !models.some(m => m.name === ollamaModel)) {
        setOllamaModel(models[0].name);
      }
    } catch (error) {
      console.error('Failed to load Ollama models:', error);
      setOllamaModels([]);
    } finally {
      setLoadingOllamaModels(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setTestResult(null);

      const settingsToSave: LLMSettingsData = {
        ...settings,
        anthropic: settings.providerType === 'anthropic' ? {
          apiKey: anthropicApiKey || undefined,
        } : undefined,
        bedrock: settings.providerType === 'bedrock' ? {
          region: awsRegion,
          useDefaultCredentials,
          ...(useDefaultCredentials ? {
            profile: awsProfile || undefined,
          } : {
            accessKeyId: awsAccessKeyId || undefined,
            secretAccessKey: awsSecretAccessKey || undefined,
          }),
        } : undefined,
        ollama: settings.providerType === 'ollama' ? {
          baseUrl: ollamaBaseUrl || undefined,
          model: ollamaModel || undefined,
          apiKey: ollamaApiKey || undefined,
        } : undefined,
      };

      await window.electronAPI.saveLLMSettings(settingsToSave);
      onClose();
    } catch (error) {
      console.error('Failed to save settings:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    try {
      setTesting(true);
      setTestResult(null);

      const testConfig = {
        providerType: settings.providerType,
        modelKey: settings.modelKey,
        anthropic: settings.providerType === 'anthropic' ? {
          apiKey: anthropicApiKey || undefined,
        } : undefined,
        bedrock: settings.providerType === 'bedrock' ? {
          region: awsRegion,
          ...(useDefaultCredentials ? {
            profile: awsProfile || undefined,
          } : {
            accessKeyId: awsAccessKeyId || undefined,
            secretAccessKey: awsSecretAccessKey || undefined,
          }),
        } : undefined,
        ollama: settings.providerType === 'ollama' ? {
          baseUrl: ollamaBaseUrl || undefined,
          model: ollamaModel || undefined,
          apiKey: ollamaApiKey || undefined,
        } : undefined,
      };

      const result = await window.electronAPI.testLLMProvider(testConfig);
      setTestResult(result);
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setTesting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="settings-tabs">
            <button
              className={`settings-tab ${activeTab === 'llm' ? 'active' : ''}`}
              onClick={() => setActiveTab('llm')}
            >
              LLM Provider
            </button>
            <button
              className={`settings-tab ${activeTab === 'search' ? 'active' : ''}`}
              onClick={() => setActiveTab('search')}
            >
              Web Search
            </button>
            <button
              className={`settings-tab ${activeTab === 'telegram' ? 'active' : ''}`}
              onClick={() => setActiveTab('telegram')}
            >
              Telegram
            </button>
          </div>

          {activeTab === 'telegram' ? (
            <TelegramSettings />
          ) : activeTab === 'search' ? (
            <SearchSettings />
          ) : loading ? (
            <div className="settings-loading">Loading settings...</div>
          ) : (
            <>
              <div className="settings-section">
                <h3>LLM Provider</h3>
                <p className="settings-description">
                  Choose which service to use for AI model calls
                </p>

                <div className="provider-options">
                  {providers.map(provider => {
                    const isAnthropic = provider.type === 'anthropic';
                    const isBedrock = provider.type === 'bedrock';
                    const isOllama = provider.type === 'ollama';

                    return (
                      <label
                        key={provider.type}
                        className={`provider-option ${settings.providerType === provider.type ? 'selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name="provider"
                          value={provider.type}
                          checked={settings.providerType === provider.type}
                          onChange={() => {
                            setSettings({ ...settings, providerType: provider.type as 'anthropic' | 'bedrock' | 'ollama' });
                            // Load Ollama models when selecting Ollama
                            if (provider.type === 'ollama') {
                              loadOllamaModels();
                            }
                          }}
                        />
                        <div className="provider-option-content">
                          <div className="provider-option-title">
                            {provider.name}
                            {provider.configured && (
                              <span className="provider-configured" title="Credentials detected">
                                [Configured]
                              </span>
                            )}
                          </div>
                          <div className="provider-option-description">
                            {isAnthropic && provider.configured && (
                              <>Using API key from environment or settings</>
                            )}
                            {isAnthropic && !provider.configured && (
                              <>Set ANTHROPIC_API_KEY in .env or enter below</>
                            )}
                            {isBedrock && provider.configured && (
                              <>Using AWS credentials from environment or settings</>
                            )}
                            {isBedrock && !provider.configured && (
                              <>Configure AWS credentials below or in environment</>
                            )}
                            {isOllama && provider.configured && (
                              <>Ollama server detected - configure model below</>
                            )}
                            {isOllama && !provider.configured && (
                              <>Run local LLM models with Ollama</>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {settings.providerType !== 'ollama' && (
                <div className="settings-section">
                  <h3>Model</h3>
                  <select
                    className="settings-select"
                    value={settings.modelKey}
                    onChange={(e) => setSettings({ ...settings, modelKey: e.target.value })}
                  >
                    {models.map(model => (
                      <option key={model.key} value={model.key}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {settings.providerType === 'anthropic' && (
                <div className="settings-section">
                  <h3>Anthropic API Key</h3>
                  <p className="settings-description">
                    Enter your API key from console.anthropic.com, or leave empty to use environment variable.
                  </p>
                  <input
                    type="password"
                    className="settings-input"
                    placeholder="sk-ant-..."
                    value={anthropicApiKey}
                    onChange={(e) => setAnthropicApiKey(e.target.value)}
                  />
                </div>
              )}

              {settings.providerType === 'bedrock' && (
                <>
                  <div className="settings-section">
                    <h3>AWS Region</h3>
                    <select
                      className="settings-select"
                      value={awsRegion}
                      onChange={(e) => setAwsRegion(e.target.value)}
                    >
                      <option value="us-east-1">US East (N. Virginia)</option>
                      <option value="us-west-2">US West (Oregon)</option>
                      <option value="eu-west-1">Europe (Ireland)</option>
                      <option value="eu-central-1">Europe (Frankfurt)</option>
                      <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
                      <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
                      <option value="ap-southeast-2">Asia Pacific (Sydney)</option>
                    </select>
                  </div>

                  <div className="settings-section">
                    <h3>AWS Credentials</h3>

                    <label className="settings-checkbox">
                      <input
                        type="checkbox"
                        checked={useDefaultCredentials}
                        onChange={(e) => setUseDefaultCredentials(e.target.checked)}
                      />
                      <span>Use default credential chain (recommended)</span>
                    </label>

                    {useDefaultCredentials ? (
                      <div className="settings-subsection">
                        <p className="settings-description">
                          Uses AWS credentials from environment variables, shared credentials file (~/.aws/credentials), or IAM role.
                        </p>
                        <input
                          type="text"
                          className="settings-input"
                          placeholder="AWS Profile (optional, e.g., 'default')"
                          value={awsProfile}
                          onChange={(e) => setAwsProfile(e.target.value)}
                        />
                      </div>
                    ) : (
                      <div className="settings-subsection">
                        <input
                          type="text"
                          className="settings-input"
                          placeholder="AWS Access Key ID"
                          value={awsAccessKeyId}
                          onChange={(e) => setAwsAccessKeyId(e.target.value)}
                        />
                        <input
                          type="password"
                          className="settings-input"
                          placeholder="AWS Secret Access Key"
                          value={awsSecretAccessKey}
                          onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                </>
              )}

              {settings.providerType === 'ollama' && (
                <>
                  <div className="settings-section">
                    <h3>Ollama Server URL</h3>
                    <p className="settings-description">
                      URL of your Ollama server. Default is http://localhost:11434 for local installations.
                    </p>
                    <div className="settings-input-group">
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="http://localhost:11434"
                        value={ollamaBaseUrl}
                        onChange={(e) => setOllamaBaseUrl(e.target.value)}
                      />
                      <button
                        className="button-small button-secondary"
                        onClick={() => loadOllamaModels(ollamaBaseUrl)}
                        disabled={loadingOllamaModels}
                      >
                        {loadingOllamaModels ? 'Loading...' : 'Refresh Models'}
                      </button>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Model</h3>
                    <p className="settings-description">
                      Select from models available on your Ollama server, or enter a custom model name.
                    </p>
                    {ollamaModels.length > 0 ? (
                      <select
                        className="settings-select"
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                      >
                        {ollamaModels.map(model => (
                          <option key={model.name} value={model.name}>
                            {model.name} ({formatBytes(model.size)})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="llama3.2"
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                      />
                    )}
                    <p className="settings-hint">
                      Don't have models? Run <code>ollama pull llama3.2</code> to download a model.
                    </p>
                  </div>

                  <div className="settings-section">
                    <h3>API Key (Optional)</h3>
                    <p className="settings-description">
                      Only needed if connecting to a remote Ollama server that requires authentication.
                    </p>
                    <input
                      type="password"
                      className="settings-input"
                      placeholder="Optional API key for remote servers"
                      value={ollamaApiKey}
                      onChange={(e) => setOllamaApiKey(e.target.value)}
                    />
                  </div>
                </>
              )}

              {testResult && (
                <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
                  {testResult.success ? (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                        <path d="M22 4L12 14.01l-3-3" />
                      </svg>
                      Connection successful!
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                      </svg>
                      {testResult.error || 'Connection failed'}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {activeTab === 'llm' && (
          <div className="modal-footer">
            <button
              className="button-secondary"
              onClick={handleTestConnection}
              disabled={loading || testing}
            >
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            <div className="modal-footer-right">
              <button className="button-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="button-primary"
                onClick={handleSave}
                disabled={loading || saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'telegram' && (
          <div className="modal-footer">
            <div className="modal-footer-right">
              <button className="button-secondary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}

        {activeTab === 'search' && (
          <div className="modal-footer">
            <div className="modal-footer-right">
              <button className="button-secondary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
