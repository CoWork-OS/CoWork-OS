import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock @chenglou/pretext before importing the adapter
vi.mock("@chenglou/pretext", () => ({
  prepare: vi.fn(() => ({ __brand: "prepared" })),
  layout: vi.fn(() => ({ lineCount: 3, height: 60 })),
  clearCache: vi.fn(),
}));

// Mock DOM APIs that the adapter uses
const mockComputedStyle = {
  fontFamily: '"SF Pro Display", -apple-system, sans-serif',
  fontSize: "14px",
  getPropertyValue: vi.fn((prop: string) => {
    if (prop === "--density-timeline-event-intrinsic-size") return "40px";
    return "";
  }),
};

vi.stubGlobal("getComputedStyle", vi.fn(() => mockComputedStyle));
vi.stubGlobal("document", {
  documentElement: {},
});

// Provide localStorage mock
const storageMap = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => storageMap.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storageMap.set(key, value)),
  removeItem: vi.fn((key: string) => storageMap.delete(key)),
});

import { prepare, layout, clearCache } from "@chenglou/pretext";
import {
  isPretextEnabled,
  getResolvedFont,
  PretextMeasurer,
  getGlobalMeasurer,
  invalidateGlobalMeasurer,
} from "../pretext-adapter";

describe("isPretextEnabled", () => {
  beforeEach(() => storageMap.clear());

  it("returns true by default (no localStorage entry)", () => {
    expect(isPretextEnabled()).toBe(true);
  });

  it("returns true when explicitly set to 'true'", () => {
    storageMap.set("pretext-virtualization-enabled", "true");
    expect(isPretextEnabled()).toBe(true);
  });

  it("returns false when set to 'false'", () => {
    storageMap.set("pretext-virtualization-enabled", "false");
    expect(isPretextEnabled()).toBe(false);
  });
});

describe("getResolvedFont", () => {
  it("reads font from getComputedStyle", () => {
    const font = getResolvedFont();
    expect(font.fontFamily).toBe('"SF Pro Display", -apple-system, sans-serif');
    expect(font.fontSize).toBe(14);
  });
});

describe("PretextMeasurer", () => {
  let measurer: PretextMeasurer;

  beforeEach(() => {
    vi.mocked(prepare).mockClear();
    vi.mocked(layout).mockClear();
    measurer = new PretextMeasurer({ fontFamily: "Arial", fontSize: 16 });
  });

  it("calls prepare() for each unique text", () => {
    measurer.prepare(["hello", "world", "hello"]);
    expect(prepare).toHaveBeenCalledTimes(2); // "hello" deduped
  });

  it("returns computed height from layout()", () => {
    measurer.prepare(["test"]);
    const height = measurer.getHeight("test", 300);
    expect(layout).toHaveBeenCalledWith({ __brand: "prepared" }, 300, 24); // 16 * 1.5
    expect(height).toBe(60);
  });

  it("returns estimated height for unprepared text", () => {
    const height = measurer.getHeight("unknown", 300);
    expect(height).toBe(40); // from CSS variable mock
  });

  it("getHeights returns array of heights in order", () => {
    measurer.prepare(["a", "b"]);
    const heights = measurer.getHeights(["a", "b"], 300);
    expect(heights).toHaveLength(2);
    expect(heights[0]).toBe(60);
    expect(heights[1]).toBe(60);
  });

  it("invalidate clears cache and calls clearCache", () => {
    measurer.prepare(["cached"]);
    measurer.invalidate();
    // After invalidation, text is no longer prepared — falls back to estimate
    vi.mocked(layout).mockClear();
    const height = measurer.getHeight("cached", 300);
    expect(layout).not.toHaveBeenCalled();
    expect(height).toBe(40);
    expect(clearCache).toHaveBeenCalled();
  });
});

describe("global measurer", () => {
  afterEach(() => invalidateGlobalMeasurer());

  it("returns a singleton measurer", () => {
    const a = getGlobalMeasurer();
    const b = getGlobalMeasurer();
    expect(a).toBe(b);
  });

  it("invalidateGlobalMeasurer creates a new instance on next call", () => {
    const a = getGlobalMeasurer();
    invalidateGlobalMeasurer();
    const b = getGlobalMeasurer();
    expect(a).not.toBe(b);
  });
});
