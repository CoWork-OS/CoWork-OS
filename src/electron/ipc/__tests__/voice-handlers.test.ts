import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/types";
import { VoiceService } from "../../voice/VoiceService";

type RegisteredHandler = (...args: unknown[]) => unknown;

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, RegisteredHandler>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: RegisteredHandler) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import { setupVoiceActionHandlers } from "../voice-handlers";

describe("voice action IPC handlers", () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
  });

  it("dispatches System TTS through VoiceService and returns playable audio bytes", async () => {
    const synthesize = vi.fn().mockResolvedValue(Buffer.from([82, 73, 70, 70]));
    const service = new VoiceService({
      settings: { enabled: true, ttsProvider: "local" },
      systemVoiceRuntime: {
        getCapabilities: () => ({
          systemTts: { available: true, adapter: "macos-say" },
          systemStt: { available: false, adapter: null, reason: "Unavailable" },
        }),
        synthesize,
        transcribe: vi.fn(),
        stop: vi.fn(),
      },
    });
    setupVoiceActionHandlers({ getService: () => service });

    const handler = registeredHandlers.get(IPC_CHANNELS.VOICE_SPEAK)!;
    const result = await handler(null, "Hello from IPC");

    expect(synthesize).toHaveBeenCalledWith("Hello from IPC", {
      language: "en-US",
      speechRate: 1,
    });
    expect(result).toEqual({ success: true, audioData: [82, 73, 70, 70] });
    service.dispose();
  });

  it("reports System provider capabilities through IPC", async () => {
    const service = new VoiceService({
      systemVoiceRuntime: {
        getCapabilities: () => ({
          systemTts: { available: true, adapter: "espeak" },
          systemStt: { available: false, adapter: null, reason: "Unavailable" },
        }),
        synthesize: vi.fn(),
        transcribe: vi.fn(),
        stop: vi.fn(),
      },
    });
    setupVoiceActionHandlers({ getService: () => service });

    const handler = registeredHandlers.get(IPC_CHANNELS.VOICE_GET_CAPABILITIES)!;

    await expect(handler(null)).resolves.toEqual({
      systemTts: { available: true, adapter: "espeak" },
      systemStt: { available: false, adapter: null, reason: "Unavailable" },
    });
    service.dispose();
  });
});
