import { accessSync, constants as fsConstants } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import type {
  SystemVoiceAdapter,
  VoiceCapabilities,
  VoiceProviderCapability,
} from "../../shared/types";

type CommandRunner = (command: string, args: string[]) => Promise<void>;
type CommandResolver = (command: string) => string | null;

export interface SystemVoiceSynthesisOptions {
  language: string;
  speechRate: number;
}

export interface SystemVoiceTranscriptionOptions {
  language: string;
}

export interface SystemVoiceRuntime {
  getCapabilities(): VoiceCapabilities;
  synthesize(text: string, options: SystemVoiceSynthesisOptions): Promise<Buffer>;
  transcribe(audioData: Buffer, options: SystemVoiceTranscriptionOptions): Promise<string>;
  stop(): void;
}

export interface NativeSystemVoiceRuntimeOptions {
  platform?: NodeJS.Platform;
  resolveCommand?: CommandResolver;
  runCommand?: CommandRunner;
}

interface DetectedSystemTts {
  capability: VoiceProviderCapability;
  command: string | null;
}

const SYSTEM_STT_UNAVAILABLE =
  "System speech recognition is not available in this desktop build. Use OpenAI Whisper or Azure Whisper.";

function resolveCommandFromPath(command: string): string | null {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        accessSync(
          candidate,
          process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

function detectSystemTts(
  platform: NodeJS.Platform,
  resolveCommand: CommandResolver,
): DetectedSystemTts {
  const unavailable = (reason: string): DetectedSystemTts => ({
    capability: { available: false, adapter: null, reason },
    command: null,
  });
  const available = (
    adapter: Exclude<SystemVoiceAdapter, null>,
    command: string,
  ): DetectedSystemTts => ({
    capability: { available: true, adapter },
    command,
  });

  if (platform === "darwin") {
    const command =
      resolveCommand("say") || (process.platform === "darwin" ? "/usr/bin/say" : null);
    return command
      ? available("macos-say", command)
      : unavailable("macOS System Voice requires the built-in say command.");
  }

  if (platform === "win32") {
    const command = resolveCommand("powershell.exe") || resolveCommand("pwsh.exe");
    return command
      ? available("windows-sapi", command)
      : unavailable("Windows System Voice requires PowerShell with System.Speech support.");
  }

  if (platform === "linux") {
    const command = resolveCommand("espeak-ng") || resolveCommand("espeak");
    return command
      ? available("espeak", command)
      : unavailable("Install espeak-ng to enable System Voice on Linux.");
  }

  return unavailable(`System Voice is not supported on ${platform}.`);
}

export function getSystemVoiceCapabilities(
  options: Pick<NativeSystemVoiceRuntimeOptions, "platform" | "resolveCommand"> = {},
): VoiceCapabilities {
  const platform = options.platform || process.platform;
  const detected = detectSystemTts(platform, options.resolveCommand || resolveCommandFromPath);
  return {
    systemTts: detected.capability,
    systemStt: { available: false, adapter: null, reason: SYSTEM_STT_UNAVAILABLE },
  };
}

export class NativeSystemVoiceRuntime implements SystemVoiceRuntime {
  private readonly detectedTts: DetectedSystemTts;
  private readonly injectedRunner?: CommandRunner;
  private activeProcess: ChildProcess | null = null;

  constructor(options: NativeSystemVoiceRuntimeOptions = {}) {
    this.detectedTts = detectSystemTts(
      options.platform || process.platform,
      options.resolveCommand || resolveCommandFromPath,
    );
    this.injectedRunner = options.runCommand;
  }

  getCapabilities(): VoiceCapabilities {
    return {
      systemTts: { ...this.detectedTts.capability },
      systemStt: { available: false, adapter: null, reason: SYSTEM_STT_UNAVAILABLE },
    };
  }

  async synthesize(text: string, options: SystemVoiceSynthesisOptions): Promise<Buffer> {
    const { capability, command } = this.detectedTts;
    if (!capability.available || !capability.adapter || !command) {
      throw new Error(capability.reason || "System Voice is unavailable.");
    }

    this.stop();
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-system-voice-"));
    const inputPath = path.join(tempDirectory, "speech.txt");
    const outputPath = path.join(tempDirectory, "speech.wav");

    try {
      await fs.writeFile(inputPath, text, "utf-8");
      const args = this.buildSynthesisArgs(
        capability.adapter,
        inputPath,
        outputPath,
        options,
      );
      await this.runCommand(command, args);
      const audio = await fs.readFile(outputPath);
      if (audio.length === 0) {
        throw new Error("System Voice produced an empty audio file.");
      }
      return audio;
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async transcribe(
    _audioData: Buffer,
    _options: SystemVoiceTranscriptionOptions,
  ): Promise<string> {
    throw new Error(SYSTEM_STT_UNAVAILABLE);
  }

  stop(): void {
    if (this.activeProcess && !this.activeProcess.killed) {
      this.activeProcess.kill();
    }
    this.activeProcess = null;
  }

  private buildSynthesisArgs(
    adapter: Exclude<SystemVoiceAdapter, null>,
    inputPath: string,
    outputPath: string,
    options: SystemVoiceSynthesisOptions,
  ): string[] {
    const wordsPerMinute = String(
      Math.round(Math.max(90, Math.min(360, 180 * options.speechRate))),
    );

    if (adapter === "macos-say") {
      return [
        `--rate=${wordsPerMinute}`,
        "--file-format=WAVE",
        "--data-format=LEI16@22050",
        `--output-file=${outputPath}`,
        `--input-file=${inputPath}`,
      ];
    }

    if (adapter === "windows-sapi") {
      const sapiRate = String(
        Math.round(Math.max(-10, Math.min(10, (options.speechRate - 1) * 10))),
      );
      const script = [
        "Add-Type -AssemblyName System.Speech",
        "$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        "try {",
        "  $voice.Rate = [int]$args[2]",
        "  $voice.SetOutputToWaveFile($args[0])",
        "  $voice.Speak([IO.File]::ReadAllText($args[1]))",
        "} finally { $voice.Dispose() }",
      ].join("; ");
      return [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
        outputPath,
        inputPath,
        sapiRate,
      ];
    }

    return [
      "-s",
      wordsPerMinute,
      "-v",
      options.language.toLowerCase(),
      "-f",
      inputPath,
      "-w",
      outputPath,
    ];
  }

  private async runCommand(command: string, args: string[]): Promise<void> {
    if (this.injectedRunner) {
      await this.injectedRunner(command, args);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      this.activeProcess = child;
      let stderr = "";

      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 8_000) stderr += String(chunk);
      });
      child.once("error", (error) => {
        this.activeProcess = null;
        reject(error);
      });
      child.once("close", (code, signal) => {
        this.activeProcess = null;
        if (code === 0) {
          resolve();
          return;
        }
        const detail = stderr.trim() || (signal ? `terminated by ${signal}` : `exit code ${code}`);
        reject(new Error(`System Voice synthesis failed: ${detail}`));
      });
    });
  }
}

export function createSystemVoiceRuntime(
  options?: NativeSystemVoiceRuntimeOptions,
): SystemVoiceRuntime {
  return new NativeSystemVoiceRuntime(options);
}
