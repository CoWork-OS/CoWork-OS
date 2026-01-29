import { useState, useEffect, useRef } from 'react';
import { LLMSettingsData, ThemeMode, AccentColor } from '../../shared/types';
import { TelegramSettings } from './TelegramSettings';
import { DiscordSettings } from './DiscordSettings';
import { SlackSettings } from './SlackSettings';
import { SearchSettings } from './SearchSettings';
import { UpdateSettings } from './UpdateSettings';
import { GuardrailSettings } from './GuardrailSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { QueueSettings } from './QueueSettings';
import { SkillsSettings } from './SkillsSettings';
import { MCPSettings } from './MCPSettings';
import { BuiltinToolsSettings } from './BuiltinToolsSettings';

type SettingsTab = 'appearance' | 'llm' | 'search' | 'telegram' | 'discord' | 'slack' | 'updates' | 'guardrails' | 'queue' | 'skills' | 'mcp' | 'tools';

interface SettingsProps {
  onBack: () => void;
  onSettingsChanged?: () => void;
  themeMode: ThemeMode;
  accentColor: AccentColor;
  onThemeChange: (theme: ThemeMode) => void;
  onAccentChange: (accent: AccentColor) => void;
  initialTab?: SettingsTab;
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

export function Settings({ onBack, onSettingsChanged, themeMode, accentColor, onThemeChange, onAccentChange, initialTab = 'appearance' }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
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

  // OpenAI state
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o-mini');
  const [openaiModels, setOpenaiModels] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [loadingOpenAIModels, setLoadingOpenAIModels] = useState(false);
  const [openaiAuthMethod, setOpenaiAuthMethod] = useState<'api_key' | 'oauth'>('api_key');
  const [openaiOAuthConnected, setOpenaiOAuthConnected] = useState(false);
  const [openaiOAuthLoading, setOpenaiOAuthLoading] = useState(false);

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

      // Set OpenAI form state
      if (loadedSettings.openai?.apiKey) {
        setOpenaiApiKey(loadedSettings.openai.apiKey);
      }
      if (loadedSettings.openai?.model) {
        setOpenaiModel(loadedSettings.openai.model);
      }
      // Set OpenAI auth method and OAuth status
      if (loadedSettings.openai?.authMethod) {
        setOpenaiAuthMethod(loadedSettings.openai.authMethod);
        // If authMethod is 'oauth', check if tokens are available
        if (loadedSettings.openai.authMethod === 'oauth') {
          if (loadedSettings.openai.accessToken || loadedSettings.openai.refreshToken) {
            // Tokens available - fully connected
            setOpenaiOAuthConnected(true);
          } else {
            // Auth method is OAuth but tokens missing (decryption failed or expired)
            // Keep authMethod as oauth so user knows they configured it, but not connected
            setOpenaiOAuthConnected(false);
            console.log('[Settings] OpenAI OAuth configured but tokens unavailable - re-authentication required');
          }
        }
      } else if (loadedSettings.openai?.accessToken) {
        // Legacy: accessToken present but no authMethod set
        setOpenaiOAuthConnected(true);
        setOpenaiAuthMethod('oauth');
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
      if (loadedSettings.cachedOpenAIModels && loadedSettings.cachedOpenAIModels.length > 0) {
        setOpenaiModels(loadedSettings.cachedOpenAIModels.map((m: any) => ({
          id: m.key,
          name: m.displayName,
          description: m.description || '',
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
      console.log(`[Settings] Loaded ${models?.length || 0} Ollama models`, models);
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

  const loadOpenAIModels = async (apiKey?: string) => {
    try {
      setLoadingOpenAIModels(true);
      const models = await window.electronAPI.getOpenAIModels(apiKey || openaiApiKey);
      setOpenaiModels(models || []);
      // If we got models and current model isn't in the list, select the first one
      if (models && models.length > 0 && !models.some(m => m.id === openaiModel)) {
        setOpenaiModel(models[0].id);
      }
      // Notify main page that models were refreshed (they're now cached)
      onSettingsChanged?.();
    } catch (error) {
      console.error('Failed to load OpenAI models:', error);
      setOpenaiModels([]);
    } finally {
      setLoadingOpenAIModels(false);
    }
  };

  const handleOpenAIOAuthLogin = async () => {
    try {
      setOpenaiOAuthLoading(true);
      setTestResult(null);
      const result = await window.electronAPI.openaiOAuthStart();
      if (result.success) {
        setOpenaiOAuthConnected(true);
        setOpenaiAuthMethod('oauth');
        setOpenaiApiKey(''); // Clear API key when using OAuth
        onSettingsChanged?.();
        // Load models after OAuth success
        loadOpenAIModels();
      } else {
        setTestResult({ success: false, error: result.error || 'OAuth failed' });
      }
    } catch (error: any) {
      console.error('OpenAI OAuth error:', error);
      setTestResult({ success: false, error: error.message || 'OAuth failed' });
    } finally {
      setOpenaiOAuthLoading(false);
    }
  };

  const handleOpenAIOAuthLogout = async () => {
    try {
      setOpenaiOAuthLoading(true);
      await window.electronAPI.openaiOAuthLogout();
      setOpenaiOAuthConnected(false);
      setOpenaiAuthMethod('api_key');
      onSettingsChanged?.();
    } catch (error: any) {
      console.error('OpenAI OAuth logout error:', error);
    } finally {
      setOpenaiOAuthLoading(false);
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
        // Always include openai settings
        openai: {
          apiKey: openaiAuthMethod === 'api_key' ? (openaiApiKey || undefined) : undefined,
          model: openaiModel || undefined,
          authMethod: openaiAuthMethod,
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
        openai: settings.providerType === 'openai' ? {
          apiKey: openaiAuthMethod === 'api_key' ? (openaiApiKey || undefined) : undefined,
          model: openaiModel || undefined,
          authMethod: openaiAuthMethod,
          // OAuth tokens are handled by the backend from stored settings
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
            className={`settings-nav-item ${activeTab === 'slack' ? 'active' : ''}`}
            onClick={() => setActiveTab('slack')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" />
              <path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
              <path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z" />
              <path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z" />
              <path d="M14 14.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z" />
              <path d="M15.5 19H14v1.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5z" />
              <path d="M10 9.5C10 8.67 9.33 8 8.5 8h-5C2.67 8 2 8.67 2 9.5S2.67 11 3.5 11h5c.83 0 1.5-.67 1.5-1.5z" />
              <path d="M8.5 5H10V3.5C10 2.67 9.33 2 8.5 2S7 2.67 7 3.5 7.67 5 8.5 5z" />
            </svg>
            Slack
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
          <button
            className={`settings-nav-item ${activeTab === 'queue' ? 'active' : ''}`}
            onClick={() => setActiveTab('queue')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="4" rx="1" />
              <rect x="3" y="10" width="18" height="4" rx="1" />
              <rect x="3" y="16" width="18" height="4" rx="1" />
            </svg>
            Task Queue
          </button>
          <button
            className={`settings-nav-item ${activeTab === 'skills' ? 'active' : ''}`}
            onClick={() => setActiveTab('skills')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            Custom Skills
          </button>
          <button
            className={`settings-nav-item ${activeTab === 'mcp' ? 'active' : ''}`}
            onClick={() => setActiveTab('mcp')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8" />
              <path d="M12 17v4" />
              <path d="M7 8h2M15 8h2" />
              <path d="M9 12h6" />
            </svg>
            MCP Servers
          </button>
          <button
            className={`settings-nav-item ${activeTab === 'tools' ? 'active' : ''}`}
            onClick={() => setActiveTab('tools')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            Built-in Tools
          </button>
          {/* NOTE: Updates tab should ALWAYS stay at the bottom as the last tab */}
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
          ) : activeTab === 'slack' ? (
            <SlackSettings />
          ) : activeTab === 'search' ? (
            <SearchSettings />
          ) : activeTab === 'updates' ? (
            <UpdateSettings />
          ) : activeTab === 'guardrails' ? (
            <GuardrailSettings />
          ) : activeTab === 'queue' ? (
            <QueueSettings />
          ) : activeTab === 'skills' ? (
            <SkillsSettings />
          ) : activeTab === 'mcp' ? (
            <MCPSettings />
          ) : activeTab === 'tools' ? (
            <BuiltinToolsSettings />
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
                    const isOpenAI = provider.type === 'openai';

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
                            setSettings({ ...settings, providerType: provider.type as 'anthropic' | 'bedrock' | 'ollama' | 'gemini' | 'openrouter' | 'openai' });
                            // Load models when selecting provider
                            if (provider.type === 'ollama') {
                              loadOllamaModels();
                            } else if (provider.type === 'gemini') {
                              loadGeminiModels();
                            } else if (provider.type === 'openrouter') {
                              loadOpenRouterModels();
                            } else if (provider.type === 'openai') {
                              loadOpenAIModels();
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
                            {isOpenAI && provider.configured && openaiOAuthConnected && (
                              <>Connected via ChatGPT account</>
                            )}
                            {isOpenAI && provider.configured && !openaiOAuthConnected && (
                              <>API key configured</>
                            )}
                            {isOpenAI && !provider.configured && (
                              <>Sign in with ChatGPT or enter API key</>
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

              {settings.providerType === 'openai' && (
                <>
                  <div className="settings-section">
                    <h3>Authentication Method</h3>
                    <p className="settings-description">
                      Choose how to authenticate with OpenAI
                    </p>
                    <div className="auth-method-tabs">
                      <button
                        className={`auth-method-tab ${openaiAuthMethod === 'oauth' ? 'active' : ''}`}
                        onClick={() => setOpenaiAuthMethod('oauth')}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                        Sign in with ChatGPT
                      </button>
                      <button
                        className={`auth-method-tab ${openaiAuthMethod === 'api_key' ? 'active' : ''}`}
                        onClick={() => setOpenaiAuthMethod('api_key')}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                        </svg>
                        API Key
                      </button>
                    </div>
                  </div>

                  {openaiAuthMethod === 'oauth' && (
                    <div className="settings-section">
                      <h3>ChatGPT Account</h3>
                      {openaiOAuthConnected ? (
                        <div className="oauth-connected">
                          <div className="oauth-status">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                              <path d="M22 4L12 14.01l-3-3" />
                            </svg>
                            <span>Connected to ChatGPT</span>
                          </div>
                          <p className="settings-description">
                            Your ChatGPT account is connected. You can use GPT-4o and other models with your subscription.
                          </p>
                          <button
                            className="button-small button-secondary"
                            onClick={handleOpenAIOAuthLogout}
                            disabled={openaiOAuthLoading}
                          >
                            {openaiOAuthLoading ? 'Disconnecting...' : 'Disconnect Account'}
                          </button>
                        </div>
                      ) : (
                        <div className="oauth-login">
                          <p className="settings-description">
                            Sign in with your ChatGPT account to use GPT-4o, o1, and other models with your subscription.
                          </p>
                          <button
                            className="button-primary oauth-login-btn"
                            onClick={handleOpenAIOAuthLogin}
                            disabled={openaiOAuthLoading}
                          >
                            {openaiOAuthLoading ? (
                              <>
                                <svg className="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M21 12a9 9 0 11-6.219-8.56" />
                                </svg>
                                Connecting...
                              </>
                            ) : (
                              <>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                                  <polyline points="10 17 15 12 10 7" />
                                  <line x1="15" y1="12" x2="3" y2="12" />
                                </svg>
                                Sign in with ChatGPT
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {openaiAuthMethod === 'api_key' && (
                    <div className="settings-section">
                      <h3>OpenAI API Key</h3>
                      <p className="settings-description">
                        Enter your API key from{' '}
                        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
                          OpenAI Platform
                        </a>
                      </p>
                      <div className="settings-input-group">
                        <input
                          type="password"
                          className="settings-input"
                          placeholder="sk-..."
                          value={openaiApiKey}
                          onChange={(e) => setOpenaiApiKey(e.target.value)}
                        />
                        <button
                          className="button-small button-secondary"
                          onClick={() => loadOpenAIModels(openaiApiKey)}
                          disabled={loadingOpenAIModels}
                        >
                          {loadingOpenAIModels ? 'Loading...' : 'Refresh Models'}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="settings-section">
                    <h3>Model</h3>
                    <p className="settings-description">
                      {openaiAuthMethod === 'oauth' && openaiOAuthConnected
                        ? 'Select a GPT model to use with your ChatGPT subscription.'
                        : 'Select a GPT model. Enter your API key and click "Refresh Models" to load available models.'}
                    </p>
                    {openaiModels.length > 0 ? (
                      <SearchableSelect
                        options={openaiModels.map(model => ({
                          value: model.id,
                          label: model.name,
                          description: model.description,
                        }))}
                        value={openaiModel}
                        onChange={setOpenaiModel}
                        placeholder="Select a model..."
                      />
                    ) : (
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="gpt-4o-mini"
                        value={openaiModel}
                        onChange={(e) => setOpenaiModel(e.target.value)}
                      />
                    )}
                    {openaiAuthMethod === 'oauth' && openaiOAuthConnected && (
                      <button
                        className="button-small button-secondary"
                        onClick={() => loadOpenAIModels()}
                        disabled={loadingOpenAIModels}
                        style={{ marginTop: '8px' }}
                      >
                        {loadingOpenAIModels ? 'Loading...' : 'Refresh Models'}
                      </button>
                    )}
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
