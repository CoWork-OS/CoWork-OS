/**
 * Tests for VoiceService
 *
 * Tests the main process voice service that handles TTS/STT API calls.
 * Audio playback is handled by the renderer process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VoiceService, getVoiceService, resetVoiceService } from "../VoiceService";
import { DEFAULT_VOICE_SETTINGS } from "../../../shared/types";

// Mock fetch for API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock Blob class for Node.js environment
class MockBlob {
  parts: Any[];
  type: string;
  size: number;
  constructor(parts: Any[], options?: { type?: string }) {
    this.parts = parts;
    this.type = options?.type || "";
    this.size = parts.reduce(
      (acc: number, part: Any) => acc + (part.byteLength || part.length || 0),
      0,
    );
  }
}
// @ts-expect-error Mock Blob
global.Blob = MockBlob;

// Mock FormData for Node.js environment
class MockFormData {
  private data = new Map<string, Any>();
  append(key: string, value: Any, _filename?: string) {
    this.data.set(key, value);
  }
  get(key: string) {
    return this.data.get(key);
  }
}
// @ts-expect-error Mock FormData
global.FormData = MockFormData;

describe("VoiceService", () => {
  let service: VoiceService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceService();
    service = new VoiceService();
  });

  afterEach(() => {
    service.dispose();
  });

  describe("constructor", () => {
    it("should create with default settings", () => {
      expect(service.getSettings()).toEqual(DEFAULT_VOICE_SETTINGS);
    });

    it("should create with custom settings", () => {
      const customService = new VoiceService({
        settings: {
          enabled: true,
          volume: 50,
        },
      });
      const settings = customService.getSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.volume).toBe(50);
      customService.dispose();
    });

    it("should register onStateChange callback", () => {
      const callback = vi.fn();
      const serviceWithCallback = new VoiceService({ onStateChange: callback });

      // Trigger a state change
      serviceWithCallback.updateSettings({ enabled: true });

      expect(callback).toHaveBeenCalled();
      serviceWithCallback.dispose();
    });
  });

  describe("initialize", () => {
    it("should initialize without error", async () => {
      await expect(service.initialize()).resolves.not.toThrow();
    });

    it("should set isActive based on enabled setting", async () => {
      service.updateSettings({ enabled: true });
      await service.initialize();
      expect(service.getState().isActive).toBe(true);
    });

    it("should not be active when disabled", async () => {
      service.updateSettings({ enabled: false });
      await service.initialize();
      expect(service.getState().isActive).toBe(false);
    });
  });

  describe("updateSettings", () => {
    it("should update settings", () => {
      service.updateSettings({ volume: 75 });
      expect(service.getSettings().volume).toBe(75);
    });

    it("should emit settingsChange event", () => {
      const handler = vi.fn();
      service.on("settingsChange", handler);
      service.updateSettings({ speechRate: 1.5 });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ speechRate: 1.5 }));
    });

    it("should update isActive when enabled changes", () => {
      service.updateSettings({ enabled: true });
      expect(service.getState().isActive).toBe(true);

      service.updateSettings({ enabled: false });
      expect(service.getState().isActive).toBe(false);
    });
  });

  describe("getState", () => {
    it("should return current state", () => {
      const state = service.getState();
      expect(state).toHaveProperty("isActive");
      expect(state).toHaveProperty("isListening");
      expect(state).toHaveProperty("isSpeaking");
      expect(state).toHaveProperty("isProcessing");
      expect(state).toHaveProperty("audioLevel");
    });

    it("should return a copy of the state", () => {
      const state1 = service.getState();
      const state2 = service.getState();
      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });
  });

  describe("speak", () => {
    it("should return null when disabled", async () => {
      service.updateSettings({ enabled: false });
      const result = await service.speak("Hello");
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return null for empty text", async () => {
      service.updateSettings({ enabled: true });
      const result = await service.speak("");
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return null for whitespace text", async () => {
      service.updateSettings({ enabled: true });
      const result = await service.speak("   ");
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should call ElevenLabs API and return Buffer when provider is elevenlabs", async () => {
      const mockAudioData = new ArrayBuffer(1000);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(mockAudioData),
      });

      service.updateSettings({
        enabled: true,
        ttsProvider: "elevenlabs",
        elevenLabsApiKey: "test-api-key",
      });

      const result = await service.speak("Hello");

      expect(result).toBeInstanceOf(Buffer);
      expect(result?.length).toBe(1000);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api.elevenlabs.io"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "xi-api-key": "test-api-key",
          }),
        }),
      );
    });

    it("should throw when ElevenLabs API key is missing", async () => {
      service.updateSettings({
        enabled: true,
        ttsProvider: "elevenlabs",
        elevenLabsApiKey: undefined,
      });

      await expect(service.speak("Hello")).rejects.toThrow("ElevenLabs API key not configured");
    });

    it("should call OpenAI API and return Buffer when provider is openai", async () => {
      const mockAudioData = new ArrayBuffer(500);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(mockAudioData),
      });

      service.updateSettings({
        enabled: true,
        ttsProvider: "openai",
        openaiApiKey: "test-openai-key",
      });

      const result = await service.speak("Hello");

      expect(result).toBeInstanceOf(Buffer);
      expect(result?.length).toBe(500);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("api.openai.com"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-openai-key",
          }),
        }),
      );
    });

    it("should throw for local TTS provider (not available in main process)", async () => {
      service.updateSettings({
        enabled: true,
        ttsProvider: "local",
      });

      await expect(service.speak("Hello")).rejects.toThrow("Local TTS is not available");
    });

    it("should emit speakingStart event", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      });

      const startHandler = vi.fn();
      service.on("speakingStart", startHandler);

      service.updateSettings({
        enabled: true,
        ttsProvider: "openai",
        openaiApiKey: "test-key",
      });

      await service.speak("Hello");

      expect(startHandler).toHaveBeenCalledWith("Hello");
    });
  });

  describe("finishSpeaking", () => {
    it("should update state and emit speakingEnd", () => {
      const endHandler = vi.fn();
      service.on("speakingEnd", endHandler);

      service.finishSpeaking();

      expect(service.getState().isSpeaking).toBe(false);
      expect(endHandler).toHaveBeenCalled();
    });
  });

  describe("stopSpeaking", () => {
    it("should update state", () => {
      service.stopSpeaking();
      expect(service.getState().isSpeaking).toBe(false);
    });

    it("should emit speakingEnd event", () => {
      const handler = vi.fn();
      service.on("speakingEnd", handler);
      service.stopSpeaking();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("transcribe", () => {
    it("should throw when disabled", async () => {
      service.updateSettings({ enabled: false });
      const audioBuffer = Buffer.from("test audio data");

      await expect(service.transcribe(audioBuffer)).rejects.toThrow("Voice mode is disabled");
    });

    it("should call OpenAI Whisper API when provider is openai", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ text: "Hello world" }),
      });

      service.updateSettings({
        enabled: true,
        sttProvider: "openai",
        openaiApiKey: "test-key",
        language: "en-US",
      });

      const audioBuffer = Buffer.from("test audio data");
      const result = await service.transcribe(audioBuffer);

      expect(result).toBe("Hello world");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("transcriptions"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
          }),
        }),
      );
    });

    it("should throw for local STT provider (not available in main process)", async () => {
      service.updateSettings({
        enabled: true,
        sttProvider: "local",
      });

      const audioBuffer = Buffer.from("test audio data");
      await expect(service.transcribe(audioBuffer)).rejects.toThrow("Local STT is not available");
    });

    it("should emit transcript event on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ text: "Test transcript" }),
      });

      const transcriptHandler = vi.fn();
      service.on("transcript", transcriptHandler);

      service.updateSettings({
        enabled: true,
        sttProvider: "openai",
        openaiApiKey: "test-key",
        language: "en-US",
      });

      const audioBuffer = Buffer.from("test audio data");
      await service.transcribe(audioBuffer);

      expect(transcriptHandler).toHaveBeenCalledWith("Test transcript");
    });
  });

  describe("getElevenLabsVoices", () => {
    it("should fetch voices from ElevenLabs API", async () => {
      const mockVoices = [
        { voice_id: "voice-1", name: "Voice 1" },
        { voice_id: "voice-2", name: "Voice 2" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ voices: mockVoices }),
      });

      service.updateSettings({ elevenLabsApiKey: "test-key" });
      const voices = await service.getElevenLabsVoices();

      expect(voices).toEqual(mockVoices);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("elevenlabs.io/v1/voices"),
        expect.objectContaining({
          headers: expect.objectContaining({
            "xi-api-key": "test-key",
          }),
        }),
      );
    });

    it("should throw when API key is missing", async () => {
      service.updateSettings({ elevenLabsApiKey: undefined });
      await expect(service.getElevenLabsVoices()).rejects.toThrow(
        "ElevenLabs API key not configured",
      );
    });
  });

  describe("testElevenLabsConnection", () => {
    it("should return success when voices are fetched", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ voices: [{ voice_id: "1" }, { voice_id: "2" }] }),
      });

      service.updateSettings({ elevenLabsApiKey: "test-key" });
      const result = await service.testElevenLabsConnection();

      expect(result.success).toBe(true);
      expect(result.voiceCount).toBe(2);
    });

    it("should return error on failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: vi.fn().mockResolvedValue("Invalid API key"),
      });

      service.updateSettings({ elevenLabsApiKey: "bad-key" });
      const result = await service.testElevenLabsConnection();

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("testOpenAIConnection", () => {
    it("should return success when API responds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      });

      service.updateSettings({ openaiApiKey: "test-key" });
      const result = await service.testOpenAIConnection();

      expect(result.success).toBe(true);
    });

    it("should return error when API key is missing", async () => {
      service.updateSettings({ openaiApiKey: undefined });
      const result = await service.testOpenAIConnection();

      expect(result.success).toBe(false);
      expect(result.error).toContain("not configured");
    });
  });

  describe("dispose", () => {
    it("should clean up resources", () => {
      service.dispose();
      // Should not throw
    });

    it("should stop speaking when disposed", () => {
      const handler = vi.fn();
      service.on("speakingEnd", handler);
      service.dispose();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("singleton", () => {
    it("should return the same instance", () => {
      const instance1 = getVoiceService();
      const instance2 = getVoiceService();
      expect(instance1).toBe(instance2);
    });

    it("should create new instance after reset", () => {
      const instance1 = getVoiceService();
      resetVoiceService();
      const instance2 = getVoiceService();
      expect(instance1).not.toBe(instance2);
    });
  });
});

describe("VoiceService events", () => {
  let service: VoiceService;

  beforeEach(() => {
    resetVoiceService();
    service = new VoiceService();
  });

  afterEach(() => {
    service.dispose();
  });

  it("should emit stateChange on state updates", () => {
    const handler = vi.fn();
    service.on("stateChange", handler);

    service.updateSettings({ enabled: true });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
  });

  it("should emit error event on API errors", async () => {
    const errorHandler = vi.fn();
    service.on("error", errorHandler);

    service.updateSettings({
      enabled: true,
      ttsProvider: "elevenlabs",
      elevenLabsApiKey: "test-key",
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: vi.fn().mockResolvedValue("API Error"),
    });

    await expect(service.speak("Hello")).rejects.toThrow();
    expect(errorHandler).toHaveBeenCalled();
  });

  it("should clear error state on successful speak", async () => {
    service.updateSettings({
      enabled: true,
      ttsProvider: "openai",
      openaiApiKey: "test-key",
    });

    // First call fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: vi.fn().mockResolvedValue("API Error"),
    });
    await expect(service.speak("Hello")).rejects.toThrow();
    expect(service.getState().error).toBeDefined();

    // Second call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
    });

    await service.speak("Hello again");
    // Error should be cleared (undefined)
    expect(service.getState().error).toBeUndefined();
  });
});

describe("VoiceService STT edge cases", () => {
  let service: VoiceService;

  beforeEach(() => {
    resetVoiceService();
    service = new VoiceService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.dispose();
  });

  it("should throw descriptive error when sttProvider is elevenlabs without OpenAI key", async () => {
    service.updateSettings({
      enabled: true,
      sttProvider: "elevenlabs",
      openaiApiKey: undefined,
    });

    const audioBuffer = Buffer.from("test audio data");
    await expect(service.transcribe(audioBuffer)).rejects.toThrow(
      "ElevenLabs does not provide speech-to-text",
    );
  });

  it("should fallback to OpenAI Whisper when sttProvider is elevenlabs with OpenAI key", async () => {
    service.updateSettings({
      enabled: true,
      sttProvider: "elevenlabs",
      openaiApiKey: "test-openai-key",
      language: "en-US",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ text: "Transcribed text" }),
    });

    const audioBuffer = Buffer.from("test audio data");
    const result = await service.transcribe(audioBuffer);

    expect(result).toBe("Transcribed text");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("transcriptions"),
      expect.any(Object),
    );
  });
});
