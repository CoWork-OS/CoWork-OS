/**
 * Dictation into other apps: one shortcut starts listening, the same shortcut stops, and the
 * words are written down by the speech-to-text provider from Settings > Voice and pasted
 * into the app in front. Escape cancels while listening or writing.
 *
 * Nothing here touches the network or the screen directly; the Electron side is injected,
 * so the flow is tested without a microphone.
 */
import type { DeliveryOptions, DeliveryResult } from "./paste-into-front-app";

export type DictationViewState = "listening" | "working" | "done" | "error";

export interface DictationView {
  state: DictationViewState;
  message: string;
}

export interface DictationOverlayLike {
  /** Shows the overlay (without taking focus from the app in front) in this state. */
  show(view: DictationView): Promise<void>;
  /** Starts recording. `error` is the DOMException name when the microphone refused. */
  start(): Promise<{ ok: boolean; error?: string }>;
  /** Stops recording and returns the audio, or null when nothing was recorded. */
  stop(): Promise<Uint8Array | null>;
  /** Stops recording and drops the audio. */
  cancel(): Promise<void>;
  hide(): void;
}

export interface DictationDeps {
  overlay: DictationOverlayLike;
  /** Asks for microphone access when macOS hasn't asked yet. */
  microphoneAccess(): Promise<"granted" | "denied">;
  /** A speech-to-text provider is set up in Settings > Voice. */
  transcriptionReady(): boolean;
  transcribe(audio: Buffer): Promise<string>;
  deliver(text: string, options: DeliveryOptions): Promise<DeliveryResult>;
  /**
   * The app in front (bundle id and process id), so the text is pasted only into the app
   * that was in front when dictation started. Null when it can't be told.
   */
  frontmostApp(): Promise<string | null>;
  /** Escape cancels only while dictation is under way. */
  setCancelKey(active: boolean): void;
  schedule(callback: () => void, ms: number): () => void;
  log?(message: string): void;
}

type Phase = "idle" | "starting" | "recording" | "working" | "showing";

/** Long enough for a paragraph; well under the 25 MB upload limit of Whisper. */
export const MAX_DICTATION_MS = 3 * 60_000;
export const MAX_DICTATION_BYTES = 24 * 1024 * 1024;
/** Less than this is a click of the key, not speech. */
const MIN_DICTATION_BYTES = 1_000;
const DONE_VISIBLE_MS = 900;
const MESSAGE_VISIBLE_MS = 3_500;

export const DICTATION_MESSAGES = {
  listening: "Listening… press ⌃⇧Space when done",
  working: "Writing it down…",
  pasted: "Done",
  copied: "Copied. Press ⌘V to paste, or allow CoWork in Accessibility to paste for you.",
  switchedApps: "You switched apps, so the text is copied. Press ⌘V to paste.",
  clipboardLost: "Done. What you had copied before couldn't be put back.",
  noProvider: "Set up speech-to-text in Settings > Voice first.",
  microphoneBlocked:
    "CoWork can't use the microphone. Allow it in System Settings > Privacy & Security > Microphone.",
  noMicrophone: "No microphone found.",
  nothingHeard: "Didn't catch anything.",
  tooLong: "That was too long to write down in one go.",
  transcribeFailed: "Speech-to-text failed. Check Settings > Voice.",
  pasteFailed: "Couldn't paste the text.",
} as const;

function microphoneMessage(error?: string): string {
  if (error === "NotFoundError" || error === "DevicesNotFoundError") {
    return DICTATION_MESSAGES.noMicrophone;
  }
  return DICTATION_MESSAGES.microphoneBlocked;
}

export class DictationController {
  private phase: Phase = "idle";
  /** The app that was in front when listening started. */
  private target: string | null = null;
  /** Bumped by every start and cancel, so a stale step stops when it resumes. */
  private run = 0;
  private cancelMaxTimer: (() => void) | null = null;
  private cancelHideTimer: (() => void) | null = null;

  constructor(private readonly deps: DictationDeps) {}

  get currentPhase(): Phase {
    return this.phase;
  }

  /** The shortcut: start when idle, finish while listening, ignore while busy. */
  async toggle(): Promise<void> {
    if (this.phase === "idle" || this.phase === "showing") {
      await this.start();
    } else if (this.phase === "recording") {
      await this.finish();
    }
  }

