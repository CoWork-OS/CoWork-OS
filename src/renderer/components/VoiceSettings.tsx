import { useState, useEffect, useRef, useCallback } from "react";
import {
  VoiceSettings as VoiceSettingsType,
  VoiceProvider,
  VoiceInputMode,
  VoiceResponseMode,
  VoiceState,
  ElevenLabsVoice,
  OPENAI_VOICES,
  VOICE_LANGUAGES,
  DEFAULT_VOICE_SETTINGS,
} from "../../shared/types";

// Audio playback helper for renderer process
async function playAudioData(audioData: number[], volume: number): Promise<void> {
  const audioContext = new AudioContext();
  const arrayBuffer = new Uint8Array(audioData).buffer;

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const gainNode = audioContext.createGain();
    gainNode.gain.value = volume / 100;
    gainNode.connect(audioContext.destination);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gainNode);

    return new Promise((resolve) => {
      source.onended = () => {
        audioContext.close();
        resolve();
      };
      source.start(0);
    });
  } catch (error) {
    audioContext.close();
    throw error;
  }
}

interface VoiceSettingsProps {
  onStateChange?: (state: VoiceState) => void;
}

export function VoiceSettings({ onStateChange }: VoiceSettingsProps) {
  const [settings, setSettings] = useState<VoiceSettingsType>(DEFAULT_VOICE_SETTINGS);
  const [voiceState, setVoiceState] = useState<VoiceState>({
    isActive: false,
    isListening: false,
    isSpeaking: false,
    isProcessing: false,
    audioLevel: 0,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [elevenLabsVoices, setElevenLabsVoices] = useState<ElevenLabsVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  // Test connection states
  const [testingElevenLabs, setTestingElevenLabs] = useState(false);
  const [elevenLabsTestResult, setElevenLabsTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testingOpenAI, setTestingOpenAI] = useState(false);
  const [openAITestResult, setOpenAITestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testingAzure, setTestingAzure] = useState(false);
  const [azureTestResult, setAzureTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Test speech state
  const [testingSpeech, setTestingSpeech] = useState(false);

  // Debounce ref for text input saves to prevent race conditions
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingSettingsRef = useRef<Partial<VoiceSettingsType>>({});

  useEffect(() => {
    loadSettings();

    // Subscribe to voice events
    const unsubscribe = window.electronAPI.onVoiceEvent((event) => {
      if (event.type === "voice:state-changed") {
        const newState = event.data as VoiceState;
        setVoiceState(newState);
        onStateChange?.(newState);
      }
    });

    return () => {
      unsubscribe();
      // Clean up pending save on unmount
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [onStateChange]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const loaded = await window.electronAPI.getVoiceSettings();
      setSettings(loaded);

      // Load ElevenLabs voices if API key is configured
      if (loaded.elevenLabsApiKey) {
        await loadElevenLabsVoices();
      }
    } catch (error) {
      console.error("Failed to load voice settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadElevenLabsVoices = async () => {
    try {
      setLoadingVoices(true);
      const voices = await window.electronAPI.getElevenLabsVoices();
      setElevenLabsVoices(voices);
    } catch (error) {
      console.error("Failed to load ElevenLabs voices:", error);
    } finally {
      setLoadingVoices(false);
    }
  };

  const saveSettings = async (newSettings: Partial<VoiceSettingsType>) => {
    try {
      setSaving(true);
      const updated = await window.electronAPI.saveVoiceSettings(newSettings);
      setSettings(updated);
    } catch (error) {
      console.error("Failed to save voice settings:", error);
    } finally {
      setSaving(false);
    }
  };

  // Debounced save for text inputs - prevents race conditions when typing
  const debouncedSave = useCallback((newSettings: Partial<VoiceSettingsType>) => {
    // Merge with any pending settings
    pendingSettingsRef.current = { ...pendingSettingsRef.current, ...newSettings };

    // Update local state immediately for responsive UI
    setSettings((prev) => ({ ...prev, ...newSettings }));

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Schedule save after user stops typing
    saveTimeoutRef.current = setTimeout(async () => {
      const toSave = pendingSettingsRef.current;
      pendingSettingsRef.current = {};

      try {
        setSaving(true);
        const updated = await window.electronAPI.saveVoiceSettings(toSave);
        setSettings(updated);
      } catch (error) {
        console.error("Failed to save voice settings:", error);
      } finally {
        setSaving(false);
      }
    }, 500); // Wait 500ms after last keystroke before saving
  }, []);

  const handleToggleEnabled = async () => {
    await saveSettings({ enabled: !settings.enabled });
  };

  const handleTTSProviderChange = async (provider: VoiceProvider) => {
    // When switching to Azure, also switch STT to Azure for consistency
    // When switching away from Azure, switch STT to OpenAI (most common)
    if (provider === "azure" && settings.sttProvider !== "azure") {
      await saveSettings({ ttsProvider: provider, sttProvider: "azure" });
    } else if (provider !== "azure" && settings.sttProvider === "azure") {
      await saveSettings({ ttsProvider: provider, sttProvider: "openai" });
    } else {
      await saveSettings({ ttsProvider: provider });
    }
  };

  const handleSTTProviderChange = async (provider: VoiceProvider) => {
    await saveSettings({ sttProvider: provider });
  };

  // Text input handlers use debounced save to prevent race conditions
  const handleElevenLabsApiKeyChange = (apiKey: string) => {
    debouncedSave({ elevenLabsApiKey: apiKey });
    // Load voices after debounce completes
    if (apiKey) {
      // Delay voice loading to match save timing
      setTimeout(() => loadElevenLabsVoices(), 600);
    } else {
      setElevenLabsVoices([]);
    }
  };

  const handleElevenLabsAgentsApiKeyChange = (apiKey: string) => {
    debouncedSave({ elevenLabsAgentsApiKey: apiKey });
  };

  const handleElevenLabsAgentIdChange = (agentId: string) => {
    debouncedSave({ elevenLabsAgentId: agentId });
  };

  const handleElevenLabsAgentPhoneNumberIdChange = (phoneNumberId: string) => {
    debouncedSave({ elevenLabsAgentPhoneNumberId: phoneNumberId });
  };

  const handleOpenAIApiKeyChange = (apiKey: string) => {
    debouncedSave({ openaiApiKey: apiKey });
  };

  const handleAzureEndpointChange = (endpoint: string) => {
    debouncedSave({ azureEndpoint: endpoint });
  };

  const handleAzureApiKeyChange = (apiKey: string) => {
    debouncedSave({ azureApiKey: apiKey });
  };

  const handleAzureTtsDeploymentChange = (deploymentName: string) => {
    debouncedSave({ azureTtsDeploymentName: deploymentName });
  };

  const handleAzureSttDeploymentChange = (deploymentName: string) => {
    debouncedSave({ azureSttDeploymentName: deploymentName });
  };

  const handleAzureVoiceChange = async (voice: string) => {
    await saveSettings({
      azureVoice: voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
    });
  };

  const handleVoiceChange = async (voiceId: string) => {
    if (settings.ttsProvider === "elevenlabs") {
      await saveSettings({ elevenLabsVoiceId: voiceId });
    } else if (settings.ttsProvider === "openai") {
      await saveSettings({
        openaiVoice: voiceId as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
      });
    }
  };

  const handleInputModeChange = async (mode: VoiceInputMode) => {
    await saveSettings({ inputMode: mode });
  };

  const handleResponseModeChange = async (mode: VoiceResponseMode) => {
    await saveSettings({ responseMode: mode });
  };

  const handleVolumeChange = async (volume: number) => {
    await saveSettings({ volume });
  };

  const handleSpeechRateChange = async (rate: number) => {
    await saveSettings({ speechRate: rate });
  };

  const handleLanguageChange = async (language: string) => {
    await saveSettings({ language });
  };

  const handleTestElevenLabs = async () => {
    setTestingElevenLabs(true);
    setElevenLabsTestResult(null);
    try {
      const result = await window.electronAPI.testElevenLabsConnection();
      setElevenLabsTestResult({
        success: result.success,
        message: result.success
          ? `Connected! Found ${result.voiceCount} voices.`
          : result.error || "Connection failed",
      });
    } catch (error: Any) {
      setElevenLabsTestResult({
        success: false,
        message: error.message || "Connection failed",
      });
    } finally {
      setTestingElevenLabs(false);
    }
  };

  const handleTestOpenAI = async () => {
    setTestingOpenAI(true);
    setOpenAITestResult(null);
    try {
      const result = await window.electronAPI.testOpenAIVoiceConnection();
      setOpenAITestResult({
        success: result.success,
        message: result.success ? "Connected!" : result.error || "Connection failed",
      });
    } catch (error: Any) {
      setOpenAITestResult({
        success: false,
        message: error.message || "Connection failed",
      });
    } finally {
      setTestingOpenAI(false);
    }
  };

  const handleTestAzure = async () => {
    setTestingAzure(true);
    setAzureTestResult(null);
    try {
      const result = await window.electronAPI.testAzureVoiceConnection();
      setAzureTestResult({
        success: result.success,
        message: result.success ? "Connected!" : result.error || "Connection failed",
      });
    } catch (error: Any) {
      setAzureTestResult({
        success: false,
        message: error.message || "Connection failed",
      });
    } finally {
      setTestingAzure(false);
    }
  };

  const handleTestSpeech = async () => {
    setTestingSpeech(true);
    try {
      const result = await window.electronAPI.voiceSpeak(
        "Hello! This is a test of the text to speech system.",
      );
      if (result.success && result.audioData) {
        // Play audio in renderer process
        await playAudioData(result.audioData, settings.volume);
      } else if (!result.success) {
        console.error("Test speech failed:", result.error);
      }
    } catch (error) {
      console.error("Test speech failed:", error);
    } finally {
      setTestingSpeech(false);
    }
  };

  const handleStopSpeaking = async () => {
    await window.electronAPI.voiceStopSpeaking();
    setTestingSpeech(false);
  };

  if (loading) {
    return <div className="settings-loading">Loading voice settings...</div>;
  }

  return (
    <div className="voice-settings">
      {/* Enable/Disable */}
      <div className="settings-section">
        <div className="settings-header-row">
          <div>
            <h3>Voice Mode</h3>
            <p className="settings-description">
              Enable hands-free interaction with text-to-speech and speech-to-text.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={handleToggleEnabled}
              disabled={saving}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* Status indicator */}
        {settings.enabled && (
          <div className={`voice-status ${voiceState.isActive ? "active" : "inactive"}`}>
            <span className="status-dot" />
            <span className="status-text">
              {voiceState.isSpeaking
                ? "Speaking..."
                : voiceState.isListening
                  ? "Listening..."
                  : voiceState.isProcessing
                    ? "Processing..."
                    : voiceState.isActive
                      ? "Ready"
                      : "Inactive"}
            </span>
          </div>
        )}
      </div>

      {/* TTS Provider */}
      <div className="settings-section">
        <h4>Text-to-Speech Provider</h4>
        <p className="settings-description">Choose the voice synthesis provider.</p>
        <div className="llm-provider-tabs">
          <button
            className={`llm-provider-tab ${settings.ttsProvider === "elevenlabs" ? "active" : ""}`}
            onClick={() => handleTTSProviderChange("elevenlabs")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">ElevenLabs</span>
            {settings.elevenLabsApiKey && <span className="llm-provider-tab-status" />}
          </button>
          <button
            className={`llm-provider-tab ${settings.ttsProvider === "openai" ? "active" : ""}`}
            onClick={() => handleTTSProviderChange("openai")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">OpenAI</span>
            {settings.openaiApiKey && <span className="llm-provider-tab-status" />}
          </button>
          <button
            className={`llm-provider-tab ${settings.ttsProvider === "azure" ? "active" : ""}`}
            onClick={() => handleTTSProviderChange("azure")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">Azure OpenAI</span>
            {settings.azureApiKey && settings.azureEndpoint && (
              <span className="llm-provider-tab-status" />
            )}
          </button>
          <button
            className={`llm-provider-tab ${settings.ttsProvider === "local" ? "active" : ""}`}
            onClick={() => handleTTSProviderChange("local")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">System</span>
            <span className="llm-provider-tab-status" />
          </button>
        </div>
      </div>

      {/* ElevenLabs Configuration */}
      {settings.ttsProvider === "elevenlabs" && (
        <div className="settings-section">
          <h4>ElevenLabs Configuration</h4>

          <div className="settings-field">
            <label>API Key</label>
            <div className="input-with-button">
              <input
                type="password"
                className="settings-input"
                placeholder="Enter your ElevenLabs API key"
                value={settings.elevenLabsApiKey || ""}
                onChange={(e) => handleElevenLabsApiKeyChange(e.target.value)}
              />
              <button
                className="button-secondary"
                onClick={handleTestElevenLabs}
                disabled={testingElevenLabs || !settings.elevenLabsApiKey}
              >
                {testingElevenLabs ? "Testing..." : "Test"}
              </button>
            </div>
            <p className="settings-hint">
              Get your API key from{" "}
              <a
                href="https://elevenlabs.io/app/settings/api-keys"
                target="_blank"
                rel="noopener noreferrer"
              >
                ElevenLabs Dashboard
              </a>
            </p>
            {elevenLabsTestResult && (
              <div className={`test-result ${elevenLabsTestResult.success ? "success" : "error"}`}>
                {elevenLabsTestResult.message}
              </div>
            )}
          </div>

          <div className="settings-field">
            <label>Voice</label>
            <select
              className="settings-select"
              value={settings.elevenLabsVoiceId || ""}
              onChange={(e) => handleVoiceChange(e.target.value)}
              disabled={loadingVoices || elevenLabsVoices.length === 0}
            >
              <option value="">
                {loadingVoices
                  ? "Loading voices..."
                  : elevenLabsVoices.length === 0
                    ? "Enter API key to load voices"
                    : "Select a voice"}
              </option>
              {elevenLabsVoices.map((voice) => (
                <option key={voice.voice_id} value={voice.voice_id}>
                  {voice.name}
                  {voice.category && ` (${voice.category})`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Phone Calls Configuration (ElevenLabs Agents) */}
      <div className="settings-section">
        <h4>Phone Calls (ElevenLabs Agents)</h4>
        <p className="settings-description">
          Configure outbound phone calls initiated by the agent. Calls require an ElevenLabs agent
          and an outbound phone number configured in your ElevenLabs account.
        </p>

        <div className="settings-field">
          <label>Agents API Key</label>
          <input
            type="password"
            className="settings-input"
            placeholder="Enter your ElevenLabs Agents API key"
            value={settings.elevenLabsAgentsApiKey || ""}
            onChange={(e) => handleElevenLabsAgentsApiKeyChange(e.target.value)}
          />
          <p className="settings-hint">
            Recommended: create an API key scoped to <code>agents-write</code> with a reasonable
            spend limit. If left blank, the app will fall back to the ElevenLabs API key from the
            TTS configuration (if set).
          </p>
          <p className="settings-hint">
            Get your API key from{" "}
            <a
              href="https://elevenlabs.io/app/settings/api-keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              ElevenLabs Dashboard
            </a>
          </p>
        </div>

        <div className="settings-field">
          <label>Agent ID</label>
          <input
            type="text"
            className="settings-input"
            placeholder="e.g., 7f3d6c2e-...."
            value={settings.elevenLabsAgentId || ""}
            onChange={(e) => handleElevenLabsAgentIdChange(e.target.value)}
          />
          <p className="settings-hint">
            Used as the default agent for outbound calls. You can also pass an agent ID per call.
          </p>
        </div>

        <div className="settings-field">
          <label>Outbound Phone Number ID</label>
          <input
            type="text"
            className="settings-input"
            placeholder="e.g., 2a1b3c4d-...."
            value={settings.elevenLabsAgentPhoneNumberId || ""}
            onChange={(e) => handleElevenLabsAgentPhoneNumberIdChange(e.target.value)}
          />
          <p className="settings-hint">
            The outbound phone number ID associated with your agent. Phone numbers should be
            configured in ElevenLabs.
          </p>
        </div>
      </div>

      {/* OpenAI Configuration - show when TTS or STT uses OpenAI */}
      {(settings.ttsProvider === "openai" || settings.sttProvider === "openai") && (
        <div className="settings-section">
          <h4>OpenAI Configuration</h4>

          <div className="settings-field">
            <label>API Key</label>
            <div className="input-with-button">
              <input
                type="password"
                className="settings-input"
                placeholder="Enter your OpenAI API key"
                value={settings.openaiApiKey || ""}
                onChange={(e) => handleOpenAIApiKeyChange(e.target.value)}
              />
              <button
                className="button-secondary"
                onClick={handleTestOpenAI}
                disabled={testingOpenAI}
              >
                {testingOpenAI ? "Testing..." : "Test"}
              </button>
            </div>
            <p className="settings-hint">
              Required for{" "}
              {settings.ttsProvider === "openai" && settings.sttProvider === "openai"
                ? "TTS and STT"
                : settings.ttsProvider === "openai"
                  ? "TTS"
                  : "STT (Whisper)"}
              .
            </p>
            {openAITestResult && (
              <div className={`test-result ${openAITestResult.success ? "success" : "error"}`}>
                {openAITestResult.message}
              </div>
            )}
          </div>

          {/* Voice selection only when using OpenAI for TTS */}
          {settings.ttsProvider === "openai" && (
            <div className="settings-field">
              <label>Voice</label>
              <div className="voice-grid">
                {OPENAI_VOICES.map((voice) => (
                  <button
                    key={voice.id}
                    className={`voice-option ${settings.openaiVoice === voice.id ? "selected" : ""}`}
                    onClick={() => handleVoiceChange(voice.id)}
                    title={voice.description}
                  >
                    <span className="voice-name">{voice.name}</span>
                    <span className="voice-description">{voice.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Azure OpenAI Configuration - show when TTS or STT uses Azure */}
      {(settings.ttsProvider === "azure" || settings.sttProvider === "azure") && (
        <div className="settings-section">
          <h4>Azure OpenAI Configuration</h4>

          <div className="settings-field">
            <label>Endpoint URL</label>
            <input
              type="text"
              className="settings-input"
              placeholder="https://your-resource.openai.azure.com"
              value={settings.azureEndpoint || ""}
              onChange={(e) => handleAzureEndpointChange(e.target.value)}
            />
            <p className="settings-hint">
              Your Azure OpenAI resource endpoint (e.g., https://your-resource.openai.azure.com)
            </p>
          </div>

          <div className="settings-field">
            <label>API Key</label>
            <div className="input-with-button">
              <input
                type="password"
                className="settings-input"
                placeholder="Enter your Azure OpenAI API key"
                value={settings.azureApiKey || ""}
                onChange={(e) => handleAzureApiKeyChange(e.target.value)}
              />
              <button
                className="button-secondary"
                onClick={handleTestAzure}
                disabled={testingAzure || !settings.azureApiKey || !settings.azureEndpoint}
              >
                {testingAzure ? "Testing..." : "Test"}
              </button>
            </div>
            <p className="settings-hint">
              Get your API key from the{" "}
              <a href="https://portal.azure.com" target="_blank" rel="noopener noreferrer">
                Azure Portal
              </a>{" "}
              under your OpenAI resource → Keys and Endpoint.
            </p>
            {azureTestResult && (
              <div className={`test-result ${azureTestResult.success ? "success" : "error"}`}>
                {azureTestResult.message}
              </div>
            )}
          </div>

          {/* TTS Deployment Name - only show when using Azure for TTS */}
          {settings.ttsProvider === "azure" && (
            <div className="settings-field">
              <label>TTS Deployment Name</label>
              <input
                type="text"
                className="settings-input"
                placeholder="e.g., tts-1"
                value={settings.azureTtsDeploymentName || ""}
                onChange={(e) => handleAzureTtsDeploymentChange(e.target.value)}
              />
              <p className="settings-hint">
                The deployment name for your TTS model in Azure OpenAI.
              </p>
            </div>
          )}

          {/* STT Deployment Name - only show when using Azure for STT */}
          {settings.sttProvider === "azure" && (
            <div className="settings-field">
              <label>STT (Whisper) Deployment Name</label>
              <input
                type="text"
                className="settings-input"
                placeholder="e.g., whisper-1"
                value={settings.azureSttDeploymentName || ""}
                onChange={(e) => handleAzureSttDeploymentChange(e.target.value)}
              />
              <p className="settings-hint">
                The deployment name for your Whisper model in Azure OpenAI.
              </p>
            </div>
          )}

          {/* Voice selection - only when using Azure for TTS */}
          {settings.ttsProvider === "azure" && (
            <div className="settings-field">
              <label>Voice</label>
              <div className="voice-grid">
                {OPENAI_VOICES.map((voice) => (
                  <button
                    key={voice.id}
                    className={`voice-option ${settings.azureVoice === voice.id ? "selected" : ""}`}
                    onClick={() => handleAzureVoiceChange(voice.id)}
                    title={voice.description}
                  >
                    <span className="voice-name">{voice.name}</span>
                    <span className="voice-description">{voice.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Speech-to-Text Provider */}
      <div className="settings-section">
        <h4>Speech-to-Text Provider</h4>
        <p className="settings-description">Choose the speech recognition provider.</p>
        <div className="llm-provider-tabs">
          <button
            className={`llm-provider-tab ${settings.sttProvider === "openai" ? "active" : ""}`}
            onClick={() => handleSTTProviderChange("openai")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">OpenAI Whisper</span>
            {settings.openaiApiKey && <span className="llm-provider-tab-status" />}
          </button>
          <button
            className={`llm-provider-tab ${settings.sttProvider === "azure" ? "active" : ""}`}
            onClick={() => handleSTTProviderChange("azure")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">Azure Whisper</span>
            {settings.azureApiKey && settings.azureEndpoint && (
              <span className="llm-provider-tab-status" />
            )}
          </button>
          <button
            className={`llm-provider-tab ${settings.sttProvider === "local" ? "active" : ""}`}
            onClick={() => handleSTTProviderChange("local")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">System</span>
            <span className="llm-provider-tab-status" />
          </button>
        </div>
      </div>

      {/* Voice Input Mode */}
      <div className="settings-section">
        <h4>Voice Input Mode</h4>
        <div className="llm-provider-tabs">
          <button
            className={`llm-provider-tab ${settings.inputMode === "push_to_talk" ? "active" : ""}`}
            onClick={() => handleInputModeChange("push_to_talk")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">Push to Talk</span>
          </button>
          <button
            className={`llm-provider-tab ${settings.inputMode === "voice_activity" ? "active" : ""}`}
            onClick={() => handleInputModeChange("voice_activity")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">Voice Activity</span>
          </button>
          <button
            className={`llm-provider-tab ${settings.inputMode === "disabled" ? "active" : ""}`}
            onClick={() => handleInputModeChange("disabled")}
            disabled={saving}
          >
            <span className="llm-provider-tab-label">Disabled</span>
          </button>
        </div>
        <p className="settings-hint">
          {settings.inputMode === "push_to_talk"
            ? `Hold ${settings.pushToTalkKey} to speak`
            : settings.inputMode === "voice_activity"
              ? "Automatically detects when you speak"
              : "Voice input is disabled"}
        </p>
      </div>

      {/* Response Mode */}
      <div className="settings-section">
        <h4>Response Mode</h4>
        <p className="settings-description">When should responses be spoken aloud?</p>
        <select
          className="settings-select"
          value={settings.responseMode}
          onChange={(e) => handleResponseModeChange(e.target.value as VoiceResponseMode)}
          disabled={saving}
        >
          <option value="auto">Auto - All responses</option>
          <option value="smart">Smart - Only important responses</option>
          <option value="manual">Manual - Only when requested</option>
        </select>
      </div>

      {/* Volume and Speech Rate */}
      <div className="settings-section">
        <h4>Voice Settings</h4>

        <div className="settings-field">
          <label>Volume: {settings.volume}%</label>
          <input
            type="range"
            min="0"
            max="100"
            value={settings.volume}
            onChange={(e) => handleVolumeChange(parseInt(e.target.value))}
            className="settings-slider"
          />
        </div>

        <div className="settings-field">
          <label>Speech Rate: {settings.speechRate}x</label>
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            value={settings.speechRate}
            onChange={(e) => handleSpeechRateChange(parseFloat(e.target.value))}
            className="settings-slider"
          />
        </div>
      </div>

      {/* Language */}
      <div className="settings-section">
        <h4>Language</h4>
        <select
          className="settings-select"
          value={settings.language}
          onChange={(e) => handleLanguageChange(e.target.value)}
          disabled={saving}
        >
          {VOICE_LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>
      </div>

      {/* Test Speech */}
      <div className="settings-section">
        <h4>Test Voice</h4>
        <p className="settings-description">Test the current voice configuration.</p>
        <div className="button-group">
          <button
            className="button-primary"
            onClick={handleTestSpeech}
            disabled={testingSpeech || !settings.enabled}
          >
            {testingSpeech ? "Speaking..." : "Test Speech"}
          </button>
          {(testingSpeech || voiceState.isSpeaking) && (
            <button className="button-secondary" onClick={handleStopSpeaking}>
              Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
