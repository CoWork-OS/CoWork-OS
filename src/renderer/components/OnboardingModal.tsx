import React, { useState, useEffect } from "react";
import { ThemeMode, AccentColor, ACCENT_COLORS, LLMSettingsData } from "../../shared/types";

interface OnboardingModalProps {
  onComplete: (dontShowAgain: boolean) => void;
  themeMode: ThemeMode;
  accentColor: AccentColor;
  onThemeChange: (theme: ThemeMode) => void;
  onAccentChange: (accent: AccentColor) => void;
}

type OnboardingStep = "welcome" | "llm" | "channels";

// LLM Provider types for the simplified setup
type LLMProviderType =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "openrouter"
  | "bedrock"
  | "groq"
  | "xai"
  | "kimi";

interface ProviderOption {
  type: LLMProviderType;
  name: string;
  description: string;
  icon: React.ReactNode;
  requiresApiKey: boolean;
  apiKeyPlaceholder?: string;
  apiKeyLink?: string;
  freeOption?: boolean;
}

// Channel types for messaging connectors
type ChannelType = "telegram" | "whatsapp" | "discord" | "slack" | "imessage" | "signal";

interface ChannelOption {
  type: ChannelType;
  name: string;
  description: string;
  icon: React.ReactNode;
  requiresSetup: "easy" | "moderate" | "advanced";
  setupHint: string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    type: "anthropic",
    name: "Anthropic",
    description: "Claude models (Recommended)",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    ),
    requiresApiKey: true,
    apiKeyPlaceholder: "sk-ant-...",
    apiKeyLink: "https://console.anthropic.com/",
  },
  {
    type: "openai",
    name: "OpenAI",
    description: "GPT-5.2 and other models",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
    requiresApiKey: true,
    apiKeyPlaceholder: "sk-...",
    apiKeyLink: "https://platform.openai.com/api-keys",
  },
  {
    type: "gemini",
    name: "Google Gemini",
    description: "Gemini 2.0 and other models",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
    requiresApiKey: true,
    apiKeyPlaceholder: "AIza...",
    apiKeyLink: "https://aistudio.google.com/apikey",
  },
  {
    type: "ollama",
    name: "Ollama",
    description: "Run models locally (Free)",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M9 9h6v6H9z" />
      </svg>
    ),
    requiresApiKey: false,
    freeOption: true,
  },
  {
    type: "openrouter",
    name: "OpenRouter",
    description: "Access 200+ models",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    requiresApiKey: true,
    apiKeyPlaceholder: "sk-or-...",
    apiKeyLink: "https://openrouter.ai/keys",
  },
  {
    type: "groq",
    name: "Groq",
    description: "Fast, low-latency models",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M4 12h16" />
        <path d="M12 4v16" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    ),
    requiresApiKey: true,
    apiKeyPlaceholder: "gsk_...",
    apiKeyLink: "https://console.groq.com/keys",
  },
  {
    type: "xai",
    name: "xAI (Grok)",
    description: "Grok models from xAI",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M4 4l16 16" />
        <path d="M20 4L4 20" />
      </svg>
    ),
    requiresApiKey: true,
    apiKeyPlaceholder: "xai-...",
    apiKeyLink: "https://console.x.ai/",
  },
  {
    type: "kimi",
    name: "Kimi",
    description: "Kimi models via Moonshot",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7z" />
      </svg>
    ),
    requiresApiKey: true,
    apiKeyPlaceholder: "sk-...",
    apiKeyLink: "https://platform.moonshot.ai/",
  },
  {
    type: "bedrock",
    name: "AWS Bedrock",
    description: "Claude via AWS",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      </svg>
    ),
    requiresApiKey: false, // Uses AWS credentials
  },
];