  async start(): Promise<void> {
    const run = ++this.run;
    this.clearHideTimer();
    this.phase = "starting";

    if (!this.deps.transcriptionReady()) {
      await this.showMessage(run, "error", DICTATION_MESSAGES.noProvider);
      return;
    }
    if ((await this.deps.microphoneAccess()) !== "granted") {
      if (run !== this.run) return;
      await this.showMessage(run, "error", DICTATION_MESSAGES.microphoneBlocked);
      return;
    }
    if (run !== this.run) return;

    this.target = await this.deps.frontmostApp().catch(() => null);
    if (run !== this.run) return;
    this.deps.setCancelKey(true);
    let started: { ok: boolean; error?: string };
    try {
      await this.deps.overlay.show({ state: "listening", message: DICTATION_MESSAGES.listening });
      started = await this.deps.overlay.start();
    } catch (error) {
      // Never leave Escape taken when the overlay fails.
      this.deps.log?.(`Dictation could not start (${errorName(error)})`);
      this.deps.setCancelKey(false);
      this.phase = "idle";
      this.deps.overlay.hide();
      return;
    }
    if (run !== this.run) {
      await this.deps.overlay.cancel();
      return;
    }
    if (!started.ok) {
      this.deps.setCancelKey(false);
      await this.showMessage(run, "error", microphoneMessage(started.error));
      return;
    }
    this.phase = "recording";
    this.cancelMaxTimer = this.deps.schedule(() => void this.finish(), MAX_DICTATION_MS);
  }

  async finish(): Promise<void> {
    if (this.phase !== "recording") return;
    const run = this.run;
    this.phase = "working";
    this.clearMaxTimer();
    await this.deps.overlay.show({ state: "working", message: DICTATION_MESSAGES.working });

    const audio = await this.deps.overlay.stop();
    if (run !== this.run) return;
    if (!audio || audio.byteLength < MIN_DICTATION_BYTES) {
      await this.end(run, "error", DICTATION_MESSAGES.nothingHeard);
      return;
    }
    if (audio.byteLength > MAX_DICTATION_BYTES) {
      await this.end(run, "error", DICTATION_MESSAGES.tooLong);
      return;
    }

    let text: string;
    try {
      text = tidyTranscript(await this.deps.transcribe(Buffer.from(audio)));
    } catch (error) {
      // The provider's message can carry request details, so only the error's kind is logged.
      this.deps.log?.(`Dictation transcription failed (${errorName(error)})`);
      if (run === this.run) await this.end(run, "error", DICTATION_MESSAGES.transcribeFailed);
      return;
    }
    if (run !== this.run) return;
    if (!text) {
      await this.end(run, "error", DICTATION_MESSAGES.nothingHeard);
      return;
    }

    // Past this point the text is on its way; Escape no longer cancels.
    this.deps.setCancelKey(false);
    const now = await this.deps.frontmostApp().catch(() => null);
    const sameApp = this.target === null || now === null || now === this.target;
    let result: DeliveryResult;
    try {
      result = await this.deps.deliver(text, { paste: sameApp });
    } catch (error) {
      this.deps.log?.(`Dictation paste failed (${errorName(error)})`);
      await this.end(run, "error", DICTATION_MESSAGES.pasteFailed);
      return;
    }
    this.deps.log?.(`Dictated ${text.length} characters (${result})`);
    if (result === "pasted") {
      await this.end(run, "done", DICTATION_MESSAGES.pasted, DONE_VISIBLE_MS);
    } else if (result === "pasted_clipboard_lost") {
      await this.end(run, "done", DICTATION_MESSAGES.clipboardLost);
    } else {
      await this.end(
        run,
        "done",
        sameApp ? DICTATION_MESSAGES.copied : DICTATION_MESSAGES.switchedApps,
      );
    }
  }

  /** Escape, the overlay's cancel button, or the setting turned off. */
  async cancel(): Promise<void> {
    if (this.phase === "idle") return;
    const wasRecording = this.phase === "starting" || this.phase === "recording";
    const wasWorking = this.phase === "working";
    this.run += 1;
    this.phase = "idle";
    this.clearMaxTimer();
    this.clearHideTimer();
    this.deps.setCancelKey(false);
    if (wasRecording || wasWorking) await this.deps.overlay.cancel();
    this.deps.overlay.hide();
  }

  private async end(
    run: number,
    state: DictationViewState,
    message: string,
    visibleMs = MESSAGE_VISIBLE_MS,
  ): Promise<void> {
    this.deps.setCancelKey(false);
    await this.showMessage(run, state, message, visibleMs);
  }

  private async showMessage(
    run: number,
    state: DictationViewState,
    message: string,
    visibleMs = MESSAGE_VISIBLE_MS,
  ): Promise<void> {
    if (run !== this.run) return;
    this.phase = "showing";
    await this.deps.overlay.show({ state, message });
    this.clearHideTimer();
    this.cancelHideTimer = this.deps.schedule(() => {
      if (run !== this.run || this.phase !== "showing") return;
      this.phase = "idle";
      this.deps.overlay.hide();
    }, visibleMs);
  }

  private clearMaxTimer(): void {
    this.cancelMaxTimer?.();
    this.cancelMaxTimer = null;
  }

  private clearHideTimer(): void {
    this.cancelHideTimer?.();
    this.cancelHideTimer = null;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/**
 * One line of text, trimmed. Line breaks become spaces, so a paste into a terminal never
 * presses Return.
 */
export function tidyTranscript(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/[\t ]{2,}/g, " ")
    .trim();
}
