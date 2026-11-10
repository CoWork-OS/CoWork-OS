import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_USE_CASES_EVENT,
  requestUseCasesGallery,
  requestUseCasesGalleryWhenReady,
} from "../use-cases-events";

describe("use-cases gallery requests", () => {
  let target: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    target = new EventTarget();
    vi.stubGlobal("window", target);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const listen = () =>
    target.addEventListener(OPEN_USE_CASES_EVENT, (event) => event.preventDefault());

  it("reports whether a mounted surface opened its gallery", () => {
    expect(requestUseCasesGallery()).toBe(false);
    listen();
    expect(requestUseCasesGallery()).toBe(true);
  });

  it("keeps asking until a new session's welcome screen listens", async () => {
    const result = requestUseCasesGalleryWhenReady(1000, 50);
    await vi.advanceTimersByTimeAsync(200);
    listen();
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe(true);
  });

  it("gives up when nothing listens in time", async () => {
    const result = requestUseCasesGalleryWhenReady(300, 50);
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toBe(false);
  });
});