const CHANNEL_OPTIONS: ChannelOption[] = [
  {
    type: "telegram",
    name: "Telegram",
    description: "Chat with your agent via Telegram bot",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
      </svg>
    ),
    requiresSetup: "easy",
    setupHint: "Create a bot with @BotFather",
  },
  {
    type: "whatsapp",
    name: "WhatsApp",
    description: "Connect via QR code scan",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
      </svg>
    ),
    requiresSetup: "easy",
    setupHint: "Scan QR code with your phone",
  },
  {
    type: "discord",
    name: "Discord",
    description: "Add a bot to your Discord server",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="9" cy="12" r="1" />
        <circle cx="15" cy="12" r="1" />
        <path d="M7.5 7.5c3.5-1 5.5-1 9 0M7 16.5c3.5 1 6.5 1 10 0" />
        <path d="M15.5 17c0 1 1.5 3 2 3 1.5 0 2.833-1.667 3.5-3 .667-1.333.5-5.833-1.5-11.5-1.457-1.015-3-1.34-4.5-1.5l-1 2 1 1" />
        <path d="M8.5 17c0 1-1.356 3-1.832 3-1.429 0-2.698-1.667-3.333-3-.635-1.333-.476-5.833 1.428-11.5C6.151 4.485 7.545 4.16 9 4l1 2-1 1" />
      </svg>
    ),
    requiresSetup: "moderate",
    setupHint: "Create app in Discord Developer Portal",
  },
  {
    type: "slack",
    name: "Slack",
    description: "Connect to your Slack workspace",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="13" y="2" width="3" height="8" rx="1.5" />
        <path d="M19 8.5V10h1.5A1.5 1.5 0 0019 8.5" />
        <rect x="8" y="14" width="3" height="8" rx="1.5" />
        <path d="M5 15.5V14H3.5A1.5 1.5 0 005 15.5" />
        <rect x="14" y="13" width="8" height="3" rx="1.5" />
        <path d="M15.5 19H14v1.5a1.5 1.5 0 0015.5 19" />
        <rect x="2" y="8" width="8" height="3" rx="1.5" />
        <path d="M8.5 5H10V3.5A1.5 1.5 0 008.5 5" />
      </svg>
    ),
    requiresSetup: "moderate",
    setupHint: "Create a Slack App with Socket Mode",
  },
  {
    type: "imessage",
    name: "iMessage",
    description: "Use iMessage on macOS",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
    requiresSetup: "advanced",
    setupHint: "Requires macOS permissions",
  },
  {
    type: "signal",
    name: "Signal",
    description: "Private messaging via Signal",
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    requiresSetup: "advanced",
    setupHint: "Requires signal-cli setup",
  },
];

