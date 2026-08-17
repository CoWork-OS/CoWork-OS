import fs from "fs";
import { describe, expect, it, vi } from "vitest";
import {
  getSystemVoiceCapabilities,
  NativeSystemVoiceRuntime,
} from "../system-voice";

describe("system voice capabilities", () => {
  it("reports macOS TTS only when the say command is available", () => {
    const capabilities = getSystemVoiceCapabilities({
      platform: "darwin",
      resolveCommand: () => null,
    });

    expect(capabilities.systemTts).toMatchObject({ available: false, adapter: null });
  });

  it("reports desktop System STT as unavailable", () => {
    const capabilities = getSystemVoiceCapabilities({
      platform: "darwin",
      resolveCommand: () => "/usr/bin/say",
    });

    expect(capabilities.systemStt).toMatchObject({
      available: false,
      adapter: null,
      reason: expect.stringContaining("not available"),
    });
  });
});

describe("NativeSystemVoiceRuntime", () => {
  it("synthesizes macOS System Voice to a WAV buffer without passing text as a command", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const outputArgument = args.find((argument) => argument.startsWith("--output-file="));
      if (!outputArgument) throw new Error("Missing output path");
      fs.writeFileSync(outputArgument.slice("--output-file=".length), Buffer.from("RIFF-WAV"));
    });
    const runtime = new NativeSystemVoiceRuntime({
      platform: "darwin",
      resolveCommand: () => "/usr/bin/say",
      runCommand,
    });

    const audio = await runtime.synthesize("Hello; $(unsafe)", {
      language: "en-US",
      speechRate: 1,
    });

    expect(audio).toEqual(Buffer.from("RIFF-WAV"));
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/bin/say",
      expect.arrayContaining([
        "--file-format=WAVE",
        "--data-format=LEI16@22050",
        expect.stringMatching(/^--input-file=/),
      ]),
    );
    expect(runCommand.mock.calls[0][1]).not.toContain("Hello; $(unsafe)");
  });
});
