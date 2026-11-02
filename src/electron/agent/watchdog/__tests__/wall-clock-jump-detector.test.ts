import { describe, expect, it, vi } from "vitest";
import { WallClockJumpDetector } from "../wall-clock-jump-detector";

describe("WallClockJumpDetector", () => {
  function create(start = 1_000_000) {
    const clock = { now: start };
    const onJump = vi.fn();
    const onTick = vi.fn();
    const handle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.fn(() => handle);
    const clearIntervalSpy = vi.fn();
    const detector = new WallClockJumpDetector({
      onJump,
      onTick,
      tickMs: 30_000,
      now: () => clock.now,
      setInterval: setIntervalSpy,
      clearInterval: clearIntervalSpy,
    });
    return { clock, onJump, onTick, detector, setIntervalSpy, clearIntervalSpy, handle };
  }

  it("ticks quietly while the timer keeps time", () => {
    const { clock, onJump, onTick, detector } = create();
    detector.start();
    clock.now += 30_000;
    expect(detector.tick()).toBeNull();
    clock.now += 30_000 + 90_000; // late, but under the 2 minute threshold
    expect(detector.tick()).toBeNull();
    expect(onJump).not.toHaveBeenCalled();
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("reports a jump of more than two minutes past the expected tick as a suspend", () => {
    const { clock, onJump, onTick, detector } = create();
    detector.start();
    const before = clock.now;
    clock.now += 30_000 + 45 * 60_000;
    const jump = detector.tick();
    expect(jump).toEqual({ suspendedAt: before, resumedAt: clock.now, driftMs: 45 * 60_000 });
    expect(onJump).toHaveBeenCalledWith(jump);
    // The tick that found the jump does not refresh pre-sleep state.
    expect(onTick).not.toHaveBeenCalled();
    clock.now += 30_000;
    expect(detector.tick()).toBeNull();
  });

  it("starts once and stops its timer", () => {
    const { detector, setIntervalSpy, clearIntervalSpy, handle } = create();
    detector.start();
    detector.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    detector.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
  });
});
