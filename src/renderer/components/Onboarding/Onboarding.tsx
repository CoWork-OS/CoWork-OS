import { useEffect, useState, useCallback, useRef } from "react";
import { useOnboardingFlow, SCRIPT } from "../../hooks/useOnboardingFlow";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import { AwakeningOrb } from "./AwakeningOrb";
import { TypewriterText } from "./TypewriterText";
import type { LLMProviderType, PersonaId } from "../../../shared/types";
import { STARTER_MISSIONS } from "../../../shared/starter-missions";

interface OnboardingProps {
  onComplete: (dontShowAgain: boolean) => void;
}

interface OnboardingAmbientAudio {
  context: AudioContext;
  padOscillators: OscillatorNode[];
  padGains: GainNode[];
  padFilter: BiquadFilterNode;
  padMix: GainNode;
  droneOscillator: OscillatorNode;
  droneGain: GainNode;
  droneFilter: BiquadFilterNode;
  noiseSource: AudioBufferSourceNode;
  noiseFilter: BiquadFilterNode;
  noiseGain: GainNode;
  masterGain: GainNode;
  highPass: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  reverb: ConvolverNode;
  reverbGain: GainNode;
  delay: DelayNode;
  delayFeedback: GainNode;
  delayGain: GainNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  chordTimer: number;
  shimmerTimer: number;
  currentChordIndex: number;
}

// Provider display info
const PROVIDERS: {
  id: LLMProviderType;
  name: string;
  requiresKey: boolean;
  badge?: string;
}[] = [
  { id: "openrouter", name: "OpenRouter", requiresKey: true, badge: "Free" },
  { id: "anthropic", name: "Claude", requiresKey: true },
  { id: "openai", name: "OpenAI", requiresKey: true },
  { id: "gemini", name: "Gemini", requiresKey: true },
  { id: "ollama", name: "Ollama", requiresKey: false },
  { id: "groq", name: "Groq", requiresKey: true },
  { id: "xai", name: "Grok", requiresKey: true },
  { id: "kimi", name: "Kimi", requiresKey: true },
  { id: "bedrock", name: "AWS Bedrock", requiresKey: false },
];

// API key URLs for providers
const PROVIDER_URLS: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/app/apikey",
  openrouter: "https://openrouter.ai/keys",
  groq: "https://console.groq.com/keys",
  xai: "https://console.x.ai/",
  kimi: "https://platform.moonshot.ai/",
};

const CAPABILITY_PILLARS = [
  "Natural conversation",
  "Real task execution",
  "Shared memory over time",
];

const AMBIENT_CHORDS: number[][] = [
  [57, 60, 64, 69], // Am add9
  [53, 57, 60, 65], // F add9
  [55, 59, 62, 67], // G add9
  [50, 53, 57, 62], // Dm add9
];

const FILTER_TARGETS = [1250, 980, 1420, 1080];

const midiToFrequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

const createReverbImpulse = (context: AudioContext, duration = 4.2, decay = 2.8): AudioBuffer => {
  const length = Math.floor(context.sampleRate * duration);
  const impulse = context.createBuffer(2, length, context.sampleRate);

  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.pow(1 - t, decay);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
  }

  return impulse;
};

const createNoiseBuffer = (context: AudioContext, duration = 3.5): AudioBuffer => {
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);

  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    // Simple low-passed noise for smoother texture.
    last = 0.985 * last + 0.015 * white;
    data[i] = last;
  }

  return buffer;
};

interface OnboardingUiDraft {
  version: number;
  savedAt: number;
  inputValue: string;
  inputMode: "voice" | "keyboard";
  musicEnabled: boolean;
  showControlHints: boolean;
  confidencePrompt: string;
  confidenceResponse: string;
}

const ONBOARDING_UI_DRAFT_KEY = "cowork:onboarding:ui:v1";
const ONBOARDING_UI_DRAFT_VERSION = 1;
const ONBOARDING_UI_DRAFT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

const loadOnboardingUiDraft = (): OnboardingUiDraft | null => {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(ONBOARDING_UI_DRAFT_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<OnboardingUiDraft>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== ONBOARDING_UI_DRAFT_VERSION) return null;
    if (typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > ONBOARDING_UI_DRAFT_MAX_AGE_MS) return null;
    if (parsed.inputMode !== "voice" && parsed.inputMode !== "keyboard") return null;

    return {
      version: ONBOARDING_UI_DRAFT_VERSION,
      savedAt: parsed.savedAt,
      inputValue: typeof parsed.inputValue === "string" ? parsed.inputValue : "",
      inputMode: parsed.inputMode,
      musicEnabled: !!parsed.musicEnabled,
      showControlHints: parsed.showControlHints !== false,
      confidencePrompt: typeof parsed.confidencePrompt === "string" ? parsed.confidencePrompt : "",
      confidenceResponse:
        typeof parsed.confidenceResponse === "string" ? parsed.confidenceResponse : "",
    };
  } catch {
    return null;
  }
};

const persistOnboardingUiDraft = (draft: OnboardingUiDraft): void => {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(ONBOARDING_UI_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Ignore persistence failures
  }
};

const clearOnboardingUiDraft = (): void => {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(ONBOARDING_UI_DRAFT_KEY);
  } catch {
    // Ignore cleanup failures
  }
};

// Use shared starter missions — pick a subset for the onboarding final step
const FINAL_TRY_SUGGESTIONS = STARTER_MISSIONS.slice(0, 8);

type RecapEditableField = "name" | "persona" | "style" | "memory" | "voice";
type RecapDataUpdates = {
  assistantName: string;
  persona: PersonaId;
  workStyle: "planner" | "flexible" | null;
  memoryEnabled: boolean;
  voiceEnabled: boolean | null;
};

const buildConfidenceResponse = (
  prompt: string,
  data: {
    assistantName: string;
    workStyle: "planner" | "flexible" | null;
    memoryEnabled: boolean;
  },
): string => {
  const name = data.assistantName || "CoWork";
  const styleLine =
    data.workStyle === "planner"
      ? "I will break it into clear steps and keep progress visible."
      : "I will move quickly and adapt as context changes.";
  const memoryLine = data.memoryEnabled
    ? "I will remember useful preferences and context for next time."
    : "I will keep memory off until you enable it in Settings > Memory.";

  return `${name}: Great prompt: "${prompt}". ${styleLine} ${memoryLine}`;
};

