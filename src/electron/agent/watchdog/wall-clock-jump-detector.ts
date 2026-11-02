/**
 * Sleep detection for the headless daemon, which has no Electron powerMonitor: a short timer
 * expects to fire every `tickMs`; when the wall clock moved much further than that between two
 * ticks, the host was suspended (or the process was frozen) for the difference.
 */

/** Drift beyond the expected tick that counts as a suspend. */
export const DEFAULT_WALL_CLOCK_JUMP_THRESHOLD_MS = 2 * 60_000;
export const DEFAULT_WALL_CLOCK_TICK_MS = 30_000;

export interface WallClockJump {
  /** Wall-clock time of the last tick before the jump. */
  suspendedAt: number;
  /** Wall-clock time the jump was noticed. */
  resumedAt: number;
  /** Time unaccounted for: the gap minus the expected tick. */
  driftMs: number;
}

export interface WallClockJumpDetectorOptions {
  onJump: (jump: WallClockJump) => void;
  /** Called on every regular tick; lets callers keep a snapshot of state from before a sleep. */
  onTick?: (now: number) => void;
  tickMs?: number;
  thresholdMs?: number;
  now?: () => number;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export class WallClockJumpDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private readonly tickMs: number;
  private readonly thresholdMs: number;
  private readonly now: () => number;

  constructor(private readonly options: WallClockJumpDetectorOptions) {
    this.tickMs = Math.max(1_000, Math.floor(options.tickMs ?? DEFAULT_WALL_CLOCK_TICK_MS));
    this.thresholdMs = Math.max(
      1_000,
      Math.floor(options.thresholdMs ?? DEFAULT_WALL_CLOCK_JUMP_THRESHOLD_MS),
    );
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = this.now();
    const tick = () => void this.tick();
    this.timer = this.options.setInterval
      ? this.options.setInterval(tick, this.tickMs)
      : setInterval(tick, this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }

  /** One timer tick; public so tests can drive it without real time passing. */
  tick(): WallClockJump | null {
    const now = this.now();
    const driftMs = now - this.lastTickAt - this.tickMs;
    const previous = this.lastTickAt;
    this.lastTickAt = now;
    if (driftMs > this.thresholdMs) {
      const jump = { suspendedAt: previous, resumedAt: now, driftMs };
      this.options.onJump(jump);
      return jump;
    }
    this.options.onTick?.(now);
    return null;
  }
}
