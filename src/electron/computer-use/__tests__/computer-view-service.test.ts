import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerViewService } from "../computer-view-service";
import { COMPUTER_VIEW_POLL_MS } from "../../../shared/computer-view";

const makeService = (overrides: Record<string, unknown> = {}) => {
  const deps = {
    encodeFrame: vi.fn((png: Buffer) => ({
      dataUrl: `data:image/jpeg;base64,${png.toString("base64")}`,
      width: 960,
      height: 600,
    })),
    captureBrowser: vi.fn(async () => ({ png: Buffer.from("page"), label: "Example" })),
    setBrowserPaused: vi.fn(),
    logEvent: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  };
  return { service: new ComputerViewService(deps as Any), deps };
};

describe("ComputerViewService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the latest frame a tool captured and reports it", () => {
    const { service, deps } = makeService();
    service.publishFrame(
      "t1",
      "this_computer",
      Buffer.from("shot").toString("base64"),
      "Safari — Cart",
    );
    const state = service.getState("t1");
    expect(state.status).toBe("working");
    expect(state.surface).toBe("this_computer");
    expect(state.frame?.label).toBe("Safari — Cart");
    expect(state.frame?.dataUrl).toContain("data:image/jpeg");
    expect(deps.notify).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "t1" }));
  });

  it("refuses the bot's actions and captures nothing while the person has control", () => {
    const { service, deps } = makeService();
    service.takeOver("t1");
    expect(service.isHeldByPerson("t1")).toBe(true);
    expect(deps.setBrowserPaused).toHaveBeenCalledWith("t1", true);
    expect(deps.logEvent).toHaveBeenCalledWith("t1", "computer_taken_over", {});
    expect(() => service.assertNotHeld("t1")).toThrow(/taken over/);
    service.publishFrame("t1", "browser", Buffer.from("x"));
    expect(service.getState("t1").frame).toBeUndefined();

    service.handBack("t1");
    expect(service.isHeldByPerson("t1")).toBe(false);
    expect(deps.setBrowserPaused).toHaveBeenLastCalledWith("t1", false);
    expect(() => service.assertNotHeld("t1")).not.toThrow();
  });

  it("records a bot's request to take over, trimmed, until the person takes over", () => {
    const { service, deps } = makeService();
    service.requestTakeover("t1", `  Approve the  2FA prompt ${"x".repeat(400)}`);
    const request = service.getState("t1").takeoverRequest;
    expect(request?.reason.startsWith("Approve the 2FA prompt")).toBe(true);
    expect(request?.reason.length).toBeLessThanOrEqual(300);
    expect(deps.logEvent).toHaveBeenCalledWith(
      "t1",
      "computer_takeover_requested",
      expect.objectContaining({ reason: expect.any(String) }),
    );
    service.takeOver("t1");
    expect(service.getState("t1").takeoverRequest).toBeUndefined();
  });

  it("keeps a take-over and the last frame when the bot's run ends", () => {
    const { service } = makeService();
    service.publishFrame("t1", "browser", Buffer.from("x"));
    service.noteTaskEnded("t1");
    expect(service.getState("t1").status).toBe("idle");
    expect(service.getState("t1").frame).toBeDefined();
    service.takeOver("t1");
    service.noteTaskEnded("t1");
    expect(service.isHeldByPerson("t1")).toBe(true);
  });

  it("captures the browser on a timer only while someone watches it working", async () => {
    const { service, deps } = makeService();
    service.noteWorking("t1", "browser");
    await vi.advanceTimersByTimeAsync(COMPUTER_VIEW_POLL_MS * 2);
    expect(deps.captureBrowser).not.toHaveBeenCalled();

    service.watch("t1");
    await vi.advanceTimersByTimeAsync(COMPUTER_VIEW_POLL_MS);
    expect(deps.captureBrowser).toHaveBeenCalledTimes(1);
    expect(service.getState("t1").frame?.label).toBe("Example");

    service.unwatch("t1");
    await vi.advanceTimersByTimeAsync(COMPUTER_VIEW_POLL_MS * 2);
    expect(deps.captureBrowser).toHaveBeenCalledTimes(1);
  });

  it("shows waiting until the task gets the computer", () => {
    const { service } = makeService();
    service.noteWaiting("t1");
    expect(service.getState("t1").status).toBe("waiting");
    service.noteWorking("t1", "this_computer");
    expect(service.getState("t1").status).toBe("working");
    service.noteReleased("t1", "this_computer");
    expect(service.getState("t1").status).toBe("idle");
  });

  it("skips a frame it cannot decode", () => {
    const { service } = makeService({ encodeFrame: vi.fn(() => null) });
    service.publishFrame("t1", "browser", Buffer.from("broken"));
    expect(service.getState("t1").frame).toBeUndefined();
  });
});
