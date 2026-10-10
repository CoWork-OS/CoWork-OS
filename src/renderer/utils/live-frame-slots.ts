/**
 * Live slots for interactive HTML frames. Every frame runs in its own sandboxed process,
 * so a long conversation with many frames would keep many processes busy. At most
 * MAX_LIVE_FRAMES are live at once: frames on (or near) screen win, then the ones used
 * most recently. A frame that loses its slot is parked: its document is unloaded and its
 * inputs, which the bridge already saves, come back when it is live again. A frame that
 * has never been on screen is not loaded at all.
 */

export const MAX_LIVE_FRAMES = 3;
/** Visibility changes wait this long, so frames scrolled past quickly are not loaded. */
export const VISIBILITY_SETTLE_MS = 150;

type SlotEntry = {
  visible: boolean;
  /** When it was last on screen or used; 0 if it never was. */
  lastActive: number;
  live: boolean;
  notify: (live: boolean) => void;
};

export class LiveFrameSlots {
  private readonly entries = new Map<string, SlotEntry>();
  private clock = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly limit = MAX_LIVE_FRAMES,
    private readonly now: () => number = () => Date.now(),
    private readonly settleMs = VISIBILITY_SETTLE_MS,
  ) {}

  /** Adds a frame; `notify` is called whenever it goes live or is parked. */
  register(id: string, notify: (live: boolean) => void): void {
    this.entries.set(id, { visible: false, lastActive: 0, live: false, notify });
    this.rebalance();
  }

  unregister(id: string): void {
    if (this.entries.delete(id)) this.rebalance();
  }

  setVisible(id: string, visible: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.visible === visible) return;
    entry.visible = visible;
    if (visible) entry.lastActive = this.stamp();
    if (this.settleMs <= 0) {
      this.rebalance();
      return;
    }
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.rebalance();
    }, this.settleMs);
  }

  /** The user asked for this frame (clicked a parked one, or is using it). */
  touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.lastActive = this.stamp();
    this.rebalance();
  }

  isLive(id: string): boolean {
    return this.entries.get(id)?.live ?? false;
  }

  /** Strictly increasing, so two events in the same millisecond still have an order. */
  private stamp(): number {
    this.clock = Math.max(this.clock + 1, this.now());
    return this.clock;
  }

  private rebalance(): void {
    const ranked = [...this.entries.entries()]
      .filter(([, entry]) => entry.lastActive > 0)
      .sort(([, a], [, b]) => Number(b.visible) - Number(a.visible) || b.lastActive - a.lastActive);
    const winners = new Set(ranked.slice(0, this.limit).map(([id]) => id));
    const changed: SlotEntry[] = [];
    for (const [id, entry] of this.entries) {
      const live = winners.has(id);
      if (entry.live !== live) {
        entry.live = live;
        changed.push(entry);
      }
    }
    // Park first, so the outgoing frame unloads before the incoming one loads.
    changed.sort((a, b) => Number(a.live) - Number(b.live));
    for (const entry of changed) entry.notify(entry.live);
  }
}

export const liveFrameSlots = new LiveFrameSlots();
