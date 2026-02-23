import { useState, useCallback, useEffect, useRef } from "react";
import type { LLMProviderType, PersonaId } from "../../shared/types";

// Onboarding conversation states
export type OnboardingState =
  | "dormant"
  | "awakening"
  | "greeting"
  | "ask_name"
  | "confirm_name"
  | "ask_persona"
  | "confirm_persona"
  | "ask_voice"
  | "confirm_voice"
  | "ask_work_style"
  | "reflect_style"
  | "ask_memory_trust"
  | "confirm_memory_trust"
  | "transition_setup"
  | "ollama_detected"
  | "llm_setup"
  | "llm_api_key"
  | "llm_testing"
  | "llm_confirmed"
  | "recap"
  | "final_try"
  | "completion"
  | "transitioning";

// Conversation script - cinematic tone with clear product positioning
const SCRIPT = {
  greeting: [
    "Initializing...",
    "Systems online.",
    "I can talk with you naturally, execute real work across tools, and remember how you like things done.",
  ],
  ask_name: "Before we start, what should I call myself?",
  confirm_name: (name: string) =>
    name
      ? `${name}. Great choice. I'll carry that into every conversation.`
      : "I'll go by CoWork. Ready when you are.",
  ask_persona: "How do you want me to show up in your day-to-day work?",
  confirm_persona_companion:
    "Then I'll be warm, thoughtful, and present while we work through things together.",
  confirm_persona_neutral: "Understood. I'll keep it direct, clear, and execution-focused.",
  ask_voice: "Would you like spoken responses when they help?",
  confirm_voice_on: "Great. I'll speak when it adds clarity.",
  confirm_voice_off: "No problem. We'll stay text-first for now.",
  ask_work_style: "I want to match your pace. Do you prefer clear plans, or flexible execution?",
  reflect_style_planner: "Perfect. I'll structure the work and keep progress visible.",
  reflect_style_flexible: "Great. I'll move quickly and adapt as context changes.",
  // Implications shown after work style selection
  style_implications_planner: [
    "• I'll map work into clear step-by-step plans",
    "• You'll get steady updates with explicit next actions",
    "• I'll remember repeat patterns so future tasks start faster",
  ],
  style_implications_flexible: [
    "• I'll start fast and adjust in real time",
    "• We'll iterate quickly instead of over-planning upfront",
    "• I'll carry forward context from our conversations",
  ],
  ask_memory_trust:
    "One trust setting before we continue: decide whether I should remember helpful context across conversations.",
  confirm_memory_trust_on:
    "Great. I'll keep useful preferences and context, and you can edit or delete memory anytime.",
  confirm_memory_trust_off:
    "Understood. I'll keep memory fully off with no memory storage for now. You can enable it later in Settings > Memory.",
  transition_setup: "Final setup step: choose the AI model that should power me.",
  ollama_detected: (modelName: string) =>
    `I found ${modelName} running locally on your machine via Ollama. Want to use it?`,
  llm_intro: "This engine drives my reasoning and task execution. Pick what fits you best.",
  llm_selected: (provider: string) => {
    const responses: Record<string, string> = {
      anthropic: "Claude. That's a good match for us.",
      openai: "OpenAI. Classic and reliable.",
      gemini: "Gemini. Let's see what we can do together.",
      ollama: "Local with Ollama. I like the privacy.",
      openrouter: "OpenRouter. Lots of options to explore.",
      bedrock: "AWS Bedrock. Enterprise-ready.",
      groq: "Groq. Speedy and efficient.",
      xai: "Grok. Let's put xAI to work.",
      kimi: "Kimi. Solid choice.",
    };
    return responses[provider] || "Good choice.";
  },
  llm_need_key: "To activate this provider, paste an API key from its dashboard.",
  llm_testing: "Connecting...",
  llm_success: "Connection confirmed. I'm ready to work with context.",
  llm_error: "That didn't connect. Want to try another key?",
  recap_intro: (name: string) => `Quick recap${name ? `, ${name}` : ""}, before we begin.`,
  final_try_prompt: (name: string) =>
    `${name || "CoWork"} is ready. Give me one quick prompt by voice or text.`,
  completion: (name: string) =>
    `All set${name ? `, ${name}` : ""}. Tell me what you want done, or just talk with me.`,
};

interface UseOnboardingOptions {
  onComplete: (dontShowAgain: boolean) => void;
}

interface OnboardingData {
  assistantName: string;
  persona: PersonaId;
  voiceEnabled: boolean | null;
  workStyle: "planner" | "flexible" | null;
  memoryEnabled: boolean;
  selectedProvider: LLMProviderType | null;
  apiKey: string;
  ollamaUrl: string;
  detectedOllamaModel: string | null;
}

type RecapEditTarget = "name" | "persona" | "voice" | "style" | "memory" | "model";

interface OnboardingResumeSnapshot {
  version: number;
  updatedAt: number;
  state: OnboardingState;
  currentText: string;
  greetingIndex: number;
  showInput: boolean;
  showProviders: boolean;
  showApiInput: boolean;
  showStyleImplications: boolean;
  showPersonaOptions: boolean;
  showVoiceOptions: boolean;
  showOllamaDetection: boolean;
  styleCountdown: number;
  testResult: {
    success: boolean;
    error?: string;
  } | null;
  data: OnboardingData;
}

