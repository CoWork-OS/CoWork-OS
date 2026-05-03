import { useState, useCallback, useEffect, useRef } from "react";
import type { LLMProviderType, LLMSettingsData, PersonaId } from "../../shared/types";
import {
  deriveOnboardingPersonalityPreset,
  deriveOnboardingPersona,
  deriveResponseStylePreferences,
  type OnboardingAssistantTraitId,
  type OnboardingPriorityId,
  type OnboardingResponseStyleId,
  type OnboardingTimeDrainId,
} from "../../shared/onboarding";

// Onboarding conversation states
export type OnboardingState =
  | "dormant"
  | "awakening"
  | "greeting"
  | "ask_name"
  | "confirm_name"
  | "ask_assistant_traits"
  | "confirm_assistant_traits"
  | "ask_user_profile"
  | "confirm_user_profile"
  | "ask_time_drains"
  | "confirm_time_drains"
  | "ask_priorities"
  | "confirm_priorities"
  | "ask_tools"
  | "confirm_tools"
  | "ask_response_style"
  | "confirm_response_style"
  | "ask_additional_guidance"
  | "confirm_additional_guidance"
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
  ask_assistant_traits: "What kind of assistant do you want me to be? Pick what fits.",
  confirm_assistant_traits:
    "Good. I have the shape of the role now. Let me understand who I'm working with.",
  ask_user_profile:
    "Tell me about you. What's your name, and what kind of work or pressure fills most of your day?",
  confirm_user_profile:
    "Perfect. That gives me enough context to stop being generic and start being useful.",
  ask_time_drains:
    "Where does your time disappear most often? Pick the things that actually drag on your day.",
  confirm_time_drains:
    "Good. Those are exactly the kinds of bottlenecks I should be paying attention to.",
  ask_priorities:
    "Given what you told me, what do you want the most help with first? Pick your top priorities.",
  confirm_priorities:
    "Perfect. That's concrete enough to optimize around from the start.",
  ask_tools:
    "What apps or tools are central to your workflow? Include anything I should treat like home base.",
  confirm_tools:
    "Good. I'll treat that stack as your working surface instead of starting from scratch each time.",
  ask_response_style: "How do you like your responses?",
  confirm_response_style:
    "Understood. I'll keep that response shape consistent unless the task clearly needs otherwise.",
  ask_additional_guidance:
    "One last thing before setup: is there anything you'd always want me to keep in mind?",
  confirm_additional_guidance:
    "Good. I'll carry that forward as part of how I operate with you.",
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
      deepseek: "DeepSeek. Practical and cost-efficient.",
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
  save_error:
    "I couldn't save your onboarding setup cleanly. Review the recap and try entering CoWork again.",
};

interface UseOnboardingOptions {
  onComplete: (dontShowAgain: boolean) => void;
  workspaceId?: string | null;
}

interface OnboardingData {
  assistantName: string;
  persona: PersonaId;
  assistantTraits: OnboardingAssistantTraitId[];
  userName: string;
  userContext: string;
  timeDrains: OnboardingTimeDrainId[];
  timeDrainsOther: string;
  priorities: OnboardingPriorityId[];
  prioritiesOther: string;
  workflowTools: string;
  responseStyle: OnboardingResponseStyleId | null;
  responseStyleCustom: string;
  additionalGuidance: string;
  voiceEnabled: boolean | null;
  workStyle: "planner" | "flexible" | null;
  memoryEnabled: boolean;
  selectedProvider: LLMProviderType | null;
  apiKey: string;
  ollamaUrl: string;
  detectedOllamaModel: string | null;
}

type RecapEditTarget =
  | "name"
  | "assistant_traits"
  | "user_profile"
  | "time_drains"
  | "priorities"
  | "tools"
  | "response_style"
  | "guidance"
  | "voice"
  | "style"
  | "memory"
  | "model";

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

interface OnboardingSaveResult {
  success: boolean;
  error?: string;
}

