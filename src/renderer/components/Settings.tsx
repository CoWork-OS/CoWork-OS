import { useState, useEffect, useRef } from 'react';
import { LLMSettingsData, ThemeMode, AccentColor } from '../../shared/types';
import { TelegramSettings } from './TelegramSettings';
import { DiscordSettings } from './DiscordSettings';
import { SearchSettings } from './SearchSettings';
import { UpdateSettings } from './UpdateSettings';
import { GuardrailSettings } from './GuardrailSettings';
import { AppearanceSettings } from './AppearanceSettings';

interface SettingsProps {
  onBack: () => void;
  onSettingsChanged?: () => void;
  themeMode: ThemeMode;
  accentColor: AccentColor;
  onThemeChange: (theme: ThemeMode) => void;
  onAccentChange: (accent: AccentColor) => void;
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

type SettingsTab = 'appearance' | 'llm' | 'search' | 'telegram' | 'discord' | 'updates' | 'guardrails';

// Helper to format bytes to human-readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Searchable Select Component
interface SearchableSelectOption {
  value: string;
  label: string;
  description?: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

function SearchableSelect({ options, value, onChange, placeholder = 'Select...', className = '' }: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(opt => opt.value === value);

  const filteredOptions = options.filter(opt =>
    opt.label.toLowerCase().includes(search.toLowerCase()) ||
    opt.value.toLowerCase().includes(search.toLowerCase()) ||
    (opt.description && opt.description.toLowerCase().includes(search.toLowerCase()))
  );

  // Reset highlighted index when search changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      const highlightedEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
      if (highlightedEl) {
        highlightedEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex, isOpen]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(i => Math.min(i + 1, filteredOptions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredOptions[highlightedIndex]) {
          onChange(filteredOptions[highlightedIndex].value);
          setIsOpen(false);
          setSearch('');
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setSearch('');
        break;
    }
  };

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
    setSearch('');
  };

