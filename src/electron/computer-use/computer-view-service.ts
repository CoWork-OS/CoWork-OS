/**
 * The live view of a task's computer for the bot's panel, and take-over by the person.
 *
 * - Frames come from captures the tools already make (each computer-use action takes a
 *   screenshot) and, while someone watches, from the in-app browser every few seconds.
 *   They are downscaled, kept in memory only (the latest per task) and sent to the app.
 * - While the person has taken over, the bot's computer and browser actions are refused, not
 *   queued, and nothing is captured.
 * - A bot can ask the person to take over for steps it must not do itself (passwords,
 *   one-time codes, payments).
 */

import {
  COMPUTER_TAKEOVER_REASON_MAX_LENGTH,
  COMPUTER_VIEW_FRAME_MAX_WIDTH,
  COMPUTER_VIEW_POLL_MS,
  type ComputerViewFrame,
  type ComputerViewState,
  type ComputerViewSurface,
} from "../../shared/computer-view";

export interface EncodedFrame {
  dataUrl: string;
  width: number;
  height: number;
}

export interface ComputerViewDeps {
  /** Scales a PNG down and encodes it as a JPEG data URL; null when it can't be decoded. */
  encodeFrame: (png: Buffer, maxWidth: number) => EncodedFrame | null;
  /** Captures the task's in-app browser tab, if it has one. */
  captureBrowser?: (taskId: string) => Promise<{ png: Buffer; label?: string } | null>;
  /** Captures the bot's own desktop, if it is running. */
  captureDesktop?: (taskId: string) => Promise<{ png: Buffer; label?: string } | null>;
  /** Pauses or resumes the bot's driving of the task's in-app browser tabs. */
  setBrowserPaused?: (taskId: string, paused: boolean) => void;
  logEvent?: (taskId: string, type: string, payload: Record<string, unknown>) => void;
  notify?: (state: ComputerViewState) => void;
  now?: () => number;
}

const defaultEncodeFrame = (png: Buffer, maxWidth: number): EncodedFrame | null => {
  // Loaded lazily so the service can be used without Electron in tests.
  const { nativeImage } = require("electron") as typeof import("electron");
  let image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width > maxWidth) image = image.resize({ width: maxWidth, quality: "good" });
  const scaled = image.getSize();
  return {
    dataUrl: `data:image/jpeg;base64,${image.toJPEG(70).toString("base64")}`,
    width: scaled.width,
    height: scaled.height,
  };
};

export class ComputerViewService {
  private static instance: ComputerViewService | null = null;

  static getInstance(): ComputerViewService {
    if (!ComputerViewService.instance) {
      ComputerViewService.instance = new ComputerViewService({ encodeFrame: defaultEncodeFrame });
    }
    return ComputerViewService.instance;
  }

  static resetForTesting(deps?: ComputerViewDeps): ComputerViewService {
    ComputerViewService.instance?.dispose();
    ComputerViewService.instance = deps ? new ComputerViewService(deps) : null;
    return ComputerViewService.instance as ComputerViewService;
  }

  private readonly states = new Map<string, ComputerViewState>();
  private readonly watchers = new Map<string, number>();
  private readonly pollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly capturing = new Set<string>();

  constructor(private deps: ComputerViewDeps) {}

