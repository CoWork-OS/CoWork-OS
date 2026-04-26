import { useState, useRef, useCallback, useEffect } from "react";

export type VoiceInputState = "idle" | "recording" | "processing";
type VoiceProvider = "elevenlabs" | "openai" | "azure" | "local";
type TranscriptionMode = "provider" | "local_preferred";

interface VoiceSettingsSnapshot {
  enabled: boolean;
  sttProvider: VoiceProvider;
  openaiApiKey?: string;
  azureApiKey?: string;
  azureEndpoint?: string;
  azureSttDeploymentName?: string;
  language?: string;
}

interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error?: string;
}

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

const getSpeechRecognitionCtor = (): BrowserSpeechRecognitionCtor | null => {
  const speechWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;
};

const isElectronRenderer = (): boolean => /Electron/i.test(navigator.userAgent);

const isLocalSpeechRecognitionSupported = (): boolean =>
  getSpeechRecognitionCtor() !== null && !isElectronRenderer();

const voiceNotConfiguredMessage = (): string =>
  isElectronRenderer()
    ? "Voice search needs OpenAI or Azure transcription configured in Settings > Voice."
    : "Voice transcription is not configured. Configure a speech-to-text provider in Settings > Voice.";

const LOCAL_RECOGNITION_FATAL_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
]);

const mapSpeechRecognitionError = (errorCode?: string): string => {
  switch (errorCode) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Enable microphone permission for this app, then try again.";
    case "audio-capture":
      return "No usable microphone was found. Check your input device and try again.";
    case "no-speech":
      return "No speech was detected. Try speaking again.";
    case "network":
      return "System speech recognition is unavailable in this desktop build. Configure OpenAI or Azure transcription in Settings > Voice.";
    case "aborted":
      return "Speech recognition was interrupted. Please try again.";
    default:
      return errorCode
        ? `Speech recognition error: ${errorCode}`
        : "Speech recognition error occurred";
  }
};

const mapMicrophoneAccessError = (error: unknown): string => {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return "Microphone access is blocked. Enable microphone permission for this app, then try again.";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "No microphone was detected. Connect a microphone and try again.";
    }
  }
  return error instanceof Error ? error.message : "Failed to access microphone";
};

const canUseRemoteTranscription = (settings: VoiceSettingsSnapshot): boolean => {
  switch (settings.sttProvider) {
    case "openai":
      return !!settings.openaiApiKey;
    case "azure":
      return !!(settings.azureApiKey && settings.azureEndpoint && settings.azureSttDeploymentName);
    case "elevenlabs":
      // ElevenLabs has no STT API, so we rely on OpenAI/Azure credentials.
      return (
        !!settings.openaiApiKey ||
        !!(settings.azureApiKey && settings.azureEndpoint && settings.azureSttDeploymentName)
      );
    case "local":
      return false;
    default:
      return false;
  }
};

const canUseConfiguredTranscription = (
  settings: VoiceSettingsSnapshot,
  localSupported: boolean,
): boolean => {
  if (!settings.enabled) {
    return false;
  }

  if (settings.sttProvider === "local") {
    return localSupported;
  }

  return canUseRemoteTranscription(settings);
};

interface UseVoiceInputOptions {
  /** Callback when transcription is complete */
  onTranscript?: (text: string) => void;
  /** Callback on error */
  onError?: (error: string) => void;
  /** Callback when voice is not configured (user clicks mic but settings not set up) */
  onNotConfigured?: () => void;
  /** Auto-stop recording after this many milliseconds (default: 30000) */
  maxDuration?: number;
  /** Transcription strategy */
  transcriptionMode?: TranscriptionMode;
}