  return (
    <div ref={containerRef} className={`searchable-select ${className}`}>
      <div
        className={`searchable-select-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) {
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        <span className="searchable-select-value">
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <svg className="searchable-select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>

      {isOpen && (
        <div className="searchable-select-dropdown">
          <div className="searchable-select-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search models..."
              autoFocus
            />
          </div>
          <div ref={listRef} className="searchable-select-options">
            {filteredOptions.length === 0 ? (
              <div className="searchable-select-no-results">No models found</div>
            ) : (
              filteredOptions.map((opt, index) => (
                <div
                  key={opt.value}
                  data-index={index}
                  className={`searchable-select-option ${opt.value === value ? 'selected' : ''} ${index === highlightedIndex ? 'highlighted' : ''}`}
                  onClick={() => handleSelect(opt.value)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span className="searchable-select-option-label">{opt.label}</span>
                  {opt.description && (
                    <span className="searchable-select-option-desc">{opt.description}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Settings({ onBack, onSettingsChanged, themeMode, accentColor, onThemeChange, onAccentChange }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
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

  // Gemini state
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-2.0-flash');
  const [geminiModels, setGeminiModels] = useState<Array<{ name: string; displayName: string; description: string }>>([]);
  const [loadingGeminiModels, setLoadingGeminiModels] = useState(false);

  // OpenRouter state
  const [openrouterApiKey, setOpenrouterApiKey] = useState('');
  const [openrouterModel, setOpenrouterModel] = useState('anthropic/claude-3.5-sonnet');
  const [openrouterModels, setOpenrouterModels] = useState<Array<{ id: string; name: string; context_length: number }>>([]);
  const [loadingOpenRouterModels, setLoadingOpenRouterModels] = useState(false);

  // Bedrock state
  const [bedrockModel, setBedrockModel] = useState('');
  const [bedrockModels, setBedrockModels] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [loadingBedrockModels, setLoadingBedrockModels] = useState(false);

  useEffect(() => {
    loadConfigStatus();
  }, []);

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

      // Set Anthropic form state
      if (loadedSettings.anthropic?.apiKey) {
        setAnthropicApiKey(loadedSettings.anthropic.apiKey);
      }

      // Set Ollama form state
      if (loadedSettings.ollama?.baseUrl) {
        setOllamaBaseUrl(loadedSettings.ollama.baseUrl);
      }
      if (loadedSettings.ollama?.model) {
        setOllamaModel(loadedSettings.ollama.model);
      }
      if (loadedSettings.ollama?.apiKey) {
        setOllamaApiKey(loadedSettings.ollama.apiKey);
      }

      // Set Gemini form state
      if (loadedSettings.gemini?.apiKey) {
        setGeminiApiKey(loadedSettings.gemini.apiKey);
      }
      if (loadedSettings.gemini?.model) {
        setGeminiModel(loadedSettings.gemini.model);
      }

      // Set OpenRouter form state
      if (loadedSettings.openrouter?.apiKey) {
        setOpenrouterApiKey(loadedSettings.openrouter.apiKey);
      }
      if (loadedSettings.openrouter?.model) {
        setOpenrouterModel(loadedSettings.openrouter.model);
      }

      // Set Bedrock form state (access key and secret key are set earlier)
      if (loadedSettings.bedrock?.accessKeyId) {
        setAwsAccessKeyId(loadedSettings.bedrock.accessKeyId);
      }
      if (loadedSettings.bedrock?.secretAccessKey) {
        setAwsSecretAccessKey(loadedSettings.bedrock.secretAccessKey);
      }
      if (loadedSettings.bedrock?.model) {
        setBedrockModel(loadedSettings.bedrock.model);
      }

      // Populate dropdown arrays from cached models
      if (loadedSettings.cachedGeminiModels && loadedSettings.cachedGeminiModels.length > 0) {
        setGeminiModels(loadedSettings.cachedGeminiModels.map((m: any) => ({
          name: m.key,
          displayName: m.displayName,
          description: m.description,
        })));
      }
      if (loadedSettings.cachedOpenRouterModels && loadedSettings.cachedOpenRouterModels.length > 0) {
        setOpenrouterModels(loadedSettings.cachedOpenRouterModels.map((m: any) => ({
          id: m.key,
          name: m.displayName,
          context_length: m.contextLength || 0,
        })));
      }
      if (loadedSettings.cachedOllamaModels && loadedSettings.cachedOllamaModels.length > 0) {
        setOllamaModels(loadedSettings.cachedOllamaModels.map((m: any) => ({
          name: m.key,
          size: m.size || 0,
        })));
      }
      if (loadedSettings.cachedBedrockModels && loadedSettings.cachedBedrockModels.length > 0) {
        setBedrockModels(loadedSettings.cachedBedrockModels.map((m: any) => ({
          id: m.key,
          name: m.displayName,
          description: m.description || '',
        })));
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
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error('Failed to load Ollama models:', error);
      setOllamaModels([]);
    } finally {
      setLoadingOllamaModels(false);
    }
  };

  const loadGeminiModels = async (apiKey?: string) => {
    try {
      setLoadingGeminiModels(true);
      const models = await window.electronAPI.getGeminiModels(apiKey || geminiApiKey);
      setGeminiModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (models && models.length > 0 && !models.some(m => m.name === geminiModel)) {
        setGeminiModel(models[0].name);
      }
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error('Failed to load Gemini models:', error);
      setGeminiModels([]);
    } finally {
      setLoadingGeminiModels(false);
    }
  };

  const loadOpenRouterModels = async (apiKey?: string) => {
    try {
      setLoadingOpenRouterModels(true);
      const models = await window.electronAPI.getOpenRouterModels(apiKey || openrouterApiKey);
      setOpenrouterModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (models && models.length > 0 && !models.some(m => m.id === openrouterModel)) {
        setOpenrouterModel(models[0].id);
      }
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error('Failed to load OpenRouter models:', error);
      setOpenrouterModels([]);
    } finally {
      setLoadingOpenRouterModels(false);
    }
  };

  const loadBedrockModels = async () => {
    try {
      setLoadingBedrockModels(true);
      const config = useDefaultCredentials
        ? { region: awsRegion, profile: awsProfile || undefined }
        : { region: awsRegion, accessKeyId: awsAccessKeyId || undefined, secretAccessKey: awsSecretAccessKey || undefined };
      const models = await window.electronAPI.getBedrockModels(config);
      setBedrockModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (models && models.length > 0 && !models.some((m: any) => m.id === bedrockModel)) {
        setBedrockModel(models[0].id);
      }
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error('Failed to load Bedrock models:', error);
      setBedrockModels([]);
    } finally {
      setLoadingBedrockModels(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setTestResult(null);

      // Always save settings for ALL providers to preserve API keys and model selections
      // when switching between providers
      const settingsToSave: LLMSettingsData = {
        ...settings,
        // Always include anthropic settings
        anthropic: {
          apiKey: anthropicApiKey || undefined,
        },
        // Always include bedrock settings
        bedrock: {
          region: awsRegion,
          useDefaultCredentials,
          model: bedrockModel || undefined,
          ...(useDefaultCredentials ? {
            profile: awsProfile || undefined,
          } : {
            accessKeyId: awsAccessKeyId || undefined,
            secretAccessKey: awsSecretAccessKey || undefined,
          }),
        },
        // Always include ollama settings
        ollama: {
          baseUrl: ollamaBaseUrl || undefined,
          model: ollamaModel || undefined,
          apiKey: ollamaApiKey || undefined,
        },
        // Always include gemini settings
        gemini: {
          apiKey: geminiApiKey || undefined,
          model: geminiModel || undefined,
        },
        // Always include openrouter settings
        openrouter: {
          apiKey: openrouterApiKey || undefined,
          model: openrouterModel || undefined,
        },
      };

      await window.electronAPI.saveLLMSettings(settingsToSave);
      onSettingsChanged?.();
      onBack();
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
        gemini: settings.providerType === 'gemini' ? {
          apiKey: geminiApiKey || undefined,
          model: geminiModel || undefined,
        } : undefined,
        openrouter: settings.providerType === 'openrouter' ? {
          apiKey: openrouterApiKey || undefined,
          model: openrouterModel || undefined,
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

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <h1>Settings</h1>
      </div>

      <div className="settings-page-layout">
        <div className="settings-sidebar">
          <button className="settings-back-btn" onClick={onBack}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <div className="settings-nav-divider" />
          <button
            className={`settings-nav-item ${activeTab === 'appearance' ? 'active' : ''}`}
            onClick={() => setActiveTab('appearance')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
            Appearance
          </button>
          <button
            className={`settings-nav-item ${activeTab === 'llm' ? 'active' : ''}`}
            onClick={() => setActiveTab('llm')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            LLM Provider
          </button>
          <button
            className={`settings-nav-item ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            Web Search
          </button>
          <button
            className={`settings-nav-item ${activeTab === 'telegram' ? 'active' : ''}`}
            onClick={() => setActiveTab('telegram')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
            Telegram
          </button>
          <button
            className={`settings-nav-item ${activeTab === 'discord' ? 'active' : ''}`}
            onClick={() => setActiveTab('discord')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Discord
          </button>
          <button
            className={`settings-nav-item ${activeTab === 'updates' ? 'active' : ''}`}
            onClick={() => setActiveTab('updates')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 11-6.219-8.56" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
            Updates
          </button>
          <button
            className={`settings-nav-item ${activeTab === 'guardrails' ? 'active' : ''}`}
            onClick={() => setActiveTab('guardrails')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Guardrails
          </button>
        </div>

        <div className="settings-content">
          {activeTab === 'appearance' ? (
            <AppearanceSettings
              themeMode={themeMode}
              accentColor={accentColor}
              onThemeChange={onThemeChange}
              onAccentChange={onAccentChange}
            />
          ) : activeTab === 'telegram' ? (
            <TelegramSettings />
          ) : activeTab === 'discord' ? (
            <DiscordSettings />
          ) : activeTab === 'search' ? (
            <SearchSettings />
          ) : activeTab === 'updates' ? (
            <UpdateSettings />
          ) : activeTab === 'guardrails' ? (
            <GuardrailSettings />
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
                    const isGemini = provider.type === 'gemini';
                    const isOpenRouter = provider.type === 'openrouter';

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
                            setSettings({ ...settings, providerType: provider.type as 'anthropic' | 'bedrock' | 'ollama' | 'gemini' | 'openrouter' });
                            // Load models when selecting provider
                            if (provider.type === 'ollama') {
                              loadOllamaModels();
                            } else if (provider.type === 'gemini') {
                              loadGeminiModels();
                            } else if (provider.type === 'openrouter') {
                              loadOpenRouterModels();
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
                              <>API key configured</>
                            )}
                            {isAnthropic && !provider.configured && (
                              <>Enter your Anthropic API key below</>
                            )}
                            {isGemini && provider.configured && (
                              <>API key configured</>
                            )}
                            {isGemini && !provider.configured && (
                              <>Enter your Gemini API key below</>
                            )}
                            {isOpenRouter && provider.configured && (
                              <>API key configured</>
                            )}
                            {isOpenRouter && !provider.configured && (
                              <>Enter your OpenRouter API key below</>
                            )}
                            {isBedrock && provider.configured && (
                              <>AWS credentials configured</>
                            )}
                            {isBedrock && !provider.configured && (
                              <>Configure your AWS credentials below</>
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

              {settings.providerType === 'anthropic' && (
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
                    Enter your API key from{' '}
                    <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer">
                      console.anthropic.com
                    </a>
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

              {settings.providerType === 'gemini' && (
                <>
                  <div className="settings-section">
                    <h3>Gemini API Key</h3>
                    <p className="settings-description">
                      Enter your API key from{' '}
                      <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
                        Google AI Studio
                      </a>
                    </p>
                    <div className="settings-input-group">
                      <input
                        type="password"
                        className="settings-input"
                        placeholder="AIza..."
                        value={geminiApiKey}
                        onChange={(e) => setGeminiApiKey(e.target.value)}
                      />
                      <button
                        className="button-small button-secondary"
                        onClick={() => loadGeminiModels(geminiApiKey)}
                        disabled={loadingGeminiModels}
                      >
                        {loadingGeminiModels ? 'Loading...' : 'Refresh Models'}
                      </button>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Model</h3>
                    <p className="settings-description">
                      Select a Gemini model. Enter your API key and click "Refresh Models" to load available models.
                    </p>
                    {geminiModels.length > 0 ? (
                      <SearchableSelect
                        options={geminiModels.map(model => ({
                          value: model.name,
                          label: model.displayName,
                          description: model.description,
                        }))}
                        value={geminiModel}
                        onChange={setGeminiModel}
                        placeholder="Select a model..."
                      />
                    ) : (
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="gemini-2.0-flash"
                        value={geminiModel}
                        onChange={(e) => setGeminiModel(e.target.value)}
                      />
                    )}
                  </div>
                </>
              )}

              {settings.providerType === 'openrouter' && (
                <>
                  <div className="settings-section">
                    <h3>OpenRouter API Key</h3>
                    <p className="settings-description">
                      Enter your API key from{' '}
                      <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
                        OpenRouter
                      </a>
                    </p>
                    <div className="settings-input-group">
                      <input
                        type="password"
                        className="settings-input"
                        placeholder="sk-or-..."
                        value={openrouterApiKey}
                        onChange={(e) => setOpenrouterApiKey(e.target.value)}
                      />
                      <button
                        className="button-small button-secondary"
                        onClick={() => loadOpenRouterModels(openrouterApiKey)}
                        disabled={loadingOpenRouterModels}
                      >
                        {loadingOpenRouterModels ? 'Loading...' : 'Refresh Models'}
                      </button>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Model</h3>
                    <p className="settings-description">
                      Select a model from OpenRouter's catalog. Enter your API key and click "Refresh Models" to load available models.
                    </p>
                    {openrouterModels.length > 0 ? (
                      <SearchableSelect
                        options={openrouterModels.map(model => ({
                          value: model.id,
                          label: model.name,
                          description: `${Math.round(model.context_length / 1000)}k context`,
                        }))}
                        value={openrouterModel}
                        onChange={setOpenrouterModel}
                        placeholder="Select a model..."
                      />
                    ) : (
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="anthropic/claude-3.5-sonnet"
                        value={openrouterModel}
                        onChange={(e) => setOpenrouterModel(e.target.value)}
                      />
                    )}
                    <p className="settings-hint">
                      OpenRouter provides access to many models from different providers (Claude, GPT-4, Llama, etc.) through a unified API.
                    </p>
                  </div>
                </>
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

                  <div className="settings-section">
                    <h3>Model</h3>
                    <p className="settings-description">
                      Select a Claude model from AWS Bedrock.{' '}
                      <button
                        className="button-small button-secondary"
                        onClick={loadBedrockModels}
                        disabled={loadingBedrockModels}
                        style={{ marginLeft: '8px' }}
                      >
                        {loadingBedrockModels ? 'Loading...' : 'Refresh Models'}
                      </button>
                    </p>
                    {bedrockModels.length > 0 ? (
                      <SearchableSelect
                        options={bedrockModels.map(model => ({
                          value: model.id,
                          label: model.name,
                          description: model.description,
                        }))}
                        value={bedrockModel}
                        onChange={setBedrockModel}
                        placeholder="Select a model..."
                      />
                    ) : (
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
                      <SearchableSelect
                        options={ollamaModels.map(model => ({
                          value: model.name,
                          label: model.name,
                          description: formatBytes(model.size),
                        }))}
                        value={ollamaModel}
                        onChange={setOllamaModel}
                        placeholder="Select a model..."
                      />
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

              <div className="settings-actions">
                <button
                  className="button-secondary"
                  onClick={handleTestConnection}
                  disabled={loading || testing}
                >
                  {testing ? 'Testing...' : 'Test Connection'}
                </button>
                <button
                  className="button-primary"
                  onClick={handleSave}
                  disabled={loading || saving}
                >
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