export function OnboardingModal({
  onComplete,
  themeMode,
  accentColor,
  onThemeChange,
  onAccentChange,
}: OnboardingModalProps) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [selectedProvider, setSelectedProvider] = useState<LLMProviderType | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<Set<ChannelType>>(new Set());
  const [dontShowAgain, setDontShowAgain] = useState(true); // Default to true - most users want to complete onboarding once

  // Check if Ollama is available locally when selected
  useEffect(() => {
    if (selectedProvider === "ollama") {
      checkOllamaAvailability();
    }
  }, [selectedProvider]);

  const checkOllamaAvailability = async () => {
    try {
      const models = await window.electronAPI.getOllamaModels(ollamaUrl);
      if (models && models.length > 0) {
        setTestResult({ success: true });
      }
    } catch {
      // Ollama not running - that's fine, user can set it up later
    }
  };

  const handleProviderSelect = (provider: LLMProviderType) => {
    setSelectedProvider(provider);
    setApiKey("");
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    if (!selectedProvider) return;

    try {
      setTestResult(null);
      const testConfig: Partial<LLMSettingsData> = {
        providerType: selectedProvider,
      };

      if (selectedProvider === "anthropic") {
        testConfig.anthropic = { apiKey };
      } else if (selectedProvider === "openai") {
        testConfig.openai = { apiKey, authMethod: "api_key" };
      } else if (selectedProvider === "gemini") {
        testConfig.gemini = { apiKey };
      } else if (selectedProvider === "openrouter") {
        testConfig.openrouter = { apiKey };
      } else if (selectedProvider === "ollama") {
        testConfig.ollama = { baseUrl: ollamaUrl };
      } else if (selectedProvider === "groq") {
        testConfig.groq = { apiKey };
      } else if (selectedProvider === "xai") {
        testConfig.xai = { apiKey };
      } else if (selectedProvider === "kimi") {
        testConfig.kimi = { apiKey };
      }

      const result = await window.electronAPI.testLLMProvider(testConfig);
      setTestResult(result);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      setTestResult({ success: false, error: errorMessage });
    }
  };

  const handleSaveLLMAndContinue = async () => {
    if (selectedProvider) {
      try {
        setSaving(true);

        const settings: LLMSettingsData = {
          providerType: selectedProvider,
          modelKey: getDefaultModel(selectedProvider),
        };

        if (selectedProvider === "anthropic") {
          settings.anthropic = { apiKey };
        } else if (selectedProvider === "openai") {
          settings.openai = { apiKey, authMethod: "api_key", model: "gpt-4o-mini" };
        } else if (selectedProvider === "gemini") {
          settings.gemini = { apiKey, model: "gemini-2.0-flash" };
        } else if (selectedProvider === "openrouter") {
          settings.openrouter = { apiKey, model: "anthropic/claude-3.5-sonnet" };
        } else if (selectedProvider === "ollama") {
          settings.ollama = { baseUrl: ollamaUrl, model: "llama3.2" };
        } else if (selectedProvider === "bedrock") {
          settings.bedrock = { region: "us-east-1", useDefaultCredentials: true };
        } else if (selectedProvider === "groq") {
          settings.groq = { apiKey, model: "llama-3.1-8b-instant" };
        } else if (selectedProvider === "xai") {
          settings.xai = { apiKey, model: "grok-4-fast-non-reasoning" };
        } else if (selectedProvider === "kimi") {
          settings.kimi = { apiKey, model: "kimi-k2.5" };
        }

        await window.electronAPI.saveLLMSettings(settings);
      } catch (error) {
        console.error("Failed to save LLM settings:", error);
      } finally {
        setSaving(false);
      }
    }
    setStep("channels");
  };

  const handleChannelToggle = (channel: ChannelType) => {
    setSelectedChannels((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(channel)) {
        newSet.delete(channel);
      } else {
        newSet.add(channel);
      }
      return newSet;
    });
  };

  const handleFinish = () => {
    // Just complete onboarding - channels can be configured in Settings
    // The selected channels are just informational at this point
    onComplete(dontShowAgain);
  };

  const getDefaultModel = (provider: LLMProviderType): string => {
    switch (provider) {
      case "anthropic":
        return "sonnet-4";
      case "openai":
        return "gpt-4o-mini";
      case "gemini":
        return "gemini-2.0-flash";
      case "ollama":
        return "llama3.2";
      case "openrouter":
        return "anthropic/claude-3.5-sonnet";
      case "bedrock":
        return "sonnet-4-6";
      case "groq":
        return "llama-3.1-8b-instant";
      case "xai":
        return "grok-4-fast-non-reasoning";
      case "kimi":
        return "kimi-k2.5";
      default:
        return "sonnet-4";
    }
  };

  const canProceedLLM = () => {
    if (!selectedProvider) return true; // Can skip
    if (selectedProvider === "ollama" || selectedProvider === "bedrock") return true;
    return apiKey.length > 0;
  };

  const selectedProviderInfo = PROVIDER_OPTIONS.find((p) => p.type === selectedProvider);

  const getSetupBadgeClass = (level: "easy" | "moderate" | "advanced") => {
    switch (level) {
      case "easy":
        return "setup-easy";
      case "moderate":
        return "setup-moderate";
      case "advanced":
        return "setup-advanced";
    }
  };

  return (
    <div className="onboarding-modal">
      <div className="onboarding-container">
        {/* Progress indicator */}
        <div className="onboarding-progress">
          <div
            className={`onboarding-progress-step ${step === "welcome" ? "active" : "completed"}`}
          >
            <span className="onboarding-progress-dot" />
            <span className="onboarding-progress-label">Welcome</span>
          </div>
          <div className="onboarding-progress-line" />
          <div
            className={`onboarding-progress-step ${step === "llm" ? "active" : step === "channels" ? "completed" : ""}`}
          >
            <span className="onboarding-progress-dot" />
            <span className="onboarding-progress-label">AI Setup</span>
          </div>
          <div className="onboarding-progress-line" />
          <div className={`onboarding-progress-step ${step === "channels" ? "active" : ""}`}>
            <span className="onboarding-progress-dot" />
            <span className="onboarding-progress-label">Channels</span>
          </div>
        </div>

        {/* Step Content */}
        {step === "welcome" && (
          <div className="onboarding-step">
            <div className="onboarding-header">
              <h1>Welcome to CoWork OS</h1>
              <p>Let's personalize your experience and get you started.</p>
            </div>

            <div className="onboarding-section">
              <h3>Choose your theme</h3>
              <div className="onboarding-theme-options">
                <button
                  className={`onboarding-theme-option ${themeMode === "light" ? "selected" : ""}`}
                  onClick={() => onThemeChange("light")}
                >
                  <div className="onboarding-theme-preview light">
                    <div className="preview-line" />
                    <div className="preview-line" />
                    <div className="preview-line" />
                  </div>
                  <span>Light</span>
                </button>
                <button
                  className={`onboarding-theme-option ${themeMode === "dark" ? "selected" : ""}`}
                  onClick={() => onThemeChange("dark")}
                >
                  <div className="onboarding-theme-preview dark">
                    <div className="preview-line" />
                    <div className="preview-line" />
                    <div className="preview-line" />
                  </div>
                  <span>Dark</span>
                </button>
                <button
                  className={`onboarding-theme-option ${themeMode === "system" ? "selected" : ""}`}
                  onClick={() => onThemeChange("system")}
                >
                  <div className="onboarding-theme-preview system" />
                  <span>System</span>
                </button>
              </div>
            </div>

            <div className="onboarding-section">
              <h3>Pick an accent color</h3>
              <div className="onboarding-color-grid">
                {ACCENT_COLORS.map((color) => (
                  <button
                    key={color.id}
                    className={`onboarding-color-option ${accentColor === color.id ? "selected" : ""}`}
                    onClick={() => onAccentChange(color.id)}
                    title={color.label}
                  >
                    <div className={`onboarding-color-swatch ${color.id}`} />
                  </button>
                ))}
              </div>
            </div>

            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => setStep("llm")}>
                Continue
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {step === "llm" && (
          <div className="onboarding-step">
            <div className="onboarding-header">
              <h1>Connect an AI Provider</h1>
              <p>Choose which AI service to use for running tasks.</p>
            </div>

            <div className="onboarding-provider-grid">
              {PROVIDER_OPTIONS.map((provider) => (
                <button
                  key={provider.type}
                  className={`onboarding-provider-card ${selectedProvider === provider.type ? "selected" : ""}`}
                  onClick={() => handleProviderSelect(provider.type)}
                >
                  <div className="onboarding-provider-icon">{provider.icon}</div>
                  <div className="onboarding-provider-info">
                    <span className="onboarding-provider-name">
                      {provider.name}
                      {provider.freeOption && <span className="onboarding-free-badge">Free</span>}
                    </span>
                    <span className="onboarding-provider-desc">{provider.description}</span>
                  </div>
                  {selectedProvider === provider.type && (
                    <svg
                      className="onboarding-check"
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                      <path d="M22 4L12 14.01l-3-3" />
                    </svg>
                  )}
                </button>
              ))}
            </div>

            {/* API Key input for selected provider */}
            {selectedProvider && selectedProviderInfo?.requiresApiKey && (
              <div className="onboarding-apikey-section">
                <label>
                  {selectedProviderInfo.name} API Key
                  {selectedProviderInfo.apiKeyLink && (
                    <a
                      href={selectedProviderInfo.apiKeyLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="onboarding-link"
                    >
                      Get one here
                    </a>
                  )}
                </label>
                <div className="onboarding-apikey-row">
                  <input
                    type="password"
                    placeholder={selectedProviderInfo.apiKeyPlaceholder}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="onboarding-input"
                  />
                  <button
                    className="onboarding-btn-secondary"
                    onClick={handleTestConnection}
                    disabled={!apiKey}
                  >
                    Test
                  </button>
                </div>
                {testResult && (
                  <div
                    className={`onboarding-test-result ${testResult.success ? "success" : "error"}`}
                  >
                    {testResult.success ? (
                      <>
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                          <path d="M22 4L12 14.01l-3-3" />
                        </svg>
                        Connection successful!
                      </>
                    ) : (
                      <>
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <line x1="15" y1="9" x2="9" y2="15" />
                          <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                        {testResult.error || "Connection failed"}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Ollama-specific section */}
            {selectedProvider === "ollama" && (
              <div className="onboarding-apikey-section">
                <label>Ollama Server URL</label>
                <div className="onboarding-apikey-row">
                  <input
                    type="text"
                    placeholder="http://localhost:11434"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                    className="onboarding-input"
                  />
                  <button className="onboarding-btn-secondary" onClick={checkOllamaAvailability}>
                    Test
                  </button>
                </div>
                <p className="onboarding-hint">
                  Make sure Ollama is running. Download from{" "}
                  <a href="https://ollama.ai" target="_blank" rel="noopener noreferrer">
                    ollama.ai
                  </a>
                </p>
                {testResult && (
                  <div
                    className={`onboarding-test-result ${testResult.success ? "success" : "error"}`}
                  >
                    {testResult.success
                      ? "Ollama server detected!"
                      : "Ollama not detected. You can set it up later."}
                  </div>
                )}
              </div>
            )}

            {/* Bedrock-specific section */}
            {selectedProvider === "bedrock" && (
              <div className="onboarding-apikey-section">
                <p className="onboarding-hint">
                  AWS Bedrock uses your AWS credentials from ~/.aws/credentials or environment
                  variables. You can configure this in detail in Settings after setup.
                </p>
              </div>
            )}

            <div className="onboarding-actions">
              <button className="onboarding-btn-secondary" onClick={() => setStep("welcome")}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                Back
              </button>
              <button
                className="onboarding-btn-primary"
                onClick={handleSaveLLMAndContinue}
                disabled={saving || !canProceedLLM()}
              >
                {saving ? "Saving..." : "Continue"}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            {!selectedProvider && (
              <p className="onboarding-skip-hint">You can configure this later in Settings</p>
            )}
          </div>
        )}

        {step === "channels" && (
          <div className="onboarding-step">
            <div className="onboarding-header">
              <h1>Connect Messaging Channels</h1>
              <p>Chat with your AI agent from your favorite messaging apps.</p>
            </div>

            <div className="onboarding-channel-grid">
              {CHANNEL_OPTIONS.map((channel) => (
                <button
                  key={channel.type}
                  className={`onboarding-channel-card ${selectedChannels.has(channel.type) ? "selected" : ""}`}
                  onClick={() => handleChannelToggle(channel.type)}
                >
                  <div className="onboarding-channel-icon">{channel.icon}</div>
                  <div className="onboarding-channel-info">
                    <span className="onboarding-channel-name">
                      {channel.name}
                      <span
                        className={`onboarding-setup-badge ${getSetupBadgeClass(channel.requiresSetup)}`}
                      >
                        {channel.requiresSetup === "easy"
                          ? "Easy"
                          : channel.requiresSetup === "moderate"
                            ? "Moderate"
                            : "Advanced"}
                      </span>
                    </span>
                    <span className="onboarding-channel-desc">{channel.description}</span>
                  </div>
                  {selectedChannels.has(channel.type) && (
                    <svg
                      className="onboarding-check"
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                      <path d="M22 4L12 14.01l-3-3" />
                    </svg>
                  )}
                </button>
              ))}
            </div>

            {selectedChannels.size > 0 && (
              <div className="onboarding-channel-note">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
                <span>
                  You can configure{" "}
                  {selectedChannels.size === 1 ? "this channel" : "these channels"} in{" "}
                  <strong>Settings &gt; Channels</strong> after setup.
                </span>
              </div>
            )}

            <div className="onboarding-dont-show-again">
              <label className="onboarding-checkbox-label">
                <input
                  type="checkbox"
                  checked={dontShowAgain}
                  onChange={(e) => setDontShowAgain(e.target.checked)}
                />
                <span>Don't show this again</span>
              </label>
              <p className="onboarding-checkbox-hint">
                You can re-open onboarding anytime from Settings &gt; Appearance
              </p>
            </div>

            <div className="onboarding-actions">
              <button className="onboarding-btn-secondary" onClick={() => setStep("llm")}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                Back
              </button>
              <button className="onboarding-btn-primary" onClick={handleFinish}>
                {selectedChannels.size > 0 ? "Finish Setup" : "Skip & Finish"}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                  <path d="M22 4L12 14.01l-3-3" />
                </svg>
              </button>
            </div>

            <p className="onboarding-skip-hint">
              Channels are optional. You can always add them later in Settings.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