interface UseVoiceInputReturn {
  /** Current state of voice input */
  state: VoiceInputState;
  /** Whether voice input is available (has microphone permission) */
  isAvailable: boolean;
  /** Whether voice settings are configured */
  isConfigured: boolean;
  /** Start recording */
  startRecording: () => Promise<void>;
  /** Stop recording and process */
  stopRecording: () => void;
  /** Cancel recording without processing */
  cancelRecording: () => void;
  /** Toggle recording (start if idle, stop if recording) */
  toggleRecording: () => Promise<void>;
  /** Audio level (0-100) for visualization */
  audioLevel: number;
  /** Error message if any */
  error: string | null;
}

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const {
    onTranscript,
    onError,
    onNotConfigured,
    maxDuration = 30000,
    transcriptionMode = "provider",
  } = options;

  const [state, setState] = useState<VoiceInputState>("idle");
  const [isAvailable, setIsAvailable] = useState(true);
  const [isConfigured, setIsConfigured] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const disableLocalRecognitionRef = useRef(false);
  const canFallbackToProviderRef = useRef(false);
  const localTranscriptRef = useRef<string[]>([]);
  const localDiscardRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const refreshVoiceConfiguration = useCallback(async (): Promise<VoiceSettingsSnapshot | null> => {
    try {
      const settings = (await window.electronAPI.getVoiceSettings()) as VoiceSettingsSnapshot;
      const normalized: VoiceSettingsSnapshot = {
        ...settings,
        sttProvider: settings.sttProvider || "openai",
      };

      const localSupported = isLocalSpeechRecognitionSupported();
      const configuredByProvider = canUseConfiguredTranscription(normalized, localSupported);
      const localUsable = localSupported && !disableLocalRecognitionRef.current;
      const configured =
        transcriptionMode === "local_preferred"
          ? localUsable || configuredByProvider
          : configuredByProvider;

      setIsConfigured(configured);
      setIsAvailable(true);
      return normalized;
    } catch {
      setIsConfigured(false);
      return null;
    }
  }, [transcriptionMode]);

  // Check if voice settings are configured on mount
  useEffect(() => {
    void refreshVoiceConfiguration();
  }, [refreshVoiceConfiguration]);

  const cleanup = useCallback(() => {
    // Stop animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // Clear timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    // Stop media recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;

    // Close analysis context
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    // Stop stream tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Stop local speech recognition
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }

    // Reset analyser
    analyserRef.current = null;
    audioChunksRef.current = [];
    localTranscriptRef.current = [];
    localDiscardRef.current = false;
    setAudioLevel(0);
  }, []);

  const startLocalRecognition = useCallback(
    (language: string) => {
      const RecognitionCtor = getSpeechRecognitionCtor();
      if (!RecognitionCtor) {
        throw new Error("System speech recognition is not available in this environment");
      }

      const recognition = new RecognitionCtor();
      localTranscriptRef.current = [];
      localDiscardRef.current = false;

      recognition.lang = language || "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal && result[0]?.transcript) {
            localTranscriptRef.current.push(result[0].transcript.trim());
          }
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        const errorCode = event?.error;
        const shouldFallbackToProvider =
          errorCode === "network" && canFallbackToProviderRef.current;
        const message = shouldFallbackToProvider
          ? "System speech recognition is unavailable. Tap the mic again to use provider transcription."
          : mapSpeechRecognitionError(errorCode);

        if (errorCode === "not-allowed" || errorCode === "service-not-allowed") {
          setIsAvailable(false);
        }

        if (shouldFallbackToProvider) {
          disableLocalRecognitionRef.current = true;
        }

        setError(message);
        onError?.(message);

        if (errorCode && LOCAL_RECOGNITION_FATAL_ERRORS.has(errorCode)) {
          localDiscardRef.current = true;
          cleanup();
          setState("idle");
        }
      };

      recognition.onend = () => {
        const discarded = localDiscardRef.current;
        const transcript = localTranscriptRef.current.join(" ").trim();

        recognitionRef.current = null;
        localTranscriptRef.current = [];
        localDiscardRef.current = false;
        setAudioLevel(0);

        if (!discarded && transcript) {
          onTranscript?.(transcript);
        }

        setState("idle");
      };

      recognitionRef.current = recognition;
      recognition.start();
      setState("recording");
    },
    [onError, onTranscript, cleanup],
  );

  const updateAudioLevel = useCallback(() => {
    if (!analyserRef.current) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    // Calculate average volume
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const level = Math.min(100, (average / 128) * 100);
    setAudioLevel(level);

    const isActiveCapture =
      recognitionRef.current !== null ||
      mediaRecorderRef.current?.state === "recording" ||
      state === "recording";

    if (isActiveCapture) {
      animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
    }
  }, [state]);

  const startRecording = useCallback(async () => {
    if (state !== "idle") return;

    setError(null);
    audioChunksRef.current = [];

    try {
      const settings = await refreshVoiceConfiguration();
      if (!settings) {
        const errorMessage = voiceNotConfiguredMessage();
        setError(errorMessage);
        onError?.(errorMessage);
        onNotConfigured?.();
        return;
      }

      const localSupported = isLocalSpeechRecognitionSupported();
      const providerConfigured = canUseConfiguredTranscription(settings, localSupported);
      canFallbackToProviderRef.current = providerConfigured;

      const useLocalPreferred =
        transcriptionMode === "local_preferred" &&
        localSupported &&
        !disableLocalRecognitionRef.current;
      const useConfiguredLocalProvider =
        settings.enabled && settings.sttProvider === "local" && localSupported;

      if (useLocalPreferred || useConfiguredLocalProvider) {
        // Warm up microphone permission explicitly so local recognition is less likely to fail with not-allowed.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 16000,
          },
        });
        streamRef.current = stream;

        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;
        updateAudioLevel();

        startLocalRecognition(settings.language || "en-US");
        return;
      }

      if (!providerConfigured) {
        const errorMessage = voiceNotConfiguredMessage();
        setError(errorMessage);
        onError?.(errorMessage);
        onNotConfigured?.();
        return;
      }

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;

      // Set up audio analyser for visualization
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Create media recorder
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (audioChunksRef.current.length === 0) {
          cleanup();
          setState("idle");
          return;
        }

        setState("processing");

        try {
          // Combine audio chunks into a single blob
          const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
          const arrayBuffer = await audioBlob.arrayBuffer();

          // Send to backend for transcription
          const result = await window.electronAPI.voiceTranscribe(arrayBuffer);

          if (result.error) {
            setError(result.error);
            onError?.(result.error);
          } else if (result.text) {
            onTranscript?.(result.text);
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : "Transcription failed";
          setError(errorMessage);
          onError?.(errorMessage);
        } finally {
          cleanup();
          setState("idle");
        }
      };

      mediaRecorder.onerror = () => {
        const errorMessage = "Recording error occurred";
        setError(errorMessage);
        onError?.(errorMessage);
        cleanup();
        setState("idle");
      };

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      setState("recording");

      // Start audio level updates
      updateAudioLevel();

      // Auto-stop after max duration
      timeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.stop();
        }
      }, maxDuration);
    } catch (err) {
      const errorMessage = mapMicrophoneAccessError(err);
      setError(errorMessage);
      onError?.(errorMessage);
      setIsAvailable(false);
      cleanup();
      setState("idle");
    }
  }, [
    state,
    maxDuration,
    onTranscript,
    onError,
    onNotConfigured,
    cleanup,
    updateAudioLevel,
    refreshVoiceConfiguration,
    startLocalRecognition,
    transcriptionMode,
  ]);

  const stopRecording = useCallback(() => {
    if (state !== "recording") return;

    if (recognitionRef.current) {
      setState("processing");
      try {
        recognitionRef.current.stop();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to stop speech recognition";
        setError(errorMessage);
        onError?.(errorMessage);
        cleanup();
        setState("idle");
      }
      return;
    }

    if (!mediaRecorderRef.current) return;

    if (mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, [state, cleanup, onError]);

  const cancelRecording = useCallback(() => {
    if (state !== "recording") return;

    if (recognitionRef.current) {
      localDiscardRef.current = true;
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
      localTranscriptRef.current = [];
      setAudioLevel(0);
      setState("idle");
      return;
    }

    // Clear chunks so onstop doesn't process them
    audioChunksRef.current = [];
    cleanup();
    setState("idle");
  }, [state, cleanup]);

  const toggleRecording = useCallback(async () => {
    if (state === "idle") {
      await startRecording();
    } else if (state === "recording") {
      stopRecording();
    }
    // If processing, do nothing
  }, [state, startRecording, stopRecording]);

  return {
    state,
    isAvailable,
    isConfigured,
    startRecording,
    stopRecording,
    cancelRecording,
    toggleRecording,
    audioLevel,
    error,
  };
}
