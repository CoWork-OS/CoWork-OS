import { useEffect, useState, useCallback } from 'react';
import { useOnboardingFlow, SCRIPT } from '../../hooks/useOnboardingFlow';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { AwakeningOrb } from './AwakeningOrb';
import { TypewriterText } from './TypewriterText';
import type { LLMProviderType } from '../../../shared/types';

interface OnboardingProps {
  onComplete: (dontShowAgain: boolean) => void;
}

// Provider display info
const PROVIDERS: {
  id: LLMProviderType;
  name: string;
  requiresKey: boolean;
}[] = [
  { id: 'anthropic', name: 'Claude', requiresKey: true },
  { id: 'openai', name: 'OpenAI', requiresKey: true },
  { id: 'gemini', name: 'Gemini', requiresKey: true },
  { id: 'ollama', name: 'Ollama', requiresKey: false },
  { id: 'openrouter', name: 'OpenRouter', requiresKey: true },
  { id: 'groq', name: 'Groq', requiresKey: true },
  { id: 'xai', name: 'Grok', requiresKey: true },
  { id: 'kimi', name: 'Kimi', requiresKey: true },
  { id: 'bedrock', name: 'AWS Bedrock', requiresKey: false },
];

// API key URLs for providers
const PROVIDER_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  openrouter: 'https://openrouter.ai/keys',
  groq: 'https://console.groq.com/keys',
  xai: 'https://console.x.ai/',
  kimi: 'https://platform.moonshot.ai/',
};

