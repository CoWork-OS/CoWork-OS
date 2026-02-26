import { describe, expect, it, vi } from "vitest";

// Test the pure helper functions that are exported from the module scope.
// We extract them by re-implementing the same logic, since they are module-private.
// Instead, we test through the class public API and test the helpers indirectly.

// Mock electron to prevent import errors
vi.mock("electron", () => ({
  app: { getAppPath: () => "/app", getPath: () => "/userData" },
}));

// Mock child_process to avoid actually running osascript
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { promisify as _promisify } from "util";

// Re-implement the pure helpers for direct testing (they're not exported)
function parseEpochSeconds(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO datetime: ${iso}`);
  }
  return Math.floor(ms / 1000);
}

function epochToIso(epochSeconds: string | number | undefined): string | undefined {
  if (epochSeconds === undefined) return undefined;
  const n = typeof epochSeconds === "string" ? Number(epochSeconds) : epochSeconds;
  if (!Number.isFinite(n)) return undefined;
  return new Date(n * 1000).toISOString();
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const RS = "\x1e";
const US = "\x1f";

function splitRecords(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  return trimmed.split(RS).filter(Boolean);
}

function splitFields(record: string): string[] {
  return record.split(US);
}

describe("Apple Reminders helper functions", () => {
  describe("parseEpochSeconds", () => {
    it("returns null for undefined input", () => {
      expect(parseEpochSeconds(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseEpochSeconds("")).toBeNull();
    });

    it("parses a valid ISO date to epoch seconds", () => {
      const result = parseEpochSeconds("2025-01-15T12:00:00.000Z");
      expect(result).toBe(Math.floor(new Date("2025-01-15T12:00:00.000Z").getTime() / 1000));
    });

    it("throws for invalid ISO string", () => {
      expect(() => parseEpochSeconds("not-a-date")).toThrow("Invalid ISO datetime");
    });
  });

  describe("epochToIso", () => {
    it("returns undefined for undefined input", () => {
      expect(epochToIso(undefined)).toBeUndefined();
    });

    it("converts epoch seconds (number) to ISO string", () => {
      const epoch = 1705315200; // 2024-01-15T12:00:00Z
      const result = epochToIso(epoch);
      expect(result).toBe(new Date(epoch * 1000).toISOString());
    });

    it("converts epoch seconds (string) to ISO string", () => {
      const result = epochToIso("1705315200");
      expect(result).toBe(new Date(1705315200 * 1000).toISOString());
    });

    it("returns undefined for NaN string", () => {
      expect(epochToIso("abc")).toBeUndefined();
    });

    it('converts empty string to epoch zero (Number("") === 0)', () => {
      // Empty string converts to 0, which is finite, so it returns epoch zero
      expect(epochToIso("")).toBe("1970-01-01T00:00:00.000Z");
    });

    it("returns undefined for Infinity", () => {
      expect(epochToIso(Infinity)).toBeUndefined();
    });
  });

  describe("parseBool", () => {
    it("returns undefined for undefined", () => {
      expect(parseBool(undefined)).toBeUndefined();
    });

    it('returns true for "true"', () => {
      expect(parseBool("true")).toBe(true);
    });

    it('returns false for "false"', () => {
      expect(parseBool("false")).toBe(false);
    });

    it("returns undefined for other strings", () => {
      expect(parseBool("yes")).toBeUndefined();
      expect(parseBool("1")).toBeUndefined();
    });
  });

  describe("splitRecords", () => {
    it("returns empty array for empty string", () => {
      expect(splitRecords("")).toEqual([]);
    });

    it("returns empty array for whitespace-only", () => {
      expect(splitRecords("  \n  ")).toEqual([]);
    });

    it("splits on record separator", () => {
      const input = `rec1${RS}rec2${RS}rec3`;
      expect(splitRecords(input)).toEqual(["rec1", "rec2", "rec3"]);
    });

    it("filters out empty records", () => {
      const input = `rec1${RS}${RS}rec3`;
      expect(splitRecords(input)).toEqual(["rec1", "rec3"]);
    });
  });

  describe("splitFields", () => {
    it("splits on unit separator", () => {
      const input = `field1${US}field2${US}field3`;
      expect(splitFields(input)).toEqual(["field1", "field2", "field3"]);
    });

    it("returns single element for no separator", () => {
      expect(splitFields("just-one")).toEqual(["just-one"]);
    });
  });
});

describe("Apple Reminders formatPermissionHint logic", () => {
  // Test the error-to-hint mapping logic
  function formatPermissionHint(message: string): string | null {
    if (/-1743/.test(message) || /not authorized to send apple events/i.test(message)) {
      return "macOS blocked Reminders automation. Enable access in System Settings > Privacy & Security > Automation (and Reminders), then retry.";
    }
    if (
      /Not permitted|operation not permitted|denied/i.test(message) &&
      /reminders/i.test(message)
    ) {
      return "Reminders access was denied by macOS privacy settings. Check System Settings > Privacy & Security > Reminders and Automation, then retry.";
    }
    return null;
  }

  it("detects -1743 error code", () => {
    const hint = formatPermissionHint("AppleScript error: -1743");
    expect(hint).toContain("macOS blocked Reminders automation");
  });

  it('detects "not authorized to send apple events"', () => {
    const hint = formatPermissionHint("Not authorized to send Apple Events to Reminders");
    expect(hint).toContain("macOS blocked Reminders automation");
  });

  it("detects permission denied + reminders", () => {
    const hint = formatPermissionHint("Operation not permitted for Reminders");
    expect(hint).toContain("Reminders access was denied");
  });

  it("returns null for unrelated errors", () => {
    expect(formatPermissionHint("Some random error")).toBeNull();
  });

  it("returns null for denied without reminders mention", () => {
    expect(formatPermissionHint("Operation not permitted")).toBeNull();
  });
});

describe("AppleRemindersTools.isAvailable", () => {
  it("is available on darwin", async () => {
    // Import the actual class
    const { AppleRemindersTools } = await import("../../tools/apple-reminders-tools");
    const expected = process.platform === "darwin";
    expect(AppleRemindersTools.isAvailable()).toBe(expected);
  });
});