export function Onboarding({ onComplete }: OnboardingProps) {
  const uiDraftRef = useRef<OnboardingUiDraft | null>(loadOnboardingUiDraft());
  const [inputValue, setInputValue] = useState(uiDraftRef.current?.inputValue ?? "");
  const [inputMode, setInputMode] = useState<"voice" | "keyboard">(
    uiDraftRef.current?.inputMode ?? "keyboard",
  );
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [musicEnabled, setMusicEnabled] = useState(uiDraftRef.current?.musicEnabled ?? true);
  const [showControlHints, setShowControlHints] = useState(
    uiDraftRef.current?.showControlHints ?? true,
  );
  const [confidencePrompt, setConfidencePrompt] = useState(
    uiDraftRef.current?.confidencePrompt ?? "",
  );
  const [confidenceResponse, setConfidenceResponse] = useState(
    uiDraftRef.current?.confidenceResponse ?? "",
  );
  const [themeMode, setThemeMode] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("theme-light") ? "light" : "dark",
  );
  const [recapEditingField, setRecapEditingField] = useState<RecapEditableField | null>(null);
  const [recapNameDraft, setRecapNameDraft] = useState("");
  const ambientAudioRef = useRef<OnboardingAmbientAudio | null>(null);

  const onboarding = useOnboardingFlow({ onComplete });
  const isSensitiveInputState =
    onboarding.state === "llm_api_key" || onboarding.state === "llm_testing";

  // Voice input integration
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setVoiceError(null);
      setInputValue((prev) => (prev ? `${prev} ${text}` : text));
    },
    onError: (error) => {
      // Keep voice mode active and show a recoverable error instead of forcing keyboard mode.
      setVoiceError(error || "Could not transcribe audio. Please try again.");
    },
    onNotConfigured: () => {
      setVoiceError("Voice transcription is not configured on this device.");
      setInputMode("keyboard");
    },
    transcriptionMode: "local_preferred",
  });

  // Check if voice is available on mount
  useEffect(() => {
    if (voiceInput.isConfigured) {
      setInputMode("voice");
    }
  }, [voiceInput.isConfigured]);

  // Start the onboarding when component mounts
  useEffect(() => {
    onboarding.start();
  }, []);

  useEffect(() => {
    if (onboarding.state === "dormant") {
      return;
    }

    if (onboarding.state === "transitioning") {
      clearOnboardingUiDraft();
      return;
    }

    persistOnboardingUiDraft({
      version: ONBOARDING_UI_DRAFT_VERSION,
      savedAt: Date.now(),
      inputValue: isSensitiveInputState ? "" : inputValue,
      inputMode,
      musicEnabled,
      showControlHints,
      confidencePrompt,
      confidenceResponse,
    });
  }, [
    onboarding.state,
    inputValue,
    inputMode,
    musicEnabled,
    showControlHints,
    confidencePrompt,
    confidenceResponse,
    isSensitiveInputState,
  ]);

  useEffect(() => {
    if (isSensitiveInputState) {
      setInputValue("");
    }
  }, [isSensitiveInputState]);

  useEffect(() => {
    if (onboarding.state !== "recap") {
      setRecapEditingField(null);
      return;
    }
    setRecapNameDraft(onboarding.data.assistantName || "");
  }, [onboarding.state, onboarding.data.assistantName]);

  useEffect(() => {
    if (!showControlHints) return;
    if (onboarding.state !== "greeting") {
      setShowControlHints(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowControlHints(false);
    }, 6000);

    return () => window.clearTimeout(timer);
  }, [showControlHints, onboarding.state]);

  const stopAmbientMusic = useCallback(() => {
    const ambient = ambientAudioRef.current;
    if (!ambient) return;

    window.clearInterval(ambient.chordTimer);
    window.clearInterval(ambient.shimmerTimer);

    ambient.padOscillators.forEach((oscillator, index) => {
      try {
        oscillator.stop();
      } catch {
        // Already stopped
      }
      oscillator.disconnect();
      ambient.padGains[index]?.disconnect();
    });

    try {
      ambient.droneOscillator.stop();
    } catch {
      // Already stopped
    }
    ambient.droneOscillator.disconnect();

    try {
      ambient.noiseSource.stop();
    } catch {
      // Already stopped
    }
    ambient.noiseSource.disconnect();

    try {
      ambient.lfo.stop();
    } catch {
      // Already stopped
    }
    ambient.lfo.disconnect();
    ambient.lfoGain.disconnect();

    ambient.padMix.disconnect();
    ambient.padFilter.disconnect();
    ambient.droneFilter.disconnect();
    ambient.droneGain.disconnect();
    ambient.noiseFilter.disconnect();
    ambient.noiseGain.disconnect();
    ambient.reverb.disconnect();
    ambient.reverbGain.disconnect();
    ambient.delay.disconnect();
    ambient.delayFeedback.disconnect();
    ambient.delayGain.disconnect();
    ambient.masterGain.disconnect();
    ambient.highPass.disconnect();
    ambient.compressor.disconnect();

    void ambient.context.close().catch(() => {});
    ambientAudioRef.current = null;
  }, []);

  const startAmbientMusic = useCallback(async () => {
    if (!musicEnabled || ambientAudioRef.current) return;

    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const context = new AudioContextCtor();
    const masterGain = context.createGain();
    const highPass = context.createBiquadFilter();
    const compressor = context.createDynamicsCompressor();

    highPass.type = "highpass";
    highPass.frequency.value = 30;
    highPass.Q.value = 0.7;

    compressor.threshold.value = -24;
    compressor.knee.value = 28;
    compressor.ratio.value = 2.2;
    compressor.attack.value = 0.03;
    compressor.release.value = 0.35;

    masterGain.gain.value = 0;
    masterGain.connect(highPass);
    highPass.connect(compressor);
    compressor.connect(context.destination);

    const reverb = context.createConvolver();
    const reverbGain = context.createGain();
    reverb.buffer = createReverbImpulse(context);
    reverbGain.gain.value = 0.42;
    masterGain.connect(reverb);
    reverb.connect(reverbGain);
    reverbGain.connect(highPass);

    const delay = context.createDelay(4);
    const delayFeedback = context.createGain();
    const delayGain = context.createGain();
    delay.delayTime.value = 0.42;
    delayFeedback.gain.value = 0.24;
    delayGain.gain.value = 0.16;
    masterGain.connect(delay);
    delay.connect(delayFeedback);
    delayFeedback.connect(delay);
    delay.connect(delayGain);
    delayGain.connect(highPass);

    const padMix = context.createGain();
    const padFilter = context.createBiquadFilter();
    padMix.gain.value = 0.34;
    padFilter.type = "lowpass";
    padFilter.frequency.value = FILTER_TARGETS[0];
    padFilter.Q.value = 0.8;
    padMix.connect(padFilter);
    padFilter.connect(masterGain);

    const padOscillators: OscillatorNode[] = [];
    const padGains: GainNode[] = [];
    for (let noteIndex = 0; noteIndex < 4; noteIndex++) {
      const primary = context.createOscillator();
      const primaryGain = context.createGain();
      primary.type = "sawtooth";
      primary.detune.value = -6;
      primaryGain.gain.value = 0.018;
      primary.connect(primaryGain);
      primaryGain.connect(padMix);
      padOscillators.push(primary);
      padGains.push(primaryGain);

      const secondary = context.createOscillator();
      const secondaryGain = context.createGain();
      secondary.type = "triangle";
      secondary.detune.value = 5;
      secondaryGain.gain.value = 0.014;
      secondary.connect(secondaryGain);
      secondaryGain.connect(padMix);
      padOscillators.push(secondary);
      padGains.push(secondaryGain);
    }

    const droneOscillator = context.createOscillator();
    const droneFilter = context.createBiquadFilter();
    const droneGain = context.createGain();
    droneOscillator.type = "sine";
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 210;
    droneFilter.Q.value = 0.6;
    droneGain.gain.value = 0.055;
    droneOscillator.connect(droneFilter);
    droneFilter.connect(droneGain);
    droneGain.connect(masterGain);

    const noiseSource = context.createBufferSource();
    const noiseFilter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noiseSource.buffer = createNoiseBuffer(context);
    noiseSource.loop = true;
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 1750;
    noiseFilter.Q.value = 0.45;
    noiseGain.gain.value = 0.008;
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(reverb);

    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.type = "sine";
    lfo.frequency.value = 0.018;
    lfoGain.gain.value = 190;
    lfo.connect(lfoGain);
    lfoGain.connect(padFilter.frequency);

    const applyChord = (index: number) => {
      const chord = AMBIENT_CHORDS[index];
      const now = context.currentTime;

      chord.forEach((midi, noteIndex) => {
        const baseFrequency = midiToFrequency(midi);
        const primary = padOscillators[noteIndex * 2];
        const secondary = padOscillators[noteIndex * 2 + 1];

        primary.frequency.cancelScheduledValues(now);
        primary.frequency.setTargetAtTime(baseFrequency, now, 3.4);
        secondary.frequency.cancelScheduledValues(now);
        secondary.frequency.setTargetAtTime(baseFrequency * 2, now, 3.8);
      });

      const root = chord[0] - 24;
      droneOscillator.frequency.cancelScheduledValues(now);
      droneOscillator.frequency.setTargetAtTime(midiToFrequency(root), now, 5.2);

      padFilter.frequency.cancelScheduledValues(now);
      padFilter.frequency.setTargetAtTime(FILTER_TARGETS[index], now, 4.2);
    };

    let currentChordIndex = 0;
    applyChord(currentChordIndex);

    padOscillators.forEach((oscillator) => oscillator.start());
    droneOscillator.start();
    noiseSource.start();
    lfo.start();

    const chordTimer = window.setInterval(() => {
      currentChordIndex = (currentChordIndex + 1) % AMBIENT_CHORDS.length;
      applyChord(currentChordIndex);
      if (ambientAudioRef.current) {
        ambientAudioRef.current.currentChordIndex = currentChordIndex;
      }
    }, 14000);

    const shimmerTimer = window.setInterval(() => {
      const active = ambientAudioRef.current;
      if (!active) return;

      const chord = AMBIENT_CHORDS[active.currentChordIndex];
      const shimmerMidi = chord[1 + Math.floor(Math.random() * (chord.length - 1))] + 12;
      const now = active.context.currentTime;

      const shimmerOsc = active.context.createOscillator();
      const shimmerGain = active.context.createGain();
      shimmerOsc.type = "sine";
      shimmerOsc.frequency.value = midiToFrequency(shimmerMidi);

      shimmerGain.gain.setValueAtTime(0.0001, now);
      shimmerGain.gain.linearRampToValueAtTime(0.03, now + 0.45);
      shimmerGain.gain.exponentialRampToValueAtTime(0.0001, now + 3.3);

      shimmerOsc.connect(shimmerGain);
      shimmerGain.connect(active.reverb);
      shimmerGain.connect(active.delay);

      shimmerOsc.start(now);
      shimmerOsc.stop(now + 3.4);
      shimmerOsc.onended = () => {
        shimmerOsc.disconnect();
        shimmerGain.disconnect();
      };
    }, 6800);

    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        // Browser may require user gesture; unlock handler below will retry
      }
    }

    masterGain.gain.setTargetAtTime(0.12, context.currentTime + 0.1, 2.4);

    ambientAudioRef.current = {
      context,
      padOscillators,
      padGains,
      padFilter,
      padMix,
      droneOscillator,
      droneGain,
      droneFilter,
      noiseSource,
      noiseFilter,
      noiseGain,
      masterGain,
      highPass,
      compressor,
      reverb,
      reverbGain,
      delay,
      delayFeedback,
      delayGain,
      lfo,
      lfoGain,
      chordTimer,
      shimmerTimer,
      currentChordIndex,
    };
  }, [musicEnabled]);

  const ensureAmbientMusicPlaying = useCallback(async () => {
    if (!musicEnabled) return;

    if (!ambientAudioRef.current) {
      await startAmbientMusic();
    }

    const ambient = ambientAudioRef.current;
    if (ambient && ambient.context.state === "suspended") {
      await ambient.context.resume().catch(() => {});
    }
  }, [musicEnabled, startAmbientMusic]);

  // Start ambient soundtrack during onboarding and stop it when exiting.
  useEffect(() => {
    const shouldPlayMusic =
      musicEnabled && onboarding.state !== "dormant" && onboarding.state !== "transitioning";

    if (shouldPlayMusic) {
      void ensureAmbientMusicPlaying();
    } else {
      stopAmbientMusic();
    }
  }, [musicEnabled, onboarding.state, ensureAmbientMusicPlaying, stopAmbientMusic]);

  // Ensure audio starts once user interacts (for autoplay-restricted environments).
  useEffect(() => {
    if (!musicEnabled) return;

    const unlockAudio = () => {
      void ensureAmbientMusicPlaying();
    };

    const resumeOnFocus = () => {
      void ensureAmbientMusicPlaying();
    };

    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("mousedown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    window.addEventListener("focus", resumeOnFocus);

    const retryTimer = window.setInterval(() => {
      const ambient = ambientAudioRef.current;
      if (!ambient || ambient.context.state !== "running") {
        void ensureAmbientMusicPlaying();
      }
    }, 2000);

    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("mousedown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("focus", resumeOnFocus);
      window.clearInterval(retryTimer);
    };
  }, [musicEnabled, ensureAmbientMusicPlaying]);

  // Cleanup audio resources on unmount.
  useEffect(() => {
    return () => {
      stopAmbientMusic();
    };
  }, [stopAmbientMusic]);

  const toggleThemeMode = useCallback(() => {
    setThemeMode((currentMode) => {
      const nextMode = currentMode === "light" ? "dark" : "light";
      const root = document.documentElement;
      root.classList.remove("theme-light", "theme-dark");
      if (nextMode === "light") {
        root.classList.add("theme-light");
      }

      if (window.electronAPI?.saveAppearanceSettings) {
        void window.electronAPI
          .saveAppearanceSettings({ themeMode: nextMode })
          .catch((error) => console.error("Failed to save onboarding theme preference:", error));
      }

      return nextMode;
    });
  }, []);

  const toggleMusicEnabled = useCallback(() => {
    setMusicEnabled((enabled) => {
      const nextEnabled = !enabled;
      if (!nextEnabled) {
        stopAmbientMusic();
      }
      return nextEnabled;
    });
  }, [stopAmbientMusic]);

  // Handle awakening animation
  useEffect(() => {
    if (onboarding.state === "awakening") {
      const timer = setTimeout(() => {
        onboarding.onAwakeningComplete();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [onboarding.state, onboarding.onAwakeningComplete]);

  const handleContinueFromRecap = useCallback(() => {
    setVoiceError(null);
    setInputValue("");
    setConfidencePrompt("");
    setConfidenceResponse("");
    onboarding.continueFromRecap();
  }, [onboarding]);

  const startRecapEdit = useCallback(
    (field: RecapEditableField) => {
      setVoiceError(null);
      setRecapEditingField(field);
      if (field === "name") {
        setRecapNameDraft(onboarding.data.assistantName || "");
      }
    },
    [onboarding.data.assistantName],
  );

  const cancelRecapEdit = useCallback(() => {
    setRecapEditingField(null);
    setRecapNameDraft(onboarding.data.assistantName || "");
  }, [onboarding.data.assistantName]);

  const applyRecapUpdate = useCallback(
    (updates: Partial<RecapDataUpdates>) => {
      onboarding.updateData(updates);
      setRecapEditingField(null);
    },
    [onboarding],
  );

  const saveRecapName = useCallback(() => {
    const trimmedName = recapNameDraft.trim();
    onboarding.updateData({ assistantName: trimmedName || "CoWork" });
    setRecapEditingField(null);
  }, [onboarding, recapNameDraft]);

  const handleConfidencePromptSubmit = useCallback(() => {
    const prompt = inputValue.trim();
    if (!prompt) return;

    setVoiceError(null);
    setConfidencePrompt(prompt);
    setConfidenceResponse(
      buildConfidenceResponse(prompt, {
        assistantName: onboarding.data.assistantName,
        workStyle: onboarding.data.workStyle,
        memoryEnabled: onboarding.data.memoryEnabled,
      }),
    );
    setInputValue("");
  }, [
    inputValue,
    onboarding.data.assistantName,
    onboarding.data.memoryEnabled,
    onboarding.data.workStyle,
  ]);

  // Handle input submission
  const handleInputSubmit = useCallback(() => {
    if (!inputValue.trim() && onboarding.state === "ask_name") {
      // Allow empty name (will use default)
      onboarding.submitName("");
      setInputValue("");
      return;
    }

    if (onboarding.state === "ask_name") {
      onboarding.submitName(inputValue);
      setInputValue("");
    } else if (onboarding.state === "llm_api_key") {
      onboarding.submitApiKey(inputValue);
      setInputValue("");
    } else if (onboarding.state === "final_try") {
      handleConfidencePromptSubmit();
    }
  }, [inputValue, onboarding, handleConfidencePromptSubmit]);

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleInputSubmit();
    }
  };

  // Handle voice button click
  const handleVoiceClick = () => {
    setVoiceError(null);
    if (voiceInput.state === "recording") {
      voiceInput.stopRecording();
    } else if (voiceInput.state === "idle") {
      voiceInput.startRecording();
    }
  };

  const isMicrophonePermissionError =
    !!voiceError &&
    (voiceError.toLowerCase().includes("microphone access is blocked") ||
      voiceError.toLowerCase().includes("not-allowed") ||
      voiceError.toLowerCase().includes("service-not-allowed"));
  const isSpeechServiceUnavailableError =
    !!voiceError &&
    (voiceError.toLowerCase().includes("speech recognition service is unavailable") ||
      voiceError.toLowerCase().includes("system speech recognition is unavailable") ||
      voiceError.toLowerCase().includes("speech recognition error: network"));

  const getOpenSettingsErrorMessage = (error: unknown, fallback: string): string => {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";

    if (raw.includes("No handler registered for 'system:openSettings'")) {
      return "Please restart the app once, then try opening settings again.";
    }

    return fallback;
  };

  const openMicrophoneSettings = useCallback(() => {
    const maybeOpenSystemSettings = (
      window.electronAPI as typeof window.electronAPI & {
        openSystemSettings?: (
          target: "microphone" | "dictation",
        ) => Promise<{ success: boolean; error?: string }>;
      }
    ).openSystemSettings;

    if (!maybeOpenSystemSettings) {
      setVoiceError(
        "Could not open System Settings automatically. Open Privacy & Security > Microphone.",
      );
      return;
    }

    void maybeOpenSystemSettings("microphone")
      .then((result) => {
        if (!result?.success) {
          setVoiceError(
            getOpenSettingsErrorMessage(
              result?.error,
              "Could not open System Settings automatically. Open Privacy & Security > Microphone.",
            ),
          );
        }
      })
      .catch((error) => {
        setVoiceError(
          getOpenSettingsErrorMessage(
            error,
            "Could not open System Settings automatically. Open Privacy & Security > Microphone.",
          ),
        );
      });
  }, []);

  const renderVoiceRecoveryHelp = () => {
    if (isMicrophonePermissionError) {
      return (
        <div className="onboarding-voice-help" role="note">
          <p>In System Settings, enable microphone access for CoWork OS.</p>
          <p>
            If CoWork OS is not listed and you launched from `npm run dev`, enable Terminal/Electron
            access instead.
          </p>
          <p>
            Then return here and tap the mic again. If you just changed permission, restart the app
            once.
          </p>
        </div>
      );
    }

    if (isSpeechServiceUnavailableError) {
      return (
        <div className="onboarding-voice-help" role="note">
          <p>Open Privacy & Security {">"} Microphone and ensure CoWork OS is enabled.</p>
          <p>
            If CoWork OS is not listed and you launched from `npm run dev`, enable Terminal/Electron
            access instead.
          </p>
          <p>
            If it is already enabled, check Keyboard {">"} Dictation and confirm Dictation is on.
          </p>
        </div>
      );
    }

    return null;
  };

  // Determine orb state
  const getOrbState = () => {
    if (onboarding.state === "dormant") return "dormant";
    if (onboarding.state === "awakening") return "awakening";
    if (onboarding.state === "transitioning") return "transitioning";
    if (voiceInput.state === "recording") return "listening";
    return "breathing";
  };

  // Render work style buttons
  const renderWorkStyleButtons = () => (
    <div className="onboarding-actions">
      <button
        className="onboarding-btn onboarding-btn-secondary"
        onClick={() => onboarding.submitWorkStyle("planner")}
      >
        Structured planning
      </button>
      <button
        className="onboarding-btn onboarding-btn-secondary"
        onClick={() => onboarding.submitWorkStyle("flexible")}
      >
        Adaptive execution
      </button>
    </div>
  );

  // Render persona selection buttons
  const renderPersonaButtons = () => (
    <div className="onboarding-actions">
      <button
        className="onboarding-btn onboarding-btn-primary"
        onClick={() => onboarding.submitPersona("companion")}
      >
        Warm partner
      </button>
      <button
        className="onboarding-btn onboarding-btn-secondary"
        onClick={() => onboarding.submitPersona("none")}
      >
        Neutral operator
      </button>
    </div>
  );

  const renderVoiceOptions = () => (
    <div className="onboarding-actions">
      <button
        className="onboarding-btn onboarding-btn-primary"
        onClick={() => onboarding.submitVoicePreference(true)}
      >
        Enable voice replies
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
          color: "var(--onboarding-warm-white)",
          opacity: 0.7,
          fontSize: "0.9rem",
          textAlign: "center",
        }}
      >
        You can change this later in Settings {">"} Voice.
      </div>
    </div>
  );

  const renderCapabilityPillars = () => (
    <div className="onboarding-capability-strip" aria-label="Core capabilities">
      <div className="onboarding-capability-label">How I work with you</div>
      <div className="onboarding-capability-pills">
        {CAPABILITY_PILLARS.map((item) => (
          <span key={item} className="onboarding-capability-pill">
            {item}
          </span>
        ))}
      </div>
    </div>
  );

  const showCapabilityPillarsOnce =
    onboarding.state === "greeting" &&
    onboarding.currentText === SCRIPT.greeting[SCRIPT.greeting.length - 1];

  const renderMemoryTrustStep = () => (
    <div className="onboarding-memory-trust">
      <p className="onboarding-memory-trust-copy">Choose what I remember:</p>
      <ul className="onboarding-memory-trust-list">
        <li>Memory on keeps useful preferences and recurring context from our chats.</li>
        <li>
          Memory off means no memory storage at all until you re-enable it in Settings {">"} Memory.
        </li>
        <li>You can review, edit, or delete memory anytime in Settings {">"} Memory.</li>
      </ul>
      <button
        className={`onboarding-memory-toggle ${onboarding.data.memoryEnabled ? "enabled" : ""}`}
        role="switch"
        aria-checked={onboarding.data.memoryEnabled}
        onClick={() => onboarding.setMemoryTrustChoice(!onboarding.data.memoryEnabled)}
      >
        <span className="onboarding-memory-toggle-track">
          <span className="onboarding-memory-toggle-knob" />
        </span>
        <span className="onboarding-memory-toggle-label">
          {onboarding.data.memoryEnabled ? "Memory on" : "Memory off"}
        </span>
      </button>
      <div className="onboarding-actions" style={{ marginTop: 20 }}>
        <button
          className="onboarding-btn onboarding-btn-primary"
          onClick={() => onboarding.submitMemoryTrust(onboarding.data.memoryEnabled)}
        >
          {onboarding.data.memoryEnabled ? "Continue with memory on" : "Continue with memory off"}
        </button>
      </div>
    </div>
  );

  // Render style implications with countdown and change option
  const renderStyleImplications = () => {
    const implications =
      onboarding.data.workStyle === "planner"
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

  const renderPersonalizedRecap = () => {
    const providerName = onboarding.data.selectedProvider
      ? PROVIDERS.find((provider) => provider.id === onboarding.data.selectedProvider)?.name ||
        onboarding.data.selectedProvider
      : "Not configured yet";
    const personaLabel =
      onboarding.data.persona === "companion" ? "Warm partner" : "Neutral operator";
    const workStyleLabel =
      onboarding.data.workStyle === "planner"
        ? "Structured planning"
        : onboarding.data.workStyle === "flexible"
          ? "Adaptive execution"
          : "Not set yet";
    const memoryLabel = onboarding.data.memoryEnabled ? "On" : "Off";
    const voiceLabel =
      onboarding.data.voiceEnabled === null
        ? "Not set yet"
        : onboarding.data.voiceEnabled
          ? "Enabled"
          : "Disabled";
    const isEditingName = recapEditingField === "name";
    const isEditingPersona = recapEditingField === "persona";
    const isEditingStyle = recapEditingField === "style";
    const isEditingMemory = recapEditingField === "memory";
    const isEditingVoice = recapEditingField === "voice";

    return (
      <div className="onboarding-recap">
        <p className="onboarding-recap-summary">
          I&apos;ll call myself <strong>{onboarding.data.assistantName || "CoWork"}</strong>, use{" "}
          <strong>{workStyleLabel.toLowerCase()}</strong>, and keep memory{" "}
          <strong>{memoryLabel.toLowerCase()}</strong>.
        </p>

        <div className="onboarding-recap-list">
          <div className="onboarding-recap-item">
            <div className="onboarding-recap-item-content">
              <span className="onboarding-recap-item-label">Name</span>
              {!isEditingName && (
                <span className="onboarding-recap-item-value">
                  {onboarding.data.assistantName || "CoWork"}
                </span>
              )}
              {isEditingName && (
                <div className="onboarding-recap-inline-edit">
                  <input
                    className="onboarding-input onboarding-recap-inline-input"
                    placeholder="Assistant name"
                    value={recapNameDraft}
                    onChange={(event) => setRecapNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        saveRecapName();
                      }
                    }}
                    autoFocus
                  />
                  <div className="onboarding-recap-inline-actions">
                    <button className="onboarding-recap-inline-btn primary" onClick={saveRecapName}>
                      Save
                    </button>
                    <button
                      className="onboarding-recap-inline-btn secondary"
                      onClick={cancelRecapEdit}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            {!isEditingName && (
              <button className="onboarding-recap-edit-btn" onClick={() => startRecapEdit("name")}>
                Edit
              </button>
            )}
          </div>

          <div className="onboarding-recap-item">
            <div className="onboarding-recap-item-content">
              <span className="onboarding-recap-item-label">Persona</span>
              {!isEditingPersona && (
                <span className="onboarding-recap-item-value">{personaLabel}</span>
              )}
              {isEditingPersona && (
                <div className="onboarding-recap-choice-group">
                  <button
                    className={`onboarding-recap-choice-btn ${
                      onboarding.data.persona === "companion" ? "active" : ""
                    }`}
                    onClick={() => applyRecapUpdate({ persona: "companion" })}
                  >
                    Warm partner
                  </button>
                  <button
                    className={`onboarding-recap-choice-btn ${
                      onboarding.data.persona === "none" ? "active" : ""
                    }`}
                    onClick={() => applyRecapUpdate({ persona: "none" })}
                  >
                    Neutral operator
                  </button>
                </div>
              )}
            </div>
            {!isEditingPersona ? (
              <button
                className="onboarding-recap-edit-btn"
                onClick={() => startRecapEdit("persona")}
              >
                Edit
              </button>
            ) : (
              <button className="onboarding-recap-edit-btn" onClick={cancelRecapEdit}>
                Cancel
              </button>
            )}
          </div>

          <div className="onboarding-recap-item">
            <div className="onboarding-recap-item-content">
              <span className="onboarding-recap-item-label">Work style</span>
              {!isEditingStyle && (
                <span className="onboarding-recap-item-value">{workStyleLabel}</span>
              )}
              {isEditingStyle && (
                <div className="onboarding-recap-choice-group">
                  <button
                    className={`onboarding-recap-choice-btn ${
                      onboarding.data.workStyle === "planner" ? "active" : ""
                    }`}
                    onClick={() => applyRecapUpdate({ workStyle: "planner" })}
                  >
                    Structured planning
                  </button>
                  <button
                    className={`onboarding-recap-choice-btn ${
                      onboarding.data.workStyle === "flexible" ? "active" : ""
                    }`}
                    onClick={() => applyRecapUpdate({ workStyle: "flexible" })}
                  >
                    Adaptive execution
                  </button>
                </div>
              )}
            </div>
            {!isEditingStyle ? (
              <button className="onboarding-recap-edit-btn" onClick={() => startRecapEdit("style")}>
                Edit
              </button>
            ) : (
              <button className="onboarding-recap-edit-btn" onClick={cancelRecapEdit}>
                Cancel
              </button>
            )}
          </div>

          <div className="onboarding-recap-item">
            <div className="onboarding-recap-item-content">
              <span className="onboarding-recap-item-label">Memory</span>
              {!isEditingMemory && (
                <>
                  <span className="onboarding-recap-item-value">{memoryLabel}</span>
                  <span className="onboarding-recap-item-note">
                    {onboarding.data.memoryEnabled
                      ? "Stores useful context between conversations."
                      : "No memory storage until enabled in Settings > Memory."}
                  </span>
                </>
              )}
              {isEditingMemory && (
                <div className="onboarding-recap-choice-group">
                  <button
                    className={`onboarding-recap-choice-btn ${
                      onboarding.data.memoryEnabled ? "active" : ""
                    }`}
                    onClick={() => applyRecapUpdate({ memoryEnabled: true })}
                  >
                    Memory on
                  </button>
                  <button
                    className={`onboarding-recap-choice-btn ${
                      !onboarding.data.memoryEnabled ? "active" : ""
                    }`}
                    onClick={() => applyRecapUpdate({ memoryEnabled: false })}
                  >
                    Memory off
                  </button>
                </div>
              )}
            </div>
            {!isEditingMemory ? (
              <button
                className="onboarding-recap-edit-btn"
                onClick={() => startRecapEdit("memory")}
              >
                Edit
              </button>
            ) : (
              <button className="onboarding-recap-edit-btn" onClick={cancelRecapEdit}>
                Cancel
              </button>
            )}
          </div>

          <div className="onboarding-recap-item">
            <div className="onboarding-recap-item-content">
              <span className="onboarding-recap-item-label">Voice</span>
              {!isEditingVoice && <span className="onboarding-recap-item-value">{voiceLabel}</span>}
              {isEditingVoice && (
                <div className="onboarding-recap-choice-group">
                  <button
                    className={`onboarding-recap-choice-btn ${
                      onboarding.data.voiceEnabled === true ? "active" : ""
                    }`}
                    onClick={() => applyRecapUpdate({ voiceEnabled: true })}
                  >
                    Enabled
                  </button>
                  <button
                    className={`onboarding-recap-choice-btn ${
                      onboarding.data.voiceEnabled === false ? "active" : ""
                    }`}
                    onClick={() => applyRecapUpdate({ voiceEnabled: false })}
                  >
                    Disabled
                  </button>
                </div>
              )}
            </div>
            {!isEditingVoice ? (
              <button className="onboarding-recap-edit-btn" onClick={() => startRecapEdit("voice")}>
                Edit
              </button>
            ) : (
              <button className="onboarding-recap-edit-btn" onClick={cancelRecapEdit}>
                Cancel
              </button>
            )}
          </div>

          <div className="onboarding-recap-item">
            <div className="onboarding-recap-item-content">
              <span className="onboarding-recap-item-label">Model provider</span>
              <span className="onboarding-recap-item-value">{providerName}</span>
              <span className="onboarding-recap-item-note">
                Changes to provider reopen model setup.
              </span>
            </div>
            <button
              className="onboarding-recap-edit-btn"
              onClick={() => onboarding.editRecapSection("model")}
            >
              Edit
            </button>
          </div>
        </div>

        <div className="onboarding-actions onboarding-recap-actions">
          <button
            className="onboarding-btn onboarding-btn-primary"
            onClick={handleContinueFromRecap}
          >
            Looks good
          </button>
        </div>
      </div>
    );
  };

  const renderFinalTryPrompt = () => (
    <div className="onboarding-final-try">
      <p className="onboarding-final-try-copy">
        Try one prompt now and I&apos;ll respond instantly.
      </p>

      <div className="onboarding-final-try-suggestions">
        {FINAL_TRY_SUGGESTIONS.map((mission) => (
          <button
            key={mission.title}
            className="onboarding-final-try-suggestion"
            onClick={() => {
              setInputValue(mission.prompt);
              setVoiceError(null);
            }}
          >
            {mission.title}
          </button>
        ))}
      </div>

      <div className="onboarding-final-try-input-row">
        <input
          className="onboarding-input onboarding-final-try-input"
          placeholder="Try me now..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        {voiceInput.isConfigured && (
          <button
            className={`onboarding-final-try-voice-btn ${
              voiceInput.state === "recording" ? "recording" : ""
            }`}
            onClick={handleVoiceClick}
            disabled={voiceInput.state === "processing"}
            aria-label="Use voice input"
            title="Use voice input"
          >
            {voiceInput.state === "processing" ? (
              <svg
                className="onboarding-spinner"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" />
              </svg>
            ) : (
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            )}
          </button>
        )}
      </div>

      {voiceError && (
        <div className="onboarding-voice-error onboarding-final-try-voice-error" role="alert">
          {voiceError}
        </div>
      )}

      <div className="onboarding-actions onboarding-final-try-actions">
        <button
          className="onboarding-btn onboarding-btn-primary"
          onClick={handleConfidencePromptSubmit}
          disabled={!inputValue.trim()}
        >
          Try it
        </button>
        <button
          className="onboarding-btn onboarding-btn-secondary"
          onClick={onboarding.completeOnboarding}
        >
          Enter CoWork
        </button>
      </div>

      {confidenceResponse && (
        <div className="onboarding-final-try-response">
          <div className="onboarding-final-try-response-title">
            {onboarding.data.assistantName || "CoWork"}
          </div>
          <p>{confidenceResponse}</p>
          {confidencePrompt && (
            <div className="onboarding-final-try-prompt">
              Prompt: <span>{confidencePrompt}</span>
            </div>
          )}
          <button
            className="onboarding-btn onboarding-btn-primary onboarding-final-try-enter-btn"
            onClick={onboarding.completeOnboarding}
          >
            Start in workspace
          </button>
        </div>
      )}
    </div>
  );

  // Render Ollama auto-detection card
  const renderOllamaDetection = () => {
    const modelName = onboarding.data.detectedOllamaModel || "Ollama";

    return (
      <div className="onboarding-ollama-detection">
        <div className="onboarding-ollama-detection-icon">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 9h6v6H9z" />
          </svg>
        </div>
        <p className="onboarding-ollama-detection-model">{modelName}</p>
        <p className="onboarding-ollama-detection-note">
          Local model — no API key needed, completely private.
        </p>
        <div className="onboarding-actions" style={{ marginTop: 20 }}>
          <button
            className="onboarding-btn onboarding-btn-primary"
            onClick={() => onboarding.acceptOllamaDetection()}
          >
            Use {modelName}
          </button>
          <button
            className="onboarding-btn onboarding-btn-secondary"
            onClick={() => onboarding.declineOllamaDetection()}
          >
            Choose another provider
          </button>
        </div>
      </div>
    );
  };

  // Render provider selection
  const renderProviders = () => (
    <div className={`onboarding-setup-section ${onboarding.showProviders ? "visible" : ""}`}>
      <div className="onboarding-provider-pills">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            className={`onboarding-provider-pill ${
              onboarding.data.selectedProvider === provider.id ? "selected" : ""
            }`}
            onClick={() => onboarding.selectProvider(provider.id)}
          >
            {provider.name}
            {provider.badge && <span className="onboarding-provider-badge">{provider.badge}</span>}
          </button>
        ))}
      </div>
      <div className="onboarding-actions" style={{ marginTop: 24 }}>
        <button
          className="onboarding-btn onboarding-btn-secondary"
          onClick={onboarding.skipLLMSetup}
        >
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
      <div className={`onboarding-api-input-section ${onboarding.showApiInput ? "visible" : ""}`}>
        {url && (
          <p className="onboarding-api-hint">
            Get your key from{" "}
            <a href={url} target="_blank" rel="noopener noreferrer">
              {provider === "anthropic"
                ? "Anthropic"
                : provider === "openai"
                  ? "OpenAI"
                  : provider === "gemini"
                    ? "Google AI Studio"
                    : provider === "openrouter"
                      ? "OpenRouter"
                      : provider === "groq"
                        ? "Groq Console"
                        : provider === "xai"
                          ? "xAI Console"
                          : "Moonshot Platform"}
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
            <button
              className="onboarding-btn onboarding-btn-secondary"
              onClick={onboarding.skipLLMSetup}
            >
              Skip
            </button>
          </div>
        </div>
        {onboarding.testResult && !onboarding.testResult.success && (
          <div className="onboarding-test-result error">
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
            <span>{onboarding.testResult.error || "Connection failed"}</span>
          </div>
        )}
      </div>
    );
  };

  // Render name input
  const renderNameInput = () => (
    <div className="onboarding-input-container">
      {inputMode === "voice" && voiceInput.isConfigured ? (
        <>
          <button
            className={`onboarding-voice-btn ${
              voiceInput.state === "recording"
                ? "recording"
                : voiceInput.state === "processing"
                  ? "processing"
                  : ""
            }`}
            onClick={handleVoiceClick}
            disabled={voiceInput.state === "processing"}
          >
            {voiceInput.state === "processing" ? (
              <svg
                className="onboarding-spinner"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" />
              </svg>
            ) : voiceInput.state === "recording" ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            )}
          </button>
          {inputValue && (
            <div style={{ marginTop: 16, color: "var(--onboarding-warm-white)", fontSize: "1rem" }}>
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
          {voiceError && (
            <div className="onboarding-voice-error" role="alert">
              {voiceError}
            </div>
          )}
          {renderVoiceRecoveryHelp()}
          {isMicrophonePermissionError && (
            <button
              className="onboarding-btn onboarding-btn-secondary onboarding-btn-sm onboarding-voice-fix-btn"
              onClick={openMicrophoneSettings}
            >
              Open Microphone Settings
            </button>
          )}
          {isSpeechServiceUnavailableError && (
            <button
              className="onboarding-btn onboarding-btn-secondary onboarding-btn-sm onboarding-voice-fix-btn"
              onClick={openMicrophoneSettings}
            >
              Open Microphone Settings
            </button>
          )}
          <button className="onboarding-mode-toggle" onClick={() => setInputMode("keyboard")}>
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
            {inputValue.trim() ? "Continue" : "Skip"}
          </button>
          {voiceInput.isConfigured && (
            <button
              className="onboarding-mode-toggle"
              onClick={() => {
                setVoiceError(null);
                setInputMode("voice");
              }}
            >
              Use voice
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      className={`cinematic-onboarding ${onboarding.state === "transitioning" ? "transitioning" : ""}`}
    >
      {/* Ambient background */}
      <div className="onboarding-ambient" />

      {onboarding.canGoBack && (
        <button
          className="onboarding-back-btn"
          onClick={onboarding.goBack}
          aria-label="Go back to previous onboarding step"
          title="Back"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      )}

      <div className="onboarding-top-right-controls">
        <div className="onboarding-control-btn-wrap">
          <button
            className="onboarding-theme-btn"
            onClick={toggleThemeMode}
            aria-label={themeMode === "light" ? "Switch to dark mode" : "Switch to light mode"}
            title={themeMode === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {themeMode === "light" ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.2" y1="4.2" x2="5.6" y2="5.6" />
                <line x1="18.4" y1="18.4" x2="19.8" y2="19.8" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.2" y1="19.8" x2="5.6" y2="18.4" />
                <line x1="18.4" y1="5.6" x2="19.8" y2="4.2" />
              </svg>
            )}
          </button>
          {showControlHints && onboarding.state === "greeting" && (
            <span className="onboarding-control-once-hint">Theme</span>
          )}
        </div>

        <div className="onboarding-control-btn-wrap">
          <button
            className={`onboarding-music-btn ${musicEnabled ? "active" : ""}`}
            onClick={toggleMusicEnabled}
            aria-label={musicEnabled ? "Mute background music" : "Enable background music"}
            title={musicEnabled ? "Mute background music" : "Enable background music"}
          >
            {musicEnabled ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M18.5 5.5a9 9 0 0 1 0 13" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            )}
          </button>
          {showControlHints && onboarding.state === "greeting" && (
            <span className="onboarding-control-once-hint">Music</span>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="onboarding-content">
        {/* Orb */}
        <AwakeningOrb
          state={getOrbState()}
          audioLevel={voiceInput.state === "recording" ? voiceInput.audioLevel : 0}
        />

        {/* Text */}
        {onboarding.currentText && onboarding.state !== "dormant" && (
          <TypewriterText
            text={onboarding.currentText}
            speed={40}
            onComplete={onboarding.onTextComplete}
            showCursor={
              onboarding.state !== "ask_name" &&
              onboarding.state !== "ask_persona" &&
              onboarding.state !== "ask_voice" &&
              onboarding.state !== "ask_work_style" &&
              onboarding.state !== "ask_memory_trust" &&
              onboarding.state !== "ollama_detected" &&
              onboarding.state !== "llm_setup" &&
              onboarding.state !== "llm_api_key" &&
              onboarding.state !== "recap" &&
              onboarding.state !== "final_try"
            }
          />
        )}

        {/* Product positioning cue (intro only) */}
        {showCapabilityPillarsOnce && renderCapabilityPillars()}

        {/* Name input */}
        {onboarding.showInput && onboarding.state === "ask_name" && renderNameInput()}

        {/* Persona selection */}
        {onboarding.showPersonaOptions &&
          onboarding.state === "ask_persona" &&
          renderPersonaButtons()}

        {/* Voice suggestion */}
        {onboarding.showVoiceOptions && onboarding.state === "ask_voice" && renderVoiceOptions()}

        {/* Work style buttons */}
        {onboarding.showInput && onboarding.state === "ask_work_style" && renderWorkStyleButtons()}

        {/* Style implications with countdown */}
        {onboarding.showStyleImplications && renderStyleImplications()}

        {/* Memory trust toggle */}
        {onboarding.state === "ask_memory_trust" && renderMemoryTrustStep()}

        {/* Ollama auto-detection */}
        {onboarding.showOllamaDetection && renderOllamaDetection()}

        {/* Provider selection */}
        {onboarding.showProviders && renderProviders()}

        {/* API key input */}
        {onboarding.showApiInput && renderApiKeyInput()}

        {/* Personalized recap */}
        {onboarding.state === "recap" && renderPersonalizedRecap()}

        {/* Final confidence moment */}
        {onboarding.state === "final_try" && renderFinalTryPrompt()}

        {/* Testing indicator */}
        {onboarding.state === "llm_testing" && (
          <div className="onboarding-test-result">
            <svg
              className="onboarding-spinner"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

export default Onboarding;