  /** Adds the Electron-side hooks once the app is ready. */
  configure(deps: Partial<ComputerViewDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  getState(taskId: string): ComputerViewState {
    return this.states.get(taskId) ?? { taskId, status: "idle", updatedAt: this.now() };
  }

  isHeldByPerson(taskId: string): boolean {
    return this.states.get(taskId)?.status === "held";
  }

  /** Refuses a bot's computer action while the person has taken over. */
  assertNotHeld(taskId: string): void {
    if (this.isHeldByPerson(taskId)) {
      throw new Error(
        "The person has taken over this computer. Do not use computer or browser tools until " +
          "they hand it back; end your turn with a short note if you need to wait.",
      );
    }
  }

  isWatched(taskId: string): boolean {
    return (this.watchers.get(taskId) ?? 0) > 0;
  }

  /** The panel started showing this task's computer: returns the current state. */
  watch(taskId: string): ComputerViewState {
    this.watchers.set(taskId, (this.watchers.get(taskId) ?? 0) + 1);
    this.syncPoller(taskId);
    return this.getState(taskId);
  }

  unwatch(taskId: string): void {
    const count = (this.watchers.get(taskId) ?? 0) - 1;
    if (count > 0) this.watchers.set(taskId, count);
    else this.watchers.delete(taskId);
    this.syncPoller(taskId);
  }

  /** A tool captured the task's screen: keep it as the latest frame. */
  publishFrame(
    taskId: string,
    surface: ComputerViewSurface,
    png: Buffer | string,
    label?: string,
  ): void {
    if (this.isHeldByPerson(taskId)) return;
    let encoded: EncodedFrame | null = null;
    try {
      const buffer = typeof png === "string" ? Buffer.from(png, "base64") : png;
      encoded = this.deps.encodeFrame(buffer, COMPUTER_VIEW_FRAME_MAX_WIDTH);
    } catch {
      encoded = null;
    }
    if (!encoded) return;
    const frame: ComputerViewFrame = {
      ...encoded,
      capturedAt: this.now(),
      surface,
      ...(label ? { label: label.slice(0, 200) } : {}),
    };
    this.update(taskId, { status: "working", surface, frame, waitingSince: undefined });
  }

  /** The task started using a computer (or a surface), even before any frame. */
  noteWorking(taskId: string, surface: ComputerViewSurface): void {
    const current = this.getState(taskId);
    if (current.status === "held") return;
    if (current.status === "working" && current.surface === surface) return;
    this.update(taskId, { status: "working", surface, waitingSince: undefined });
    this.syncPoller(taskId);
  }

  noteWaiting(taskId: string): void {
    if (this.isHeldByPerson(taskId)) return;
    this.update(taskId, { status: "waiting", waitingSince: this.now() });
  }

  /** The task stopped using this computer (its session ended). */
  noteReleased(taskId: string, surface: ComputerViewSurface): void {
    const current = this.states.get(taskId);
    if (!current || current.status === "held" || current.surface !== surface) return;
    this.update(taskId, { status: "idle" });
  }

  /** The person takes over: the bot's computer and browser actions are refused until hand-back. */
  takeOver(taskId: string): ComputerViewState {
    if (this.isHeldByPerson(taskId)) return this.getState(taskId);
    this.deps.setBrowserPaused?.(taskId, true);
    this.deps.logEvent?.(taskId, "computer_taken_over", {});
    const state = this.update(taskId, { status: "held", takeoverRequest: undefined });
    this.syncPoller(taskId);
    return state;
  }

  handBack(taskId: string): ComputerViewState {
    if (!this.isHeldByPerson(taskId)) return this.getState(taskId);
    this.deps.setBrowserPaused?.(taskId, false);
    this.deps.logEvent?.(taskId, "computer_handed_back", {});
    const state = this.update(taskId, { status: "idle" });
    this.syncPoller(taskId);
    return state;
  }

  /** The bot asks the person to take over for a step it must not do itself. */
  requestTakeover(taskId: string, reason: string): ComputerViewState {
    const cleanReason =
      String(reason || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, COMPUTER_TAKEOVER_REASON_MAX_LENGTH) || "A step needs you.";
    this.deps.logEvent?.(taskId, "computer_takeover_requested", { reason: cleanReason });
    return this.update(taskId, { takeoverRequest: { reason: cleanReason, at: this.now() } });
  }

  /**
   * The task's run ended. Its last frame stays for the panel; a take-over stays until the person
   * hands back, since the bot often ends its turn to wait for them.
   */
  noteTaskEnded(taskId: string): void {
    const current = this.states.get(taskId);
    this.stopPoller(taskId);
    if (!current || current.status === "held" || current.status === "idle") return;
    this.update(taskId, { status: "idle", waitingSince: undefined });
  }

  /** The task finished: forget its view and release any take-over. */
  clearTask(taskId: string): void {
    if (this.isHeldByPerson(taskId)) this.deps.setBrowserPaused?.(taskId, false);
    this.states.delete(taskId);
    this.stopPoller(taskId);
    this.deps.notify?.({ taskId, status: "idle", updatedAt: this.now() });
  }

  dispose(): void {
    for (const taskId of Array.from(this.pollers.keys())) this.stopPoller(taskId);
    this.states.clear();
    this.watchers.clear();
  }

  private update(taskId: string, patch: Partial<ComputerViewState>): ComputerViewState {
    const next: ComputerViewState = {
      ...this.getState(taskId),
      ...patch,
      taskId,
      updatedAt: this.now(),
    };
    for (const key of Object.keys(next) as Array<keyof ComputerViewState>) {
      if (next[key] === undefined) delete next[key];
    }
    this.states.set(taskId, next);
    this.deps.notify?.(next);
    return next;
  }

  /**
   * Captures the browser or the bot's own desktop every few seconds while someone watches a
   * task working there. This computer is captured only by its own actions.
   */
  private syncPoller(taskId: string): void {
    const state = this.states.get(taskId);
    const shouldPoll =
      Boolean(this.capturerFor(state?.surface)) &&
      this.isWatched(taskId) &&
      state?.status === "working";
    if (!shouldPoll) {
      this.stopPoller(taskId);
      return;
    }
    if (this.pollers.has(taskId)) return;
    const timer = setInterval(() => void this.captureNow(taskId), COMPUTER_VIEW_POLL_MS);
    (timer as { unref?: () => void }).unref?.();
    this.pollers.set(taskId, timer);
  }

  private stopPoller(taskId: string): void {
    const timer = this.pollers.get(taskId);
    if (timer) clearInterval(timer);
    this.pollers.delete(taskId);
  }

  private capturerFor(surface: ComputerViewSurface | undefined) {
    if (surface === "browser") return this.deps.captureBrowser;
    if (surface === "own_desktop") return this.deps.captureDesktop;
    return undefined;
  }

  /** Captures the task's browser now (after a browser action). */
  async captureBrowserFrame(taskId: string): Promise<void> {
    if (this.getState(taskId).surface !== "browser") this.noteWorking(taskId, "browser");
    await this.captureNow(taskId);
  }

  /** Captures what the task works on now, if it can be captured without its tools. */
  async captureNow(taskId: string): Promise<void> {
    const surface = this.states.get(taskId)?.surface;
    const capture = this.capturerFor(surface);
    if (!surface || !capture || this.capturing.has(taskId) || this.isHeldByPerson(taskId)) {
      return;
    }
    this.capturing.add(taskId);
    try {
      const captured = await capture(taskId);
      if (captured) this.publishFrame(taskId, surface, captured.png, captured.label);
    } catch {
      // A tab that closed or navigated away just skips this frame.
    } finally {
      this.capturing.delete(taskId);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