const INITIAL_ONBOARDING_DATA: OnboardingData = {
  assistantName: "",
  persona: "companion",
  voiceEnabled: null,
  workStyle: null,
  memoryEnabled: true,
  selectedProvider: null,
  apiKey: "",
  ollamaUrl: "http://localhost:11434",
  detectedOllamaModel: null,
};

const ONBOARDING_RESUME_KEY = "cowork:onboarding:flow:v1";
const ONBOARDING_RESUME_VERSION = 1;
const ONBOARDING_RESUME_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

const ONBOARDING_STATES: OnboardingState[] = [
  "dormant",
  "awakening",
  "greeting",
  "ask_name",
  "confirm_name",
  "ask_persona",
  "confirm_persona",
  "ask_voice",
  "confirm_voice",
  "ask_work_style",
  "reflect_style",
  "ask_memory_trust",
  "confirm_memory_trust",
  "transition_setup",
  "ollama_detected",
  "llm_setup",
  "llm_api_key",
  "llm_testing",
  "llm_confirmed",
  "recap",
  "final_try",
  "completion",
  "transitioning",
];

const isOnboardingState = (value: unknown): value is OnboardingState =>
  typeof value === "string" && ONBOARDING_STATES.includes(value as OnboardingState);

const getFallbackTextForState = (
  state: OnboardingState,
  data: OnboardingData,
  greetingIndex: number,
): string => {
  switch (state) {
    case "greeting": {
      const index = Math.min(Math.max(greetingIndex, 0), SCRIPT.greeting.length - 1);
      return SCRIPT.greeting[index];
    }
    case "ask_name":
      return SCRIPT.ask_name;
    case "confirm_name":
      return SCRIPT.confirm_name(data.assistantName);
    case "ask_persona":
      return SCRIPT.ask_persona;
    case "confirm_persona":
      return data.persona === "companion"
        ? SCRIPT.confirm_persona_companion
        : SCRIPT.confirm_persona_neutral;
    case "ask_voice":
      return SCRIPT.ask_voice;
    case "confirm_voice":
      return data.voiceEnabled ? SCRIPT.confirm_voice_on : SCRIPT.confirm_voice_off;
    case "ask_work_style":
      return SCRIPT.ask_work_style;
    case "reflect_style":
      return data.workStyle === "planner"
        ? SCRIPT.reflect_style_planner
        : SCRIPT.reflect_style_flexible;
    case "ask_memory_trust":
      return SCRIPT.ask_memory_trust;
    case "confirm_memory_trust":
      return data.memoryEnabled ? SCRIPT.confirm_memory_trust_on : SCRIPT.confirm_memory_trust_off;
    case "transition_setup":
      return SCRIPT.transition_setup;
    case "ollama_detected":
      return data.detectedOllamaModel
        ? SCRIPT.ollama_detected(data.detectedOllamaModel)
        : "I found a local AI model. Want to use it?";
    case "llm_setup":
      return SCRIPT.llm_intro;
    case "llm_api_key":
      return SCRIPT.llm_need_key;
    case "llm_testing":
      return SCRIPT.llm_testing;
    case "llm_confirmed":
      return SCRIPT.llm_success;
    case "recap":
      return SCRIPT.recap_intro(data.assistantName);
    case "final_try":
      return SCRIPT.final_try_prompt(data.assistantName);
    case "completion":
      return SCRIPT.completion(data.assistantName);
    default:
      return "";
  }
};

const getRequiredUiForState = (state: OnboardingState) => ({
  showInput: state === "ask_name" || state === "ask_work_style",
  showProviders: state === "llm_setup",
  showApiInput: state === "llm_api_key",
  showPersonaOptions: state === "ask_persona",
  showVoiceOptions: state === "ask_voice",
  showOllamaDetection: state === "ollama_detected",
});

const sanitizeOnboardingData = (value: OnboardingData): OnboardingData => ({
  ...value,
  apiKey: "",
});

const sanitizeResumeSnapshot = (snapshot: OnboardingResumeSnapshot): OnboardingResumeSnapshot => ({
  ...snapshot,
  data: sanitizeOnboardingData(snapshot.data),
});