export function Onboarding({ onComplete }: OnboardingProps) {
  const [inputValue, setInputValue] = useState('');
  const [inputMode, setInputMode] = useState<'voice' | 'keyboard'>('keyboard');

  const onboarding = useOnboardingFlow({ onComplete });

  // Voice input integration
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setInputValue((prev) => (prev ? `${prev} ${text}` : text));
    },
    onError: () => {
      // Fall back to keyboard if voice fails
      setInputMode('keyboard');
    },
    onNotConfigured: () => {
      setInputMode('keyboard');
    },
  });

  // Check if voice is available on mount
  useEffect(() => {
    if (voiceInput.isConfigured) {
      setInputMode('voice');
    }
  }, [voiceInput.isConfigured]);

  // Start the onboarding when component mounts
  useEffect(() => {
    onboarding.start();
  }, []);

  // Handle awakening animation
  useEffect(() => {
    if (onboarding.state === 'awakening') {
      const timer = setTimeout(() => {
        onboarding.onAwakeningComplete();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [onboarding.state, onboarding.onAwakeningComplete]);

  // Handle input submission
  const handleInputSubmit = useCallback(() => {
    if (!inputValue.trim() && onboarding.state === 'ask_name') {
      // Allow empty name (will use default)
      onboarding.submitName('');
      setInputValue('');
      return;
    }

    if (onboarding.state === 'ask_name') {
      onboarding.submitName(inputValue);
      setInputValue('');
    } else if (onboarding.state === 'llm_api_key') {
      onboarding.submitApiKey(inputValue);
      setInputValue('');
    }
  }, [inputValue, onboarding]);

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleInputSubmit();
    }
  };

  // Handle voice button click
  const handleVoiceClick = () => {
    if (voiceInput.state === 'recording') {
      voiceInput.stopRecording();
    } else if (voiceInput.state === 'idle') {
      voiceInput.startRecording();
    }
  };

  // Determine orb state
  const getOrbState = () => {
    if (onboarding.state === 'dormant') return 'dormant';
    if (onboarding.state === 'awakening') return 'awakening';
    if (onboarding.state === 'transitioning') return 'transitioning';
    if (voiceInput.state === 'recording') return 'listening';
    return 'breathing';
  };

  // Render work style buttons
  const renderWorkStyleButtons = () => (
    <div className="onboarding-actions">
      <button
        className="onboarding-btn onboarding-btn-secondary"
        onClick={() => onboarding.submitWorkStyle('planner')}
      >
        I plan things out
      </button>
      <button
        className="onboarding-btn onboarding-btn-secondary"
        onClick={() => onboarding.submitWorkStyle('flexible')}
      >
        I go with the flow
      </button>
    </div>
  );

  // Render persona selection buttons
  const renderPersonaButtons = () => (
    <div className="onboarding-actions">
      <button
        className="onboarding-btn onboarding-btn-primary"
        onClick={() => onboarding.submitPersona('companion')}
      >
        Warm companion
      </button>
      <button
        className="onboarding-btn onboarding-btn-secondary"
        onClick={() => onboarding.submitPersona('none')}
      >
        Neutral assistant
      </button>
    </div>
  );

  const renderVoiceOptions = () => (
    <div className="onboarding-actions">
      <button
        className="onboarding-btn onboarding-btn-primary"
        onClick={() => onboarding.submitVoicePreference(true)}
      >
        Enable voice
      </button>
      <button
        className="onboarding-btn onboarding-btn-secondary"
        onClick={() => onboarding.submitVoicePreference(false)}
      >
        Not now
      </button>
      <div
        style={{
          marginTop: 12,
          color: 'var(--onboarding-warm-white)',
          opacity: 0.7,
          fontSize: '0.9rem',
          textAlign: 'center',
        }}
      >
        You can change this later in Settings {'>'} Voice.
      </div>
    </div>
  );

  // Render style implications with countdown and change option
  const renderStyleImplications = () => {
    const implications = onboarding.data.workStyle === 'planner'
      ? SCRIPT.style_implications_planner
      : SCRIPT.style_implications_flexible;

    return (
      <div className="onboarding-style-implications">
        <div className="onboarding-implications-list">
          {implications.map((item, index) => (
            <div key={index} className="onboarding-implication-item">
              {item}
            </div>
          ))}
        </div>
        <div className="onboarding-implications-footer">
          <button
            className="onboarding-btn onboarding-btn-secondary onboarding-btn-sm"
            onClick={onboarding.changeWorkStyle}
          >
            Change
          </button>
          <span className="onboarding-countdown">
            Continuing in {onboarding.styleCountdown}s...
          </span>
        </div>
      </div>
    );
  };

  // Render provider selection
  const renderProviders = () => (
    <div className={`onboarding-setup-section ${onboarding.showProviders ? 'visible' : ''}`}>
      <div className="onboarding-provider-pills">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            className={`onboarding-provider-pill ${
              onboarding.data.selectedProvider === provider.id ? 'selected' : ''
            }`}
            onClick={() => onboarding.selectProvider(provider.id)}
          >
            {provider.name}
          </button>
        ))}
      </div>
      <div className="onboarding-actions" style={{ marginTop: 24 }}>
        <button className="onboarding-btn onboarding-btn-secondary" onClick={onboarding.skipLLMSetup}>
          Skip for now
        </button>
      </div>
    </div>
  );

  // Render API key input
  const renderApiKeyInput = () => {
    const provider = onboarding.data.selectedProvider;
    const url = provider ? PROVIDER_URLS[provider] : null;

    return (
      <div className={`onboarding-api-input-section ${onboarding.showApiInput ? 'visible' : ''}`}>
        {url && (
          <p className="onboarding-api-hint">
            Get your key from{' '}
            <a href={url} target="_blank" rel="noopener noreferrer">
              {provider === 'anthropic'
                ? 'Anthropic'
                : provider === 'openai'
                  ? 'OpenAI'
                  : provider === 'gemini'
                    ? 'Google AI Studio'
                    : provider === 'openrouter'
                      ? 'OpenRouter'
                      : provider === 'groq'
                        ? 'Groq Console'
                        : provider === 'xai'
                          ? 'xAI Console'
                          : 'Moonshot Platform'}
            </a>
          </p>
        )}
        <div className="onboarding-input-container">
          <input
            type="password"
            className="onboarding-input"
            placeholder="Paste your API key"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <div className="onboarding-actions">
            <button
              className="onboarding-btn onboarding-btn-primary"
              onClick={handleInputSubmit}
              disabled={!inputValue.trim()}
            >
              Connect
            </button>
            <button className="onboarding-btn onboarding-btn-secondary" onClick={onboarding.skipLLMSetup}>
              Skip
            </button>
          </div>
        </div>
        {onboarding.testResult && !onboarding.testResult.success && (
          <div className="onboarding-test-result error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span>{onboarding.testResult.error || 'Connection failed'}</span>
          </div>
        )}
      </div>
    );
  };

  // Render name input
  const renderNameInput = () => (
    <div className="onboarding-input-container">
      {inputMode === 'voice' && voiceInput.isConfigured ? (
        <>
          <button
            className={`onboarding-voice-btn ${
              voiceInput.state === 'recording'
                ? 'recording'
                : voiceInput.state === 'processing'
                  ? 'processing'
                  : ''
            }`}
            onClick={handleVoiceClick}
            disabled={voiceInput.state === 'processing'}
          >
            {voiceInput.state === 'processing' ? (
              <svg className="onboarding-spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" />
              </svg>
            ) : voiceInput.state === 'recording' ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            )}
          </button>
          {inputValue && (
            <div style={{ marginTop: 16, color: 'var(--onboarding-warm-white)', fontSize: '1rem' }}>
              "{inputValue}"
            </div>
          )}
          {inputValue && (
            <button
              className="onboarding-btn onboarding-btn-primary"
              onClick={handleInputSubmit}
              style={{ marginTop: 16 }}
            >
              That's my choice
            </button>
          )}
          <button
            className="onboarding-mode-toggle"
            onClick={() => setInputMode('keyboard')}
          >
            Type instead
          </button>
        </>
      ) : (
        <>
          <input
            className="onboarding-input"
            placeholder="Enter a name (or press Enter to skip)"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="onboarding-btn onboarding-btn-primary"
            onClick={handleInputSubmit}
            style={{ marginTop: 16 }}
          >
            {inputValue.trim() ? 'Continue' : 'Skip'}
          </button>
          {voiceInput.isConfigured && (
            <button className="onboarding-mode-toggle" onClick={() => setInputMode('voice')}>
              Use voice
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      className={`cinematic-onboarding ${onboarding.state === 'transitioning' ? 'transitioning' : ''}`}
    >
      {/* Ambient background */}
      <div className="onboarding-ambient" />

      {/* Main content */}
      <div className="onboarding-content">
        {/* Orb */}
        <AwakeningOrb
          state={getOrbState()}
          audioLevel={voiceInput.state === 'recording' ? voiceInput.audioLevel : 0}
        />

        {/* Text */}
        {onboarding.currentText && onboarding.state !== 'dormant' && (
          <TypewriterText
            text={onboarding.currentText}
            speed={40}
            onComplete={onboarding.onTextComplete}
            showCursor={
              onboarding.state !== 'ask_name' &&
              onboarding.state !== 'ask_persona' &&
              onboarding.state !== 'ask_voice' &&
              onboarding.state !== 'ask_work_style' &&
              onboarding.state !== 'llm_setup' &&
              onboarding.state !== 'llm_api_key'
            }
          />
        )}

        {/* Name input */}
        {onboarding.showInput && onboarding.state === 'ask_name' && renderNameInput()}

        {/* Persona selection */}
        {onboarding.showPersonaOptions && onboarding.state === 'ask_persona' && renderPersonaButtons()}

        {/* Voice suggestion */}
        {onboarding.showVoiceOptions && onboarding.state === 'ask_voice' && renderVoiceOptions()}

        {/* Work style buttons */}
        {onboarding.showInput && onboarding.state === 'ask_work_style' && renderWorkStyleButtons()}

        {/* Style implications with countdown */}
        {onboarding.showStyleImplications && renderStyleImplications()}

        {/* Provider selection */}
        {onboarding.showProviders && renderProviders()}

        {/* API key input */}
        {onboarding.showApiInput && renderApiKeyInput()}

        {/* Testing indicator */}
        {onboarding.state === 'llm_testing' && (
          <div className="onboarding-test-result">
            <svg className="onboarding-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

export default Onboarding;
