import { useState, useRef, useCallback, useEffect } from "react";
import { useVoiceInput } from "./useVoiceInput";
import { shouldSpeak, getTextForSpeech } from "../utils/voice-directives";

export type TalkModeState = "off" | "idle" | "listening" | "processing" | "speaking";

interface UseVoiceTalkModeOptions {
  /** Send a message as if the user typed it */
  onSendMessage: (text: string) => void;
  /** Callback when talk mode is toggled on/off */
  onToggle?: (active: boolean) => void;
  /** Callback when an error occurs */
  onError?: (error: string) => void;
}

interface UseVoiceTalkModeReturn {
  /** Current state of talk mode */
  state: TalkModeState;
  /** Whether talk mode is active (on) */
  isActive: boolean;
  /** Whether voice is configured and available */
  isAvailable: boolean;
  /** Toggle talk mode on/off */
  toggle: () => void;
  /** Stop talk mode */
  stop: () => void;
  /** Audio level (0-100) during listening */
  audioLevel: number;
  /** Last transcript received */
  lastTranscript: string | null;
  /** Current input mode from settings */
  inputMode: "push_to_talk" | "voice_activity" | "disabled";
}

// VAD constants
const VAD_SPEECH_THRESHOLD = 8; // audio level (0-100) above which we consider "speech"
const VAD_SILENCE_DURATION_MS = 2000; // how long silence before auto-stopping
const VAD_MIN_RECORDING_MS = 500; // minimum recording time before allowing silence-stop
const PTT_KEY_DEFAULT = "Space";

/**
 * Hook for continuous voice conversation mode ("Talk Mode").
 *
 * Supports two input modes:
 * - push_to_talk: Hold a key (default Space) to record, release to send
 * - voice_activity: Auto-detect speech start/end using audio level analysis
 *
 * Flow: Listen → Transcribe → Send message → Speak response → Listen again
 */