const parseResumeSnapshot = (value: unknown): OnboardingResumeSnapshot | null => {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<OnboardingResumeSnapshot>;
  if (!isOnboardingState(candidate.state)) return null;

  const data = sanitizeOnboardingData({
    ...INITIAL_ONBOARDING_DATA,
    ...(candidate.data || {}),
  } as OnboardingData);
  const requiredUi = getRequiredUiForState(candidate.state);
  const normalizedGreetingIndex = Number(candidate.greetingIndex || 0);
  const fallbackText = getFallbackTextForState(candidate.state, data, normalizedGreetingIndex);
  const hasText =
    typeof candidate.currentText === "string" && candidate.currentText.trim().length > 0;

  return {
    version: Number(candidate.version || ONBOARDING_RESUME_VERSION),
    updatedAt: Number(candidate.updatedAt || Date.now()),
    state: candidate.state,
    currentText: hasText ? candidate.currentText! : fallbackText,
    greetingIndex: normalizedGreetingIndex,
    showInput: requiredUi.showInput || !!candidate.showInput,
    showProviders: requiredUi.showProviders || !!candidate.showProviders,
    showApiInput: requiredUi.showApiInput || !!candidate.showApiInput,
    showStyleImplications: !!candidate.showStyleImplications,
    showPersonaOptions: requiredUi.showPersonaOptions || !!candidate.showPersonaOptions,
    showVoiceOptions: requiredUi.showVoiceOptions || !!candidate.showVoiceOptions,
    showOllamaDetection: requiredUi.showOllamaDetection || !!candidate.showOllamaDetection,
    styleCountdown: Number(candidate.styleCountdown || 0),
    testResult:
      candidate.testResult && typeof candidate.testResult === "object"
        ? {
            success: !!candidate.testResult.success,
            error:
              typeof candidate.testResult.error === "string"
                ? candidate.testResult.error
                : undefined,
          }
        : null,
    data,
  };
};

const loadResumeSnapshot = (): OnboardingResumeSnapshot | null => {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(ONBOARDING_RESUME_KEY);
    if (!raw) return null;

    const parsed = parseResumeSnapshot(JSON.parse(raw));
    if (!parsed) return null;
    if (parsed.version !== ONBOARDING_RESUME_VERSION) return null;
    if (Date.now() - parsed.updatedAt > ONBOARDING_RESUME_MAX_AGE_MS) return null;
    if (parsed.state === "dormant") {
      localStorage.removeItem(ONBOARDING_RESUME_KEY);
      return null;
    }
    if (parsed.state === "transitioning") return null;

    return parsed;
  } catch {
    return null;
  }
};

const persistResumeSnapshot = (snapshot: OnboardingResumeSnapshot): void => {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(ONBOARDING_RESUME_KEY, JSON.stringify(sanitizeResumeSnapshot(snapshot)));
  } catch {
    // Ignore persistence failures
  }
};

const clearResumeSnapshot = (): void => {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(ONBOARDING_RESUME_KEY);
  } catch {
    // Ignore cleanup failures
  }
};

