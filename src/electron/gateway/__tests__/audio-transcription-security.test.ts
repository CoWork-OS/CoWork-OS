import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "../channels/types";
import { transcribeAudioAttachments } from "../router-helpers";

const voice = vi.hoisted(() => ({
  isTranscriptionAvailable: vi.fn(() => true),
  transcribe: vi.fn(),
}));
vi.mock("../../voice/VoiceService", () => ({ getVoiceService: () => voice }));
afterEach(() => {
  vi.restoreAllMocks();
  voice.transcribe.mockReset();
});

describe("gateway audio transcription filesystem boundary", () => {
  it.each(["../../outside-canary", "/absolute/outside", "..\\outside", "voice.ogg"])(
    "transcribes %s entirely from memory",
    async (fileName) => {
      const write = vi.spyOn(fs, "writeFileSync");
      const unlink = vi.spyOn(fs, "unlinkSync");
      const mkdir = vi.spyOn(fs, "mkdirSync");
      const audio = Buffer.from("fake-audio");
      voice.transcribe.mockResolvedValue("hello from the voice message");
      const message: IncomingMessage = {
        messageId: "m",
        channel: "matrix",
        userId: "u",
        userName: "test",
        chatId: "c",
        text: "",
        timestamp: new Date(),
        attachments: [{ type: "audio", data: audio, fileName }],
      };
      await transcribeAudioAttachments(message);
      expect(voice.transcribe).toHaveBeenCalledWith(audio, { force: true });
      expect(message.text).toContain("hello from the voice message");
      expect(write).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      voice.transcribe.mockRejectedValueOnce(new Error("provider unavailable"));
      await transcribeAudioAttachments(message);
      expect(message.text).toContain("transcription failed");
      expect(write).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    },
  );
});