export function useVoiceTalkMode(options: UseVoiceTalkModeOptions): UseVoiceTalkModeReturn {
  const { onSendMessage, onToggle, onError } = options;

  const [isActive, setIsActive] = useState(false);
  const [talkState, setTalkState] = useState<TalkModeState>("off");
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<"push_to_talk" | "voice_activity" | "disabled">(
    "push_to_talk",
  );
  const [pushToTalkKey, setPushToTalkKey] = useState(PTT_KEY_DEFAULT);
  const [responseMode, setResponseMode] = useState<"auto" | "manual" | "smart">("auto");
  const [volume, setVolume] = useState(80);

  const isActiveRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const pttPressedRef = useRef(false);
  const vadSilenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const vadRecordingStartRef = useRef<number>(0);
  const vadStartedRef = useRef(false);
  const resumeAfterSpeakRef = useRef(false);

  // Load voice settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await window.electronAPI.getVoiceSettings();
        setInputMode(settings.inputMode || "push_to_talk");
        setPushToTalkKey(settings.pushToTalkKey || PTT_KEY_DEFAULT);
        setResponseMode(settings.responseMode || "auto");
        setVolume(settings.volume ?? 80);
      } catch {
        // Use defaults
      }
    };
    loadSettings();
  }, []);

  // Voice input hook - handles mic capture and transcription
  const voiceInput = useVoiceInput({
    onTranscript: useCallback(
      (text: string) => {
        if (!isActiveRef.current) return;

        setLastTranscript(text);

        if (text.trim()) {
          // Auto-send the transcript as a message
          onSendMessage(text.trim());
          setTalkState("processing");
        } else {
          // Empty transcript, go back to idle/listening
          setTalkState("idle");
        }
      },
      [onSendMessage],
    ),
    onError: useCallback(
      (error: string) => {
        onError?.(error);
        if (isActiveRef.current) {
          setTalkState("idle");
        }
      },
      [onError],
    ),
    maxDuration: 60000, // 60 second max for talk mode
  });

  // Listen for task completion / agent response to auto-speak
  useEffect(() => {
    if (!isActive) return;

    const unsubscribe = window.electronAPI.onVoiceEvent((event) => {
      if (event.type === "voice:speaking-end") {
        isSpeakingRef.current = false;
        if (isActiveRef.current && resumeAfterSpeakRef.current) {
          resumeAfterSpeakRef.current = false;
          setTalkState("idle");
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [isActive]);

  // Auto-speak agent responses when in talk mode
  useEffect(() => {
    if (!isActive) return;

    const unsubscribe = window.electronAPI.onTaskEvent?.((event: Any) => {
      if (!isActiveRef.current) return;
      if (event.type !== "completed" && event.type !== "message") return;

      const messageText = event.result || event.message || "";
      if (!messageText || typeof messageText !== "string") return;

      if (shouldSpeak(messageText, responseMode, true)) {
        const textToSpeak = getTextForSpeech(messageText);
        if (textToSpeak) {
          speakAndResume(textToSpeak);
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [isActive, responseMode]);

  const speakAndResume = useCallback(
    async (text: string) => {
      setTalkState("speaking");
      isSpeakingRef.current = true;
      resumeAfterSpeakRef.current = true;

      try {
        const result = await window.electronAPI.voiceSpeak(text);
        if (result.audioData) {
          // Play the audio in the renderer
          await playAudioData(result.audioData, volume / 100);
          await window.electronAPI.voiceStopSpeaking();
        }
      } catch (err) {
        console.error("[TalkMode] Failed to speak:", err);
      } finally {
        isSpeakingRef.current = false;
        if (isActiveRef.current) {
          resumeAfterSpeakRef.current = false;
          setTalkState("idle");
        }
      }
    },
    [volume],
  );

  // VAD: monitor audio levels for voice_activity mode
  useEffect(() => {
    if (!isActive || inputMode !== "voice_activity") return;
    if (talkState !== "idle" && talkState !== "listening") return;

    // In voice_activity mode when idle, we need to start the mic for VAD
    // but only record when speech is detected
    let vadCheckInterval: NodeJS.Timeout | null = null;

    const startVadMonitoring = async () => {
      if (talkState === "idle" && voiceInput.state === "idle") {
        // Start recording to get audio levels
        await voiceInput.startRecording();
        vadRecordingStartRef.current = Date.now();
        vadStartedRef.current = false;
        setTalkState("listening");
      }
    };

    // Monitor audio levels for speech detection
    vadCheckInterval = setInterval(() => {
      if (!isActiveRef.current || inputMode !== "voice_activity") return;

      const level = voiceInput.audioLevel;

      if (level > VAD_SPEECH_THRESHOLD) {
        // Speech detected
        vadStartedRef.current = true;
        if (vadSilenceTimerRef.current) {
          clearTimeout(vadSilenceTimerRef.current);
          vadSilenceTimerRef.current = null;
        }
      } else if (vadStartedRef.current) {
        // Silence after speech - start countdown
        const recordingDuration = Date.now() - vadRecordingStartRef.current;
        if (recordingDuration > VAD_MIN_RECORDING_MS && !vadSilenceTimerRef.current) {
          vadSilenceTimerRef.current = setTimeout(() => {
            if (isActiveRef.current && voiceInput.state === "recording") {
              voiceInput.stopRecording(); // Will trigger transcription
            }
            vadSilenceTimerRef.current = null;
          }, VAD_SILENCE_DURATION_MS);
        }
      }
    }, 100);

    startVadMonitoring();

    return () => {
      if (vadCheckInterval) clearInterval(vadCheckInterval);
      if (vadSilenceTimerRef.current) {
        clearTimeout(vadSilenceTimerRef.current);
        vadSilenceTimerRef.current = null;
      }
    };
  }, [isActive, inputMode, talkState, voiceInput]);

  // Push-to-talk keyboard handling
  useEffect(() => {
    if (!isActive || inputMode !== "push_to_talk") return;

    const normalizeKey = (key: string) => {
      if (key === " ") return "Space";
      return key;
    };

    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!isActiveRef.current) return;
      // Ignore if typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;

      if (normalizeKey(e.key) === pushToTalkKey && !pttPressedRef.current) {
        e.preventDefault();
        pttPressedRef.current = true;
        if (voiceInput.state === "idle") {
          setTalkState("listening");
          await voiceInput.startRecording();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return;

      if (normalizeKey(e.key) === pushToTalkKey && pttPressedRef.current) {
        e.preventDefault();
        pttPressedRef.current = false;
        if (voiceInput.state === "recording") {
          voiceInput.stopRecording(); // Will trigger transcription → onTranscript → send
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      pttPressedRef.current = false;
    };
  }, [isActive, inputMode, pushToTalkKey, voiceInput]);

  // Sync voiceInput state to talkState
  useEffect(() => {
    if (!isActive) return;

    if (voiceInput.state === "recording" && talkState !== "listening" && talkState !== "speaking") {
      setTalkState("listening");
    } else if (voiceInput.state === "processing") {
      setTalkState("processing");
    }
  }, [isActive, voiceInput.state, talkState]);

  const toggle = useCallback(() => {
    if (isActive) {
      // Turn off
      isActiveRef.current = false;
      setIsActive(false);
      setTalkState("off");
      setLastTranscript(null);
      pttPressedRef.current = false;
      resumeAfterSpeakRef.current = false;
      if (voiceInput.state === "recording") {
        voiceInput.cancelRecording();
      }
      onToggle?.(false);
    } else {
      // Turn on
      if (!voiceInput.isConfigured) {
        onError?.("Voice is not configured. Please set up voice in Settings.");
        return;
      }
      isActiveRef.current = true;
      setIsActive(true);
      setTalkState("idle");
      onToggle?.(true);
    }
  }, [isActive, voiceInput, onToggle, onError]);

  const stop = useCallback(() => {
    if (!isActive) return;
    isActiveRef.current = false;
    setIsActive(false);
    setTalkState("off");
    setLastTranscript(null);
    pttPressedRef.current = false;
    resumeAfterSpeakRef.current = false;
    if (voiceInput.state === "recording") {
      voiceInput.cancelRecording();
    }
    onToggle?.(false);
  }, [isActive, voiceInput, onToggle]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (vadSilenceTimerRef.current) {
        clearTimeout(vadSilenceTimerRef.current);
      }
    };
  }, []);

  return {
    state: talkState,
    isActive,
    isAvailable: voiceInput.isConfigured,
    toggle,
    stop,
    audioLevel: voiceInput.audioLevel,
    lastTranscript,
    inputMode,
  };
}

// ── Audio playback helper ───────────────────────────────────────────────────

function playAudioData(audioData: number[], volume: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const audioContext = new AudioContext();
      const uint8Array = new Uint8Array(audioData);
      audioContext.decodeAudioData(
        uint8Array.buffer.slice(0),
        (buffer) => {
          const source = audioContext.createBufferSource();
          const gainNode = audioContext.createGain();
          gainNode.gain.value = Math.max(0, Math.min(1, volume));
          source.buffer = buffer;
          source.connect(gainNode);
          gainNode.connect(audioContext.destination);
          source.onended = () => {
            audioContext.close().catch(() => {});
            resolve();
          };
          source.start(0);
        },
        (err) => {
          audioContext.close().catch(() => {});
          reject(err);
        },
      );
    } catch (err) {
      reject(err);
    }
  });
}