export function useOnboardingFlow({ onComplete }: UseOnboardingOptions) {
  const [state, setState] = useState<OnboardingState>("dormant");
  const [currentText, setCurrentText] = useState("");
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [showInput, setShowInput] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
  const [showApiInput, setShowApiInput] = useState(false);
  const [showStyleImplications, setShowStyleImplications] = useState(false);
  const [showPersonaOptions, setShowPersonaOptions] = useState(false);
  const [showVoiceOptions, setShowVoiceOptions] = useState(false);
  const [showOllamaDetection, setShowOllamaDetection] = useState(false);
  const [styleCountdown, setStyleCountdown] = useState(0);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
  } | null>(null);

  const [data, setData] = useState<OnboardingData>(INITIAL_ONBOARDING_DATA);

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const startedRef = useRef(false);
  const canPersistRef = useRef(false);
  const styleCountdownIntervalRef = useRef<number | null>(null);
  const saveOnboardingSettingsRef = useRef<() => Promise<void>>(async () => {});

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      if (styleCountdownIntervalRef.current !== null) {
        window.clearInterval(styleCountdownIntervalRef.current);
      }
    };
  }, []);

  const clearPendingTransition = useCallback(() => {
    if (!timeoutRef.current) return;
    clearTimeout(timeoutRef.current);
    window.clearInterval(timeoutRef.current as unknown as number);
    timeoutRef.current = null;
  }, []);

  const clearStyleCountdownInterval = useCallback(() => {
    if (styleCountdownIntervalRef.current === null) return;
    window.clearInterval(styleCountdownIntervalRef.current);
    styleCountdownIntervalRef.current = null;
  }, []);

  const resetViewState = useCallback(() => {
    clearStyleCountdownInterval();
    setShowInput(false);
    setShowProviders(false);
    setShowApiInput(false);
    setShowStyleImplications(false);
    setShowPersonaOptions(false);
    setShowVoiceOptions(false);
    setShowOllamaDetection(false);
    setStyleCountdown(0);
    setTestResult(null);
  }, [clearStyleCountdownInterval]);

  const applyResumeState = useCallback((snapshot: OnboardingResumeSnapshot) => {
    setState(snapshot.state);
    setCurrentText(snapshot.currentText);
    setGreetingIndex(snapshot.greetingIndex);
    setShowInput(snapshot.showInput);
    setShowProviders(snapshot.showProviders);
    setShowApiInput(snapshot.showApiInput);
    setShowStyleImplications(snapshot.showStyleImplications);
    setShowPersonaOptions(snapshot.showPersonaOptions);
    setShowVoiceOptions(snapshot.showVoiceOptions);
    setShowOllamaDetection(snapshot.showOllamaDetection);
    setStyleCountdown(snapshot.styleCountdown);
    setTestResult(snapshot.testResult);
    setData(snapshot.data);
  }, []);

  // Helper to delay state transitions
  const delayedTransition = useCallback((nextState: OnboardingState, delay: number) => {
    timeoutRef.current = setTimeout(() => {
      setState(nextState);
    }, delay);
  }, []);

  // Start the onboarding
  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    clearPendingTransition();

    const snapshot = loadResumeSnapshot();
    if (snapshot) {
      applyResumeState(snapshot);
      canPersistRef.current = true;
      return;
    }

    resetViewState();
    setData(INITIAL_ONBOARDING_DATA);
    setCurrentText("");
    setGreetingIndex(0);
    setState("dormant");

    canPersistRef.current = true;
    // Small delay before awakening
    delayedTransition("awakening", 500);
  }, [applyResumeState, clearPendingTransition, delayedTransition, resetViewState]);

  // Failsafe: never remain in dormant after onboarding has started.
  useEffect(() => {
    if (!startedRef.current || state !== "dormant") return;

    const timer = setTimeout(() => {
      setState((prev) => (prev === "dormant" ? "awakening" : prev));
    }, 1400);

    return () => clearTimeout(timer);
  }, [state]);

  // Handle awakening animation complete
  const onAwakeningComplete = useCallback(() => {
    setState("greeting");
    setCurrentText(SCRIPT.greeting[0]);
    setGreetingIndex(0);
  }, []);

  // Handle typewriter complete for each state
  const onTextComplete = useCallback(() => {
    switch (state) {
      case "greeting":
        if (greetingIndex < SCRIPT.greeting.length - 1) {
          // Show next greeting line
          timeoutRef.current = setTimeout(() => {
            setGreetingIndex((i) => i + 1);
            setCurrentText(SCRIPT.greeting[greetingIndex + 1]);
          }, 800);
        } else {
          // Move to ask name
          timeoutRef.current = setTimeout(() => {
            setState("ask_name");
            setCurrentText(SCRIPT.ask_name);
            setShowInput(true);
          }, 1000);
        }
        break;

      case "confirm_name":
        timeoutRef.current = setTimeout(() => {
          setState("ask_persona");
          setCurrentText(SCRIPT.ask_persona);
          setShowPersonaOptions(true);
        }, 1200);
        break;

      case "confirm_persona":
        timeoutRef.current = setTimeout(() => {
          setState("ask_voice");
          setCurrentText(SCRIPT.ask_voice);
          setShowVoiceOptions(true);
        }, 1200);
        break;

      case "confirm_voice":
        timeoutRef.current = setTimeout(() => {
          setState("ask_work_style");
          setCurrentText(SCRIPT.ask_work_style);
          setShowInput(true);
        }, 1200);
        break;

      case "reflect_style":
        // Show implications after reflection text completes
        timeoutRef.current = setTimeout(() => {
          clearStyleCountdownInterval();
          setShowStyleImplications(true);
          setStyleCountdown(4);
        }, 800);
        break;

      case "confirm_memory_trust":
        timeoutRef.current = setTimeout(() => {
          setState("transition_setup");
          setCurrentText(SCRIPT.transition_setup);
        }, 1200);
        break;

      case "transition_setup":
        timeoutRef.current = setTimeout(() => {
          // Probe for local Ollama server before showing provider picker
          let settled = false;
          const settle = (
            models: Array<{ name: string; size: number; modified: string }> | null,
          ) => {
            if (settled) return;
            settled = true;
            if (models && models.length > 0) {
              // Pick most recently modified model (proxy for last used)
              const sorted = [...models].sort(
                (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
              );
              const recommended = sorted[0].name;
              setData((d) => ({ ...d, detectedOllamaModel: recommended }));
              setState("ollama_detected");
              setCurrentText(SCRIPT.ollama_detected(recommended));
              setShowOllamaDetection(true);
            } else {
              // No Ollama or no models — fall through to normal provider picker
              setState("llm_setup");
              setCurrentText(SCRIPT.llm_intro);
              setShowProviders(true);
            }
          };

          window.electronAPI
            .getOllamaModels()
            .then((m) => settle(m))
            .catch(() => settle(null));

          // 3-second timeout fallback
          setTimeout(() => settle(null), 3000);
        }, 1500);
        break;

      case "ollama_detected":
        // User must explicitly accept or decline — no auto-transition
        break;

      case "llm_confirmed":
        timeoutRef.current = setTimeout(() => {
          setState("recap");
          setCurrentText(SCRIPT.recap_intro(data.assistantName));
        }, 1000);
        break;

      case "completion":
        timeoutRef.current = setTimeout(() => {
          void (async () => {
            await saveOnboardingSettingsRef.current();
            setState("transitioning");
            clearResumeSnapshot();
            // Call onComplete after transition animation
            timeoutRef.current = setTimeout(() => {
              onComplete(true);
            }, 800);
          })();
        }, 1200);
        break;
    }
  }, [clearStyleCountdownInterval, state, greetingIndex, data.assistantName, onComplete]);

  // Handle user name input
  const submitName = useCallback((name: string) => {
    setShowInput(false);
    const trimmedName = name.trim();
    setData((d) => ({
      ...d,
      assistantName: trimmedName || "CoWork",
    }));
    setState("confirm_name");
    setCurrentText(SCRIPT.confirm_name(trimmedName));
  }, []);

  // Handle persona selection
  const submitPersona = useCallback((persona: PersonaId) => {
    setShowPersonaOptions(false);
    setData((d) => ({ ...d, persona }));
    setState("confirm_persona");
    setCurrentText(
      persona === "companion" ? SCRIPT.confirm_persona_companion : SCRIPT.confirm_persona_neutral,
    );

    if (window.electronAPI?.setActivePersona) {
      void window.electronAPI.setActivePersona(persona).catch((error) => {
        console.error("Failed to set persona during onboarding:", error);
      });
    }
  }, []);

  // Handle voice preference selection
  const submitVoicePreference = useCallback(async (enabled: boolean) => {
    setShowVoiceOptions(false);
    setData((d) => ({ ...d, voiceEnabled: enabled }));
    setState("confirm_voice");
    setCurrentText(enabled ? SCRIPT.confirm_voice_on : SCRIPT.confirm_voice_off);

    if (enabled && window.electronAPI?.saveVoiceSettings) {
      try {
        await window.electronAPI.saveVoiceSettings({
          enabled: true,
          responseMode: "auto",
        });
      } catch (error) {
        console.error("Failed to enable voice during onboarding:", error);
      }
    }
  }, []);

  // Handle work style selection
  const submitWorkStyle = useCallback((style: "planner" | "flexible") => {
    setShowInput(false);
    setShowStyleImplications(false);
    setStyleCountdown(0);
    setData((d) => ({ ...d, workStyle: style }));
    setState("reflect_style");
    setCurrentText(
      style === "planner" ? SCRIPT.reflect_style_planner : SCRIPT.reflect_style_flexible,
    );
  }, []);

  // Allow user to change work style before timeout
  const changeWorkStyle = useCallback(() => {
    // Clear any running countdown/timeout
    clearPendingTransition();
    clearStyleCountdownInterval();
    setShowStyleImplications(false);
    setStyleCountdown(0);
    setData((d) => ({ ...d, workStyle: null }));
    setState("ask_work_style");
    setCurrentText(SCRIPT.ask_work_style);
    setShowInput(true);
  }, [clearPendingTransition, clearStyleCountdownInterval]);

  const setMemoryTrustChoice = useCallback((enabled: boolean) => {
    setData((d) => ({ ...d, memoryEnabled: enabled }));
  }, []);

  const submitMemoryTrust = useCallback((enabled: boolean) => {
    setData((d) => ({ ...d, memoryEnabled: enabled }));
    setState("confirm_memory_trust");
    setCurrentText(enabled ? SCRIPT.confirm_memory_trust_on : SCRIPT.confirm_memory_trust_off);
  }, []);

  const continueFromRecap = useCallback(() => {
    setState("final_try");
    setCurrentText(SCRIPT.final_try_prompt(data.assistantName));
  }, [data.assistantName]);

  const completeOnboarding = useCallback(() => {
    setState("completion");
    setCurrentText(SCRIPT.completion(data.assistantName));
  }, [data.assistantName]);

  const editRecapSection = useCallback(
    (target: RecapEditTarget) => {
      clearPendingTransition();
      resetViewState();

      switch (target) {
        case "name":
          setState("ask_name");
          setCurrentText(SCRIPT.ask_name);
          setShowInput(true);
          return;

        case "persona":
          setState("ask_persona");
          setCurrentText(SCRIPT.ask_persona);
          setShowPersonaOptions(true);
          return;

        case "voice":
          setState("ask_voice");
          setCurrentText(SCRIPT.ask_voice);
          setShowVoiceOptions(true);
          return;

        case "style":
          setState("ask_work_style");
          setCurrentText(SCRIPT.ask_work_style);
          setShowInput(true);
          return;

        case "memory":
          setState("ask_memory_trust");
          setCurrentText(SCRIPT.ask_memory_trust);
          return;

        case "model":
          setState("llm_setup");
          setCurrentText(SCRIPT.llm_intro);
          setShowProviders(true);
          return;
      }
    },
    [clearPendingTransition, resetViewState],
  );

  const canGoBack = [
    "ask_name",
    "ask_persona",
    "ask_voice",
    "ask_work_style",
    "reflect_style",
    "ask_memory_trust",
    "ollama_detected",
    "llm_setup",
    "llm_api_key",
    "recap",
    "final_try",
  ].includes(state);

  const goBack = useCallback(() => {
    clearPendingTransition();
    clearStyleCountdownInterval();

    switch (state) {
      case "ask_name":
        setShowInput(false);
        setShowPersonaOptions(false);
        setShowVoiceOptions(false);
        setState("greeting");
        setGreetingIndex(SCRIPT.greeting.length - 1);
        setCurrentText(SCRIPT.greeting[SCRIPT.greeting.length - 1]);
        return;

      case "ask_persona":
        setShowPersonaOptions(false);
        setShowVoiceOptions(false);
        setShowInput(true);
        setState("ask_name");
        setCurrentText(SCRIPT.ask_name);
        return;

      case "ask_voice":
        setShowVoiceOptions(false);
        setShowInput(false);
        setShowPersonaOptions(true);
        setState("ask_persona");
        setCurrentText(SCRIPT.ask_persona);
        return;

      case "ask_work_style":
        setShowInput(false);
        setShowVoiceOptions(true);
        setShowPersonaOptions(false);
        setState("ask_voice");
        setCurrentText(SCRIPT.ask_voice);
        return;

      case "reflect_style":
        setShowProviders(false);
        setShowApiInput(false);
        setShowStyleImplications(false);
        setStyleCountdown(0);
        setShowInput(true);
        setState("ask_work_style");
        setCurrentText(SCRIPT.ask_work_style);
        return;

      case "ask_memory_trust":
        setState("ask_work_style");
        setCurrentText(SCRIPT.ask_work_style);
        setShowInput(true);
        return;

      case "ollama_detected":
        setShowOllamaDetection(false);
        setState("transition_setup");
        setCurrentText(SCRIPT.transition_setup);
        return;

      case "llm_setup":
        setShowProviders(false);
        setState("ask_memory_trust");
        setCurrentText(SCRIPT.ask_memory_trust);
        return;

      case "llm_api_key":
        setShowApiInput(false);
        setShowProviders(true);
        setTestResult(null);
        setState("llm_setup");
        setCurrentText(SCRIPT.llm_intro);
        return;

      case "recap":
        setShowProviders(true);
        setShowApiInput(false);
        setState("llm_setup");
        setCurrentText(SCRIPT.llm_intro);
        return;

      case "final_try":
        setState("recap");
        setCurrentText(SCRIPT.recap_intro(data.assistantName));
        return;
    }
  }, [clearPendingTransition, clearStyleCountdownInterval, data.assistantName, state]);

  // Get default model for a provider
  const getDefaultModel = useCallback((provider: LLMProviderType): string => {
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
        return "meta-llama/llama-3.1-8b-instruct:free";
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
  }, []);

  // Build test config for a provider
  const buildTestConfig = useCallback(
    (provider: LLMProviderType, apiKey: string) => {
      const testConfig: Record<string, unknown> = {
        providerType: provider,
      };

      if (provider === "anthropic") {
        testConfig.anthropic = { apiKey };
      } else if (provider === "openai") {
        testConfig.openai = { apiKey, authMethod: "api_key" };
      } else if (provider === "gemini") {
        testConfig.gemini = { apiKey };
      } else if (provider === "openrouter") {
        testConfig.openrouter = { apiKey };
      } else if (provider === "ollama") {
        testConfig.ollama = { baseUrl: data.ollamaUrl };
      } else if (provider === "groq") {
        testConfig.groq = { apiKey };
      } else if (provider === "xai") {
        testConfig.xai = { apiKey };
      } else if (provider === "kimi") {
        testConfig.kimi = { apiKey };
      }

      return testConfig;
    },
    [data.ollamaUrl],
  );

  // Build save settings for a provider
  const buildSaveSettings = useCallback(
    (provider: LLMProviderType, apiKey: string) => {
      const settings: Record<string, unknown> = {
        providerType: provider,
        modelKey: getDefaultModel(provider),
      };

      if (provider === "anthropic") {
        settings.anthropic = { apiKey };
      } else if (provider === "openai") {
        settings.openai = { apiKey, authMethod: "api_key", model: "gpt-4o-mini" };
      } else if (provider === "gemini") {
        settings.gemini = { apiKey, model: "gemini-2.0-flash" };
      } else if (provider === "openrouter") {
        settings.openrouter = { apiKey, model: "meta-llama/llama-3.1-8b-instruct:free" };
      } else if (provider === "ollama") {
        const model = data.detectedOllamaModel || "llama3.2";
        settings.ollama = { baseUrl: data.ollamaUrl, model };
      } else if (provider === "bedrock") {
        settings.bedrock = { region: "us-east-1", useDefaultCredentials: true };
      } else if (provider === "groq") {
        settings.groq = { apiKey, model: "llama-3.1-8b-instant" };
      } else if (provider === "xai") {
        settings.xai = { apiKey, model: "grok-4-fast-non-reasoning" };
      } else if (provider === "kimi") {
        settings.kimi = { apiKey, model: "kimi-k2.5" };
      }

      return settings;
    },
    [data.ollamaUrl, getDefaultModel],
  );

  // Handle provider selection
  const selectProvider = useCallback(
    async (provider: LLMProviderType) => {
      setData((d) => ({ ...d, selectedProvider: provider }));
      setCurrentText(SCRIPT.llm_selected(provider));

      // After showing the response, show API key input (except for Ollama/Bedrock)
      timeoutRef.current = setTimeout(async () => {
        if (provider === "ollama" || provider === "bedrock") {
          // For Ollama/Bedrock, skip API key and save settings directly
          setShowProviders(false);

          // Save settings for these providers
          const settings = buildSaveSettings(provider, "");
          try {
            await window.electronAPI.saveLLMSettings(settings);
            setState("llm_confirmed");
            setCurrentText(SCRIPT.llm_success);
          } catch {
            // Even if save fails, proceed to recap
            setState("recap");
            setCurrentText(SCRIPT.recap_intro(data.assistantName));
          }
        } else {
          setState("llm_api_key");
          setCurrentText(SCRIPT.llm_need_key);
          setShowApiInput(true);
        }
      }, 1500);
    },
    [buildSaveSettings, data.assistantName],
  );

  // Handle API key submission
  const submitApiKey = useCallback(
    async (key: string) => {
      setShowApiInput(false);
      setShowProviders(false);
      setData((d) => ({ ...d, apiKey: key }));
      setState("llm_testing");
      setCurrentText(SCRIPT.llm_testing);

      // Test the connection
      try {
        const testConfig = buildTestConfig(data.selectedProvider!, key);
        const result = await window.electronAPI.testLLMProvider(testConfig);

        if (result.success) {
          // Save the LLM settings
          const saveSettings = buildSaveSettings(data.selectedProvider!, key);
          await window.electronAPI.saveLLMSettings(saveSettings);

          setTestResult({ success: true });
          setState("llm_confirmed");
          setCurrentText(SCRIPT.llm_success);
        } else {
          setTestResult({ success: false, error: result.error });
          setCurrentText(SCRIPT.llm_error);
          setShowApiInput(true);
        }
      } catch (error) {
        setTestResult({
          success: false,
          error: error instanceof Error ? error.message : "Connection failed",
        });
        setCurrentText(SCRIPT.llm_error);
        setShowApiInput(true);
      }
    },
    [data.selectedProvider, buildTestConfig, buildSaveSettings],
  );

  // Accept auto-detected Ollama provider
  const acceptOllamaDetection = useCallback(async () => {
    setShowOllamaDetection(false);
    const modelName = data.detectedOllamaModel || "llama3.2";
    setData((d) => ({ ...d, selectedProvider: "ollama" }));
    setCurrentText(SCRIPT.llm_selected("ollama"));

    timeoutRef.current = setTimeout(async () => {
      const settings: Record<string, unknown> = {
        providerType: "ollama",
        modelKey: modelName,
        ollama: { baseUrl: data.ollamaUrl, model: modelName },
      };
      try {
        await window.electronAPI.saveLLMSettings(settings);
        setState("llm_confirmed");
        setCurrentText(SCRIPT.llm_success);
      } catch {
        setState("recap");
        setCurrentText(SCRIPT.recap_intro(data.assistantName));
      }
    }, 1500);
  }, [data.detectedOllamaModel, data.ollamaUrl, data.assistantName]);

  // Decline auto-detected Ollama — show normal provider picker
  const declineOllamaDetection = useCallback(() => {
    setShowOllamaDetection(false);
    setState("llm_setup");
    setCurrentText(SCRIPT.llm_intro);
    setShowProviders(true);
  }, []);

  // Skip LLM setup — default to OpenRouter with a free model so the app
  // has a provider pre-selected and users aren't pointed at paid-only services.
  const skipLLMSetup = useCallback(async () => {
    setShowProviders(false);
    setShowApiInput(false);
    setData((d) => ({ ...d, selectedProvider: "openrouter" }));

    const defaultSettings: Record<string, unknown> = {
      providerType: "openrouter",
      modelKey: "meta-llama/llama-3.1-8b-instruct:free",
      openrouter: { apiKey: "", model: "meta-llama/llama-3.1-8b-instruct:free" },
    };
    try {
      await window.electronAPI.saveLLMSettings(defaultSettings);
    } catch {
      // Best-effort — proceed to recap regardless
    }

    setState("recap");
    setCurrentText(SCRIPT.recap_intro(data.assistantName));
  }, [data.assistantName]);

  // Save onboarding choices to settings
  const saveOnboardingSettings = useCallback(async () => {
    const name = data.assistantName || "CoWork";
    try {
      // Save to AppearanceSettings (for backward compatibility)
      const currentAppearance = await window.electronAPI.getAppearanceSettings();
      await window.electronAPI.saveAppearanceSettings({
        ...currentAppearance,
        assistantName: name,
      });

      // Save to PersonalitySettings (primary location for agent identity)
      const currentPersonality = await window.electronAPI.getPersonalitySettings();
      await window.electronAPI.savePersonalitySettings({
        ...currentPersonality,
        agentName: name,
        workStyle: data.workStyle || undefined,
        activePersona: data.persona || currentPersonality.activePersona,
      });

      if (window.electronAPI?.saveVoiceSettings && data.voiceEnabled !== null) {
        await window.electronAPI.saveVoiceSettings({
          enabled: data.voiceEnabled,
          responseMode: "auto",
        });
      }

      if (
        window.electronAPI?.getMemoryFeaturesSettings &&
        window.electronAPI?.saveMemoryFeaturesSettings
      ) {
        const currentMemoryFeatures = await window.electronAPI.getMemoryFeaturesSettings();
        await window.electronAPI.saveMemoryFeaturesSettings({
          ...currentMemoryFeatures,
          contextPackInjectionEnabled: data.memoryEnabled,
          heartbeatMaintenanceEnabled: data.memoryEnabled
            ? currentMemoryFeatures.heartbeatMaintenanceEnabled
            : false,
        });
      }

      if (
        window.electronAPI?.listWorkspaces &&
        window.electronAPI?.getTempWorkspace &&
        window.electronAPI?.getMemorySettings &&
        window.electronAPI?.saveMemorySettings
      ) {
        const [workspaces, tempWorkspace] = await Promise.all([
          window.electronAPI.listWorkspaces().catch(() => []),
          window.electronAPI.getTempWorkspace().catch(() => null),
        ]);

        const workspaceIds = new Set<string>();
        for (const workspace of workspaces || []) {
          if (workspace?.id) workspaceIds.add(workspace.id);
        }
        if (tempWorkspace?.id) workspaceIds.add(tempWorkspace.id);

        await Promise.all(
          Array.from(workspaceIds).map(async (workspaceId) => {
            const currentMemorySettings = await window.electronAPI.getMemorySettings(workspaceId);
            const nextPrivacyMode = data.memoryEnabled
              ? currentMemorySettings.privacyMode === "disabled"
                ? "normal"
                : currentMemorySettings.privacyMode
              : "disabled";

            await window.electronAPI.saveMemorySettings({
              workspaceId,
              settings: {
                ...currentMemorySettings,
                enabled: data.memoryEnabled,
                autoCapture: data.memoryEnabled,
                privacyMode: nextPrivacyMode,
              },
            });
          }),
        );
      }
    } catch (error) {
      console.error("Failed to save onboarding settings:", error);
    }
  }, [data.assistantName, data.memoryEnabled, data.persona, data.voiceEnabled, data.workStyle]);

  useEffect(() => {
    saveOnboardingSettingsRef.current = saveOnboardingSettings;
  }, [saveOnboardingSettings]);

  // Persist resumable onboarding state
  useEffect(() => {
    if (!canPersistRef.current) return;

    if (state === "transitioning") {
      clearResumeSnapshot();
      return;
    }

    const snapshot: OnboardingResumeSnapshot = {
      version: ONBOARDING_RESUME_VERSION,
      updatedAt: Date.now(),
      state,
      currentText,
      greetingIndex,
      showInput,
      showProviders,
      showApiInput,
      showStyleImplications,
      showPersonaOptions,
      showVoiceOptions,
      showOllamaDetection,
      styleCountdown,
      testResult,
      data: {
        ...data,
        apiKey: "",
      },
    };

    persistResumeSnapshot(snapshot);
  }, [
    state,
    currentText,
    greetingIndex,
    showInput,
    showProviders,
    showApiInput,
    showStyleImplications,
    showPersonaOptions,
    showVoiceOptions,
    showOllamaDetection,
    styleCountdown,
    testResult,
    data,
  ]);

  // Resume style countdown reliably when restoring onboarding mid-step.
  useEffect(() => {
    if (state !== "reflect_style" || !showStyleImplications || styleCountdown <= 0) {
      clearStyleCountdownInterval();
      return;
    }

    if (styleCountdownIntervalRef.current !== null) {
      return;
    }

    styleCountdownIntervalRef.current = window.setInterval(() => {
      setStyleCountdown((prev) => {
        if (prev <= 1) {
          clearStyleCountdownInterval();
          setShowStyleImplications(false);
          setState("ask_memory_trust");
          setCurrentText(SCRIPT.ask_memory_trust);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [clearStyleCountdownInterval, showStyleImplications, state, styleCountdown]);

  // Self-heal stale resume snapshots that may miss required text or step UI flags.
  useEffect(() => {
    if (state === "dormant" || state === "transitioning") return;

    const requiredUi = getRequiredUiForState(state);
    const fallbackText = getFallbackTextForState(state, data, greetingIndex);

    if (!currentText && fallbackText) {
      setCurrentText(fallbackText);
    }
    if (requiredUi.showInput && !showInput) {
      setShowInput(true);
    }
    if (requiredUi.showProviders && !showProviders) {
      setShowProviders(true);
    }
    if (requiredUi.showApiInput && !showApiInput) {
      setShowApiInput(true);
    }
    if (requiredUi.showPersonaOptions && !showPersonaOptions) {
      setShowPersonaOptions(true);
    }
    if (requiredUi.showVoiceOptions && !showVoiceOptions) {
      setShowVoiceOptions(true);
    }
    if (requiredUi.showOllamaDetection && !showOllamaDetection) {
      setShowOllamaDetection(true);
    }
  }, [
    state,
    data,
    greetingIndex,
    currentText,
    showInput,
    showProviders,
    showApiInput,
    showPersonaOptions,
    showVoiceOptions,
    showOllamaDetection,
  ]);

  return {
    // State
    state,
    currentText,
    showInput,
    showProviders,
    showApiInput,
    showStyleImplications,
    showPersonaOptions,
    showVoiceOptions,
    showOllamaDetection,
    styleCountdown,
    testResult,
    data,

    // Actions
    start,
    onAwakeningComplete,
    onTextComplete,
    submitName,
    submitPersona,
    submitVoicePreference,
    submitWorkStyle,
    changeWorkStyle,
    setMemoryTrustChoice,
    submitMemoryTrust,
    continueFromRecap,
    completeOnboarding,
    editRecapSection,
    updateData: (updates: Partial<OnboardingData>) => setData((d) => ({ ...d, ...updates })),
    canGoBack,
    goBack,
    selectProvider,
    submitApiKey,
    skipLLMSetup,
    acceptOllamaDetection,
    declineOllamaDetection,

    // Update functions
    setApiKey: (key: string) => setData((d) => ({ ...d, apiKey: key })),
    setOllamaUrl: (url: string) => setData((d) => ({ ...d, ollamaUrl: url })),
  };
}

export { SCRIPT };
export default useOnboardingFlow;