const INITIAL_ONBOARDING_DATA: OnboardingData = {
  assistantName: "",
  persona: "companion",
  assistantTraits: ["adaptive"],
  userName: "",
  userContext: "",
  timeDrains: [],
  timeDrainsOther: "",
  priorities: [],
  prioritiesOther: "",
  workflowTools: "",
  responseStyle: "depends",
  responseStyleCustom: "",
  additionalGuidance: "",
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
  "ask_assistant_traits",
  "confirm_assistant_traits",
  "ask_user_profile",
  "confirm_user_profile",
  "ask_time_drains",
  "confirm_time_drains",
  "ask_priorities",
  "confirm_priorities",
  "ask_tools",
  "confirm_tools",
  "ask_response_style",
  "confirm_response_style",
  "ask_additional_guidance",
  "confirm_additional_guidance",
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
    case "ask_assistant_traits":
      return SCRIPT.ask_assistant_traits;
    case "confirm_assistant_traits":
      return SCRIPT.confirm_assistant_traits;
    case "ask_user_profile":
      return SCRIPT.ask_user_profile;
    case "confirm_user_profile":
      return SCRIPT.confirm_user_profile;
    case "ask_time_drains":
      return SCRIPT.ask_time_drains;
    case "confirm_time_drains":
      return SCRIPT.confirm_time_drains;
    case "ask_priorities":
      return SCRIPT.ask_priorities;
    case "confirm_priorities":
      return SCRIPT.confirm_priorities;
    case "ask_tools":
      return SCRIPT.ask_tools;
    case "confirm_tools":
      return SCRIPT.confirm_tools;
    case "ask_response_style":
      return SCRIPT.ask_response_style;
    case "confirm_response_style":
      return SCRIPT.confirm_response_style;
    case "ask_additional_guidance":
      return SCRIPT.ask_additional_guidance;
    case "confirm_additional_guidance":
      return SCRIPT.confirm_additional_guidance;
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
  showPersonaOptions: false,
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
    ...candidate.data,
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

export function useOnboardingFlow({ onComplete, workspaceId }: UseOnboardingOptions) {
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
  const saveOnboardingSettingsRef = useRef<() => Promise<OnboardingSaveResult>>(async () => ({
    success: false,
    error: SCRIPT.save_error,
  }));
  const asyncMutationTokenRef = useRef(0);

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

  const beginAsyncMutation = useCallback(() => {
    asyncMutationTokenRef.current += 1;
    return asyncMutationTokenRef.current;
  }, []);

  const invalidateAsyncMutations = useCallback(() => {
    asyncMutationTokenRef.current += 1;
  }, []);

  const isActiveAsyncMutation = useCallback((token: number) => {
    return asyncMutationTokenRef.current === token;
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
          setState("ask_assistant_traits");
          setCurrentText(SCRIPT.ask_assistant_traits);
        }, 1200);
        break;

      case "confirm_assistant_traits":
        timeoutRef.current = setTimeout(() => {
          setState("ask_user_profile");
          setCurrentText(SCRIPT.ask_user_profile);
        }, 1200);
        break;

      case "confirm_user_profile":
        timeoutRef.current = setTimeout(() => {
          setState("ask_time_drains");
          setCurrentText(SCRIPT.ask_time_drains);
        }, 1200);
        break;

      case "confirm_time_drains":
        timeoutRef.current = setTimeout(() => {
          setState("ask_priorities");
          setCurrentText(SCRIPT.ask_priorities);
        }, 1200);
        break;

      case "confirm_priorities":
        timeoutRef.current = setTimeout(() => {
          setState("ask_tools");
          setCurrentText(SCRIPT.ask_tools);
        }, 1200);
        break;

      case "confirm_tools":
        timeoutRef.current = setTimeout(() => {
          setState("ask_response_style");
          setCurrentText(SCRIPT.ask_response_style);
        }, 1200);
        break;

      case "confirm_response_style":
        timeoutRef.current = setTimeout(() => {
          setState("ask_additional_guidance");
          setCurrentText(SCRIPT.ask_additional_guidance);
        }, 1200);
        break;

      case "confirm_additional_guidance":
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
        {
          const mutationToken = beginAsyncMutation();
          timeoutRef.current = setTimeout(() => {
            // Probe for local Ollama server before showing provider picker
            let settled = false;
            const settle = (
              models: Array<{ name: string; size: number; modified: string }> | null,
            ) => {
              if (settled) return;
              if (!isActiveAsyncMutation(mutationToken)) return;
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
        }
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
        {
          const mutationToken = beginAsyncMutation();
          timeoutRef.current = setTimeout(() => {
            if (!isActiveAsyncMutation(mutationToken)) {
              return;
            }
            void (async () => {
              const result = await saveOnboardingSettingsRef.current();
              if (!isActiveAsyncMutation(mutationToken)) {
                return;
              }
              if (!result.success) {
                resetViewState();
                setState("recap");
                setCurrentText(result.error || SCRIPT.save_error);
                return;
              }
              setState("transitioning");
              clearResumeSnapshot();
              // Call onComplete after transition animation
              timeoutRef.current = setTimeout(() => {
                if (!isActiveAsyncMutation(mutationToken)) {
                  return;
                }
                onComplete(true);
              }, 800);
            })();
          }, 1200);
        }
        break;
    }
  }, [
    beginAsyncMutation,
    clearStyleCountdownInterval,
    data.assistantName,
    greetingIndex,
    isActiveAsyncMutation,
    onComplete,
    resetViewState,
    state,
  ]);

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

  const submitAssistantTraits = useCallback((traits: OnboardingAssistantTraitId[]) => {
    const normalizedTraits =
      traits.length > 0 ? Array.from(new Set(traits)) : INITIAL_ONBOARDING_DATA.assistantTraits;
    const nextPersona = deriveOnboardingPersona({
      ...INITIAL_ONBOARDING_DATA,
      ...data,
      assistantTraits: normalizedTraits,
    });

    setData((d) => ({
      ...d,
      assistantTraits: normalizedTraits,
      persona: nextPersona,
    }));
    setState("confirm_assistant_traits");
    setCurrentText(SCRIPT.confirm_assistant_traits);

    if (window.electronAPI?.setActivePersona) {
      void window.electronAPI.setActivePersona(nextPersona).catch((error) => {
        console.error("Failed to set persona during onboarding:", error);
      });
    }
  }, [data]);

  const submitUserProfile = useCallback((userName: string, userContext: string) => {
    setData((d) => ({
      ...d,
      userName: userName.trim(),
      userContext: userContext.trim(),
    }));
    setState("confirm_user_profile");
    setCurrentText(SCRIPT.confirm_user_profile);
  }, []);

  const submitTimeDrains = useCallback((timeDrains: OnboardingTimeDrainId[], other: string) => {
    setData((d) => ({
      ...d,
      timeDrains: Array.from(new Set(timeDrains)),
      timeDrainsOther: other.trim(),
    }));
    setState("confirm_time_drains");
    setCurrentText(SCRIPT.confirm_time_drains);
  }, []);

  const submitPriorities = useCallback((priorities: OnboardingPriorityId[], other: string) => {
    setData((d) => ({
      ...d,
      priorities: Array.from(new Set(priorities)),
      prioritiesOther: other.trim(),
    }));
    setState("confirm_priorities");
    setCurrentText(SCRIPT.confirm_priorities);
  }, []);

  const submitWorkflowTools = useCallback((workflowTools: string) => {
    setData((d) => ({
      ...d,
      workflowTools: workflowTools.trim(),
    }));
    setState("confirm_tools");
    setCurrentText(SCRIPT.confirm_tools);
  }, []);

  const submitResponseStyle = useCallback(
    (responseStyle: OnboardingResponseStyleId, customResponseStyle = "") => {
      setData((d) => ({
        ...d,
        responseStyle,
        responseStyleCustom: customResponseStyle.trim(),
      }));
      setState("confirm_response_style");
      setCurrentText(SCRIPT.confirm_response_style);
    },
    [],
  );

  const submitAdditionalGuidance = useCallback((additionalGuidance: string) => {
    setData((d) => ({
      ...d,
      additionalGuidance: additionalGuidance.trim(),
    }));
    setState("confirm_additional_guidance");
    setCurrentText(SCRIPT.confirm_additional_guidance);
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
    invalidateAsyncMutations();
    clearStyleCountdownInterval();
    setShowStyleImplications(false);
    setStyleCountdown(0);
    setData((d) => ({ ...d, workStyle: null }));
    setState("ask_work_style");
    setCurrentText(SCRIPT.ask_work_style);
    setShowInput(true);
  }, [clearPendingTransition, clearStyleCountdownInterval, invalidateAsyncMutations]);

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

  const exitOnboarding = useCallback(() => {
    clearPendingTransition();
    invalidateAsyncMutations();
    clearStyleCountdownInterval();
    resetViewState();
    clearResumeSnapshot();
    setState("transitioning");
    timeoutRef.current = setTimeout(() => {
      onComplete(true);
    }, 250);
  }, [
    clearPendingTransition,
    clearStyleCountdownInterval,
    invalidateAsyncMutations,
    onComplete,
    resetViewState,
  ]);

  const editRecapSection = useCallback(
    (target: RecapEditTarget) => {
      clearPendingTransition();
      invalidateAsyncMutations();
      resetViewState();

      switch (target) {
        case "name":
          setState("ask_name");
          setCurrentText(SCRIPT.ask_name);
          setShowInput(true);
          return;

        case "assistant_traits":
          setState("ask_assistant_traits");
          setCurrentText(SCRIPT.ask_assistant_traits);
          return;

        case "user_profile":
          setState("ask_user_profile");
          setCurrentText(SCRIPT.ask_user_profile);
          return;

        case "time_drains":
          setState("ask_time_drains");
          setCurrentText(SCRIPT.ask_time_drains);
          return;

        case "priorities":
          setState("ask_priorities");
          setCurrentText(SCRIPT.ask_priorities);
          return;

        case "tools":
          setState("ask_tools");
          setCurrentText(SCRIPT.ask_tools);
          return;

        case "response_style":
          setState("ask_response_style");
          setCurrentText(SCRIPT.ask_response_style);
          return;

        case "guidance":
          setState("ask_additional_guidance");
          setCurrentText(SCRIPT.ask_additional_guidance);
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
    [clearPendingTransition, invalidateAsyncMutations, resetViewState],
  );

  const canGoBack = [
    "ask_name",
    "ask_assistant_traits",
    "ask_user_profile",
    "ask_time_drains",
    "ask_priorities",
    "ask_tools",
    "ask_response_style",
    "ask_additional_guidance",
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
    invalidateAsyncMutations();
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

      case "ask_assistant_traits":
        setState("ask_name");
        setCurrentText(SCRIPT.ask_name);
        setShowInput(true);
        return;

      case "ask_user_profile":
        setState("ask_assistant_traits");
        setCurrentText(SCRIPT.ask_assistant_traits);
        return;

      case "ask_time_drains":
        setState("ask_user_profile");
        setCurrentText(SCRIPT.ask_user_profile);
        return;

      case "ask_priorities":
        setState("ask_time_drains");
        setCurrentText(SCRIPT.ask_time_drains);
        return;

      case "ask_tools":
        setState("ask_priorities");
        setCurrentText(SCRIPT.ask_priorities);
        return;

      case "ask_response_style":
        setState("ask_tools");
        setCurrentText(SCRIPT.ask_tools);
        return;

      case "ask_additional_guidance":
        setState("ask_response_style");
        setCurrentText(SCRIPT.ask_response_style);
        return;

      case "ask_voice":
        setShowVoiceOptions(false);
        setShowInput(false);
        setState("ask_additional_guidance");
        setCurrentText(SCRIPT.ask_additional_guidance);
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
  }, [
    clearPendingTransition,
    clearStyleCountdownInterval,
    data.assistantName,
    invalidateAsyncMutations,
    state,
  ]);

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
        return "openrouter/free";
      case "bedrock":
        return "sonnet-4-6";
      case "groq":
        return "llama-3.1-8b-instant";
      case "xai":
        return "grok-4-fast-non-reasoning";
      case "deepseek":
        return "deepseek-chat";
      case "kimi":
        return "kimi-k2.5";
      default:
        return "sonnet-4";
    }
  }, []);

  const loadExistingLlmSettings = useCallback(async (): Promise<LLMSettingsData | null> => {
    try {
      return await window.electronAPI.getLLMSettings();
    } catch {
      return null;
    }
  }, []);

  const getConfiguredModelForProvider = useCallback(
    (provider: LLMProviderType, existingSettings?: LLMSettingsData | null): string => {
      if (!existingSettings) {
        if (provider === "ollama" && data.detectedOllamaModel) {
          return data.detectedOllamaModel;
        }
        return getDefaultModel(provider);
      }

      let currentModel: string | undefined;
      switch (provider) {
        case "openai":
          currentModel = existingSettings.openai?.model;
          break;
        case "gemini":
          currentModel = existingSettings.gemini?.model;
          break;
        case "openrouter":
          currentModel = existingSettings.openrouter?.model;
          break;
        case "ollama":
          currentModel = existingSettings.ollama?.model;
          break;
        case "bedrock":
          currentModel = existingSettings.bedrock?.model;
          break;
        case "groq":
          currentModel = existingSettings.groq?.model;
          break;
        case "xai":
          currentModel = existingSettings.xai?.model;
          break;
        case "deepseek":
          currentModel = existingSettings.deepseek?.model;
          break;
        case "kimi":
          currentModel = existingSettings.kimi?.model;
          break;
        default:
          currentModel = undefined;
          break;
      }

      if (currentModel?.trim()) {
        return currentModel;
      }
      if (existingSettings.providerType === provider && existingSettings.modelKey?.trim()) {
        return existingSettings.modelKey;
      }
      if (provider === "ollama" && data.detectedOllamaModel) {
        return data.detectedOllamaModel;
      }
      return getDefaultModel(provider);
    },
    [data.detectedOllamaModel, getDefaultModel],
  );

  const providerHasSavedCredentials = useCallback(
    (provider: LLMProviderType, existingSettings?: LLMSettingsData | null): boolean => {
      if (!existingSettings) return false;

      switch (provider) {
        case "anthropic":
          return !!(
            existingSettings.anthropic?.apiKey || existingSettings.anthropic?.subscriptionToken
          );
        case "openai":
          return !!(
            existingSettings.openai?.apiKey ||
            existingSettings.openai?.accessToken ||
            existingSettings.openai?.refreshToken
          );
        case "gemini":
          return !!existingSettings.gemini?.apiKey;
        case "openrouter":
          return !!existingSettings.openrouter?.apiKey;
        case "groq":
          return !!existingSettings.groq?.apiKey;
        case "xai":
          return !!existingSettings.xai?.apiKey;
        case "deepseek":
          return !!existingSettings.deepseek?.apiKey;
        case "kimi":
          return !!existingSettings.kimi?.apiKey;
        default:
          return false;
      }
    },
    [],
  );

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
      } else if (provider === "deepseek") {
        testConfig.deepseek = { apiKey, model: "deepseek-chat" };
      } else if (provider === "kimi") {
        testConfig.kimi = { apiKey };
      }

      return testConfig;
    },
    [data.ollamaUrl],
  );

  // Build save settings for a provider
  const buildSaveSettings = useCallback(
    (
      provider: LLMProviderType,
      apiKey: string,
      existingSettings?: LLMSettingsData | null,
    ) => {
      const trimmedApiKey = apiKey.trim();
      const modelKey = getConfiguredModelForProvider(provider, existingSettings);
      const settings: Record<string, unknown> = {
        providerType: provider,
        modelKey,
      };

      if (provider === "anthropic") {
        const shouldUseApiKey =
          !!trimmedApiKey ||
          existingSettings?.anthropic?.authMethod === "api_key" ||
          !existingSettings?.anthropic?.subscriptionToken;
        const authMethod = shouldUseApiKey ? "api_key" : "subscription";
        settings.anthropic = {
          ...existingSettings?.anthropic,
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          authMethod,
        };
      } else if (provider === "openai") {
        settings.openai = {
          ...existingSettings?.openai,
          ...(trimmedApiKey ? { apiKey: trimmedApiKey, authMethod: "api_key" } : {}),
          model: modelKey,
        };
      } else if (provider === "gemini") {
        settings.gemini = {
          ...existingSettings?.gemini,
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          model: modelKey,
        };
      } else if (provider === "openrouter") {
        settings.openrouter = {
          ...existingSettings?.openrouter,
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          model: modelKey,
        };
      } else if (provider === "ollama") {
        settings.ollama = {
          ...existingSettings?.ollama,
          baseUrl: existingSettings?.ollama?.baseUrl || data.ollamaUrl,
          model: modelKey,
        };
      } else if (provider === "bedrock") {
        settings.bedrock = {
          ...existingSettings?.bedrock,
          region: existingSettings?.bedrock?.region || "us-east-1",
          useDefaultCredentials: existingSettings?.bedrock?.useDefaultCredentials ?? true,
          model: modelKey,
        };
      } else if (provider === "groq") {
        settings.groq = {
          ...existingSettings?.groq,
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          model: modelKey,
        };
      } else if (provider === "xai") {
        settings.xai = {
          ...existingSettings?.xai,
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          model: modelKey,
        };
      } else if (provider === "deepseek") {
        settings.deepseek = {
          ...existingSettings?.deepseek,
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          model: modelKey,
        };
      } else if (provider === "kimi") {
        settings.kimi = {
          ...existingSettings?.kimi,
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          model: modelKey,
        };
      }

      return settings;
    },
    [data.ollamaUrl, getConfiguredModelForProvider],
  );

  // Handle provider selection
  const selectProvider = useCallback(
    async (provider: LLMProviderType) => {
      clearPendingTransition();
      const mutationToken = beginAsyncMutation();
      setData((d) => ({ ...d, selectedProvider: provider }));
      setCurrentText(SCRIPT.llm_selected(provider));
      setTestResult(null);

      // After showing the response, show API key input (except for Ollama/Bedrock)
      timeoutRef.current = setTimeout(async () => {
        if (!isActiveAsyncMutation(mutationToken)) {
          return;
        }
        const existingSettings = await loadExistingLlmSettings();
        if (!isActiveAsyncMutation(mutationToken)) {
          return;
        }
        const shouldSkipCredentialPrompt =
          provider === "ollama" ||
          provider === "bedrock" ||
          providerHasSavedCredentials(provider, existingSettings);

        if (shouldSkipCredentialPrompt) {
          setShowProviders(false);
          setShowApiInput(false);
          setTestResult(null);

          const settings = buildSaveSettings(provider, "", existingSettings);
          try {
            if (!isActiveAsyncMutation(mutationToken)) {
              return;
            }
            await window.electronAPI.saveLLMSettings(settings);
            if (!isActiveAsyncMutation(mutationToken)) {
              return;
            }
            setState("llm_confirmed");
            setCurrentText(SCRIPT.llm_success);
          } catch {
            if (!isActiveAsyncMutation(mutationToken)) {
              return;
            }
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
    [
      beginAsyncMutation,
      buildSaveSettings,
      clearPendingTransition,
      data.assistantName,
      isActiveAsyncMutation,
      loadExistingLlmSettings,
      providerHasSavedCredentials,
    ],
  );

  // Handle API key submission
  const submitApiKey = useCallback(
    async (key: string) => {
      clearPendingTransition();
      const mutationToken = beginAsyncMutation();
      setShowApiInput(false);
      setShowProviders(false);
      setData((d) => ({ ...d, apiKey: key }));
      setState("llm_testing");
      setCurrentText(SCRIPT.llm_testing);

      // Test the connection
      try {
        const testConfig = buildTestConfig(data.selectedProvider!, key);
        const result = await window.electronAPI.testLLMProvider(testConfig);
        if (!isActiveAsyncMutation(mutationToken)) {
          return;
        }

        if (result.success) {
          // Save the LLM settings
          const existingSettings = await loadExistingLlmSettings();
          if (!isActiveAsyncMutation(mutationToken)) {
            return;
          }
          const saveSettings = buildSaveSettings(
            data.selectedProvider!,
            key,
            existingSettings,
          );
          if (!isActiveAsyncMutation(mutationToken)) {
            return;
          }
          await window.electronAPI.saveLLMSettings(saveSettings);
          if (!isActiveAsyncMutation(mutationToken)) {
            return;
          }

          setTestResult({ success: true });
          setState("llm_confirmed");
          setCurrentText(SCRIPT.llm_success);
        } else {
          if (!isActiveAsyncMutation(mutationToken)) {
            return;
          }
          setTestResult({ success: false, error: result.error });
          setCurrentText(SCRIPT.llm_error);
          setShowApiInput(true);
        }
      } catch (error) {
        if (!isActiveAsyncMutation(mutationToken)) {
          return;
        }
        setTestResult({
          success: false,
          error: error instanceof Error ? error.message : "Connection failed",
        });
        setCurrentText(SCRIPT.llm_error);
        setShowApiInput(true);
      }
    },
    [
      beginAsyncMutation,
      buildTestConfig,
      buildSaveSettings,
      clearPendingTransition,
      data.selectedProvider,
      isActiveAsyncMutation,
      loadExistingLlmSettings,
    ],
  );

  // Accept auto-detected Ollama provider
  const acceptOllamaDetection = useCallback(async () => {
    clearPendingTransition();
    const mutationToken = beginAsyncMutation();
    setShowOllamaDetection(false);
    const modelName = data.detectedOllamaModel || "llama3.2";
    setData((d) => ({ ...d, selectedProvider: "ollama" }));
    setCurrentText(SCRIPT.llm_selected("ollama"));

    timeoutRef.current = setTimeout(async () => {
      if (!isActiveAsyncMutation(mutationToken)) {
        return;
      }
      const existingSettings = await loadExistingLlmSettings();
      if (!isActiveAsyncMutation(mutationToken)) {
        return;
      }
      const settings = buildSaveSettings("ollama", "", {
        ...existingSettings,
        providerType: "ollama",
        modelKey: modelName,
        ollama: {
          ...existingSettings?.ollama,
          model: modelName,
        },
      });
      try {
        if (!isActiveAsyncMutation(mutationToken)) {
          return;
        }
        await window.electronAPI.saveLLMSettings(settings);
        if (!isActiveAsyncMutation(mutationToken)) {
          return;
        }
        setState("llm_confirmed");
        setCurrentText(SCRIPT.llm_success);
      } catch {
        if (!isActiveAsyncMutation(mutationToken)) {
          return;
        }
        setState("recap");
        setCurrentText(SCRIPT.recap_intro(data.assistantName));
      }
    }, 1500);
  }, [
    beginAsyncMutation,
    buildSaveSettings,
    clearPendingTransition,
    data.detectedOllamaModel,
    data.assistantName,
    isActiveAsyncMutation,
    loadExistingLlmSettings,
  ]);

  // Decline auto-detected Ollama — show normal provider picker
  const declineOllamaDetection = useCallback(() => {
    clearPendingTransition();
    invalidateAsyncMutations();
    setShowOllamaDetection(false);
    setState("llm_setup");
    setCurrentText(SCRIPT.llm_intro);
    setShowProviders(true);
  }, [clearPendingTransition, invalidateAsyncMutations]);

  // Skip LLM setup — default to OpenRouter with a free model so the app
  // has a provider pre-selected and users aren't pointed at paid-only services.
  const skipLLMSetup = useCallback(async () => {
    clearPendingTransition();
    const mutationToken = beginAsyncMutation();
    setShowProviders(false);
    setShowApiInput(false);
    setTestResult(null);

    const existingSettings = await loadExistingLlmSettings();
    if (!isActiveAsyncMutation(mutationToken)) {
      return;
    }

    const fallbackProvider: LLMProviderType =
      existingSettings?.providerType || "openrouter";
    const fallbackSettings =
      existingSettings?.providerType
        ? buildSaveSettings(fallbackProvider, "", existingSettings)
        : buildSaveSettings("openrouter", "", {
            ...existingSettings,
            providerType: "openrouter",
            modelKey: getDefaultModel("openrouter"),
            openrouter: {
              ...existingSettings?.openrouter,
              model: getDefaultModel("openrouter"),
            },
          });
    try {
      await window.electronAPI.saveLLMSettings(fallbackSettings);
    } catch {
      // Continue through onboarding recap even if the fallback save fails.
    }
    if (!isActiveAsyncMutation(mutationToken)) {
      return;
    }

    setData((d) => ({
      ...d,
      apiKey: "",
      selectedProvider: fallbackProvider,
    }));

    setState("recap");
    setCurrentText(SCRIPT.recap_intro(data.assistantName));
  }, [
    beginAsyncMutation,
    buildSaveSettings,
    clearPendingTransition,
    data.assistantName,
    getDefaultModel,
    isActiveAsyncMutation,
    loadExistingLlmSettings,
  ]);

  // Save onboarding choices to settings
  const saveOnboardingSettings = useCallback(async (): Promise<OnboardingSaveResult> => {
    const name = data.assistantName || "CoWork";
    const responseStyle = deriveResponseStylePreferences(data);
    const activePersona = deriveOnboardingPersona(data);
    const activePersonality = deriveOnboardingPersonalityPreset(data);
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
        activePersonality,
        agentName: name,
        workStyle: data.workStyle || undefined,
        activePersona,
        relationship: {
          ...currentPersonality.relationship,
          userName: data.userName.trim() || currentPersonality.relationship?.userName,
        },
        responseStyle,
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

        for (const targetWorkspaceId of Array.from(workspaceIds)) {
          const currentMemorySettings = await window.electronAPI.getMemorySettings(targetWorkspaceId);
          const nextPrivacyMode: typeof currentMemorySettings.privacyMode = data.memoryEnabled
            ? currentMemorySettings.privacyMode === "disabled"
              ? "normal"
              : currentMemorySettings.privacyMode
            : "disabled";
          const nextMemorySettings = {
            ...currentMemorySettings,
            enabled: data.memoryEnabled,
            autoCapture: data.memoryEnabled,
            privacyMode: nextPrivacyMode,
          };

          const isUnchanged =
            currentMemorySettings.enabled === nextMemorySettings.enabled &&
            currentMemorySettings.autoCapture === nextMemorySettings.autoCapture &&
            currentMemorySettings.privacyMode === nextMemorySettings.privacyMode;
          if (isUnchanged) continue;

          await window.electronAPI.saveMemorySettings({
            workspaceId: targetWorkspaceId,
            settings: nextMemorySettings,
          });
        }
      }

      if (workspaceId && window.electronAPI?.initWorkspaceKit && window.electronAPI?.applyOnboardingProfile) {
        await window.electronAPI.initWorkspaceKit({
          workspaceId,
          mode: "missing",
        });
        await window.electronAPI.applyOnboardingProfile({
          workspaceId,
          data,
        });
      } else if (window.electronAPI?.applyOnboardingProfile) {
        await window.electronAPI.applyOnboardingProfile({
          workspaceId: null,
          data,
        });
      }
      return { success: true };
    } catch (error) {
      console.error("Failed to save onboarding settings:", error);
      return {
        success: false,
        error: error instanceof Error && error.message.trim() ? error.message : SCRIPT.save_error,
      };
    }
  }, [data, workspaceId]);

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
    submitAssistantTraits,
    submitUserProfile,
    submitTimeDrains,
    submitPriorities,
    submitWorkflowTools,
    submitResponseStyle,
    submitAdditionalGuidance,
    submitVoicePreference,
    submitWorkStyle,
    changeWorkStyle,
    setMemoryTrustChoice,
    submitMemoryTrust,
    continueFromRecap,
    completeOnboarding,
    exitOnboarding,
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
