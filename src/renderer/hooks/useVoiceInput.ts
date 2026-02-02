import { useState, useRef, useCallback } from 'react';

export type VoiceInputState = 'idle' | 'recording' | 'processing';

interface UseVoiceInputOptions {
  /** Callback when transcription is complete */
  onTranscript?: (text: string) => void;
  /** Callback on error */
  onError?: (error: string) => void;
  /** Auto-stop recording after this many milliseconds (default: 30000) */
  maxDuration?: number;
}

interface UseVoiceInputReturn {
  /** Current state of voice input */
  state: VoiceInputState;
  /** Whether voice input is available (has microphone permission) */
  isAvailable: boolean;
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
  const { onTranscript, onError, maxDuration = 30000 } = options;

  const [state, setState] = useState<VoiceInputState>('idle');
  const [isAvailable, setIsAvailable] = useState(true);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

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
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;

    // Stop stream tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Reset analyser
    analyserRef.current = null;
    audioChunksRef.current = [];
    setAudioLevel(0);
  }, []);

  const updateAudioLevel = useCallback(() => {
    if (!analyserRef.current) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    // Calculate average volume
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const level = Math.min(100, (average / 128) * 100);
    setAudioLevel(level);

    if (state === 'recording') {
      animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
    }
  }, [state]);

  const startRecording = useCallback(async () => {
    if (state !== 'idle') return;

    setError(null);
    audioChunksRef.current = [];

    try {
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
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Create media recorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

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
          setState('idle');
          return;
        }

        setState('processing');

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
          const errorMessage = err instanceof Error ? err.message : 'Transcription failed';
          setError(errorMessage);
          onError?.(errorMessage);
        } finally {
          cleanup();
          setState('idle');
        }
      };

      mediaRecorder.onerror = () => {
        const errorMessage = 'Recording error occurred';
        setError(errorMessage);
        onError?.(errorMessage);
        cleanup();
        setState('idle');
      };

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      setState('recording');

      // Start audio level updates
      updateAudioLevel();

      // Auto-stop after max duration
      timeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, maxDuration);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to access microphone';
      setError(errorMessage);
      onError?.(errorMessage);
      setIsAvailable(false);
      cleanup();
      setState('idle');
    }
  }, [state, maxDuration, onTranscript, onError, cleanup, updateAudioLevel]);

  const stopRecording = useCallback(() => {
    if (state !== 'recording' || !mediaRecorderRef.current) return;

    if (mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, [state]);

  const cancelRecording = useCallback(() => {
    if (state !== 'recording') return;

    // Clear chunks so onstop doesn't process them
    audioChunksRef.current = [];
    cleanup();
    setState('idle');
  }, [state, cleanup]);

  const toggleRecording = useCallback(async () => {
    if (state === 'idle') {
      await startRecording();
    } else if (state === 'recording') {
      stopRecording();
    }
    // If processing, do nothing
  }, [state, startRecording, stopRecording]);

  return {
    state,
    isAvailable,
    startRecording,
    stopRecording,
    cancelRecording,
    toggleRecording,
    audioLevel,
    error,
  };
}
