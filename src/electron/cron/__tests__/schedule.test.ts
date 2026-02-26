/**
 * Tests for cron schedule computation
 */

import { describe, it, expect, beforeEach, vi as _vi, afterEach } from "vitest";
import { computeNextRunAtMs } from "../schedule";
import type { CronSchedule } from "../types";

describe("computeNextRunAtMs", () => {
  describe("at schedule (one-time)", () => {
    it("should return the exact timestamp for future time", () => {
      const futureTime = Date.now() + 3600000; // 1 hour from now
      const schedule: CronSchedule = { kind: "at", atMs: futureTime };
      expect(computeNextRunAtMs(schedule, Date.now())).toBe(futureTime);
    });

    it("should return undefined for past time", () => {
      const pastTime = Date.now() - 3600000; // 1 hour ago
      const schedule: CronSchedule = { kind: "at", atMs: pastTime };
      expect(computeNextRunAtMs(schedule, Date.now())).toBeUndefined();
    });

    it("should return undefined for current time (already due)", () => {
      const now = Date.now();
      const schedule: CronSchedule = { kind: "at", atMs: now };
      expect(computeNextRunAtMs(schedule, now + 1)).toBeUndefined();
    });
  });

  describe("every schedule (interval)", () => {
    it("should compute first run from now if no anchor", () => {
      const now = 1000000;
      const schedule: CronSchedule = { kind: "every", everyMs: 60000 }; // Every minute
      const result = computeNextRunAtMs(schedule, now);
      expect(result).toBe(now + 60000);
    });

    it("should align to anchor time", () => {
      const anchorMs = 1000000;
      const now = 1000500; // 500ms after anchor
      const schedule: CronSchedule = { kind: "every", everyMs: 1000, anchorMs };
      const result = computeNextRunAtMs(schedule, now);
      // Next aligned time should be anchor + 1000 = 1001000
      expect(result).toBe(1001000);
    });

    it("should return current interval when exactly at boundary", () => {
      const anchorMs = 1000000;
      const now = 1001000; // Exactly at anchor + 1 interval
      const schedule: CronSchedule = { kind: "every", everyMs: 1000, anchorMs };
      const result = computeNextRunAtMs(schedule, now);
      // When exactly at an interval boundary, returns that interval time
      // (caller will run job and call again for next interval)
      expect(result).toBe(1001000);
    });

    it("should advance to next interval when past boundary", () => {
      const anchorMs = 1000000;
      const now = 1001001; // 1ms past anchor + 1 interval
      const schedule: CronSchedule = { kind: "every", everyMs: 1000, anchorMs };
      const result = computeNextRunAtMs(schedule, now);
      // Just past an interval, next should be anchor + 2000
      expect(result).toBe(1002000);
    });

    it("should handle large intervals", () => {
      const now = Date.now();
      const schedule: CronSchedule = { kind: "every", everyMs: 86400000 }; // Daily
      const result = computeNextRunAtMs(schedule, now);
      expect(result).toBe(now + 86400000);
    });

    it("should compute correct interval when past anchor", () => {
      const anchorMs = 0; // Epoch
      const now = 5500; // 5.5 seconds after epoch
      const schedule: CronSchedule = { kind: "every", everyMs: 2000, anchorMs };
      const result = computeNextRunAtMs(schedule, now);
      // Anchor points: 0, 2000, 4000, 6000
      // now is 5500, next should be 6000
      expect(result).toBe(6000);
    });
  });

  describe("cron schedule", () => {
    let originalDate: typeof Date;

    beforeEach(() => {
      // We'll use a fixed date for testing cron expressions
      originalDate = global.Date;
    });

    afterEach(() => {
      global.Date = originalDate;
    });

    it("should return undefined for invalid cron expression", () => {
      const schedule: CronSchedule = { kind: "cron", expr: "invalid" };
      const result = computeNextRunAtMs(schedule, Date.now());
      expect(result).toBeUndefined();
    });

    it("should return undefined for cron with wrong number of fields", () => {
      const schedule: CronSchedule = { kind: "cron", expr: "* * *" }; // Only 3 fields
      const result = computeNextRunAtMs(schedule, Date.now());
      expect(result).toBeUndefined();
    });

    it('should compute next minute for "* * * * *"', () => {
      // Set a fixed time: Jan 15, 2025, 10:30:15
      const now = new Date("2025-01-15T10:30:15.000Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "* * * * *" };
      const result = computeNextRunAtMs(schedule, now);

      // Should be next minute: 10:31:00
      expect(result).toBeDefined();
      if (result) {
        const resultDate = new Date(result);
        expect(resultDate.getUTCMinutes()).toBe(31);
        expect(resultDate.getUTCSeconds()).toBe(0);
      }
    });

    it('should compute next hour for "0 * * * *"', () => {
      // Set a fixed time: Jan 15, 2025, 10:30:15
      const now = new Date("2025-01-15T10:30:15.000Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "0 * * * *" };
      const result = computeNextRunAtMs(schedule, now);

      // Should be next hour at minute 0: 11:00:00
      expect(result).toBeDefined();
      if (result) {
        const resultDate = new Date(result);
        expect(resultDate.getUTCHours()).toBe(11);
        expect(resultDate.getUTCMinutes()).toBe(0);
      }
    });

    it('should compute specific minute "30 * * * *"', () => {
      // Set a fixed time: Jan 15, 2025, 10:15:00
      const now = new Date("2025-01-15T10:15:00.000Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "30 * * * *" };
      const result = computeNextRunAtMs(schedule, now);

      // Should be 10:30:00
      expect(result).toBeDefined();
      if (result) {
        const resultDate = new Date(result);
        expect(resultDate.getUTCHours()).toBe(10);
        expect(resultDate.getUTCMinutes()).toBe(30);
      }
    });

    it("should skip to next occurrence if current minute passed", () => {
      // Set a fixed time: Jan 15, 2025, 10:45:00 (past minute 30)
      const now = new Date("2025-01-15T10:45:00.000Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "30 * * * *" };
      const result = computeNextRunAtMs(schedule, now);

      // Should be 11:30:00
      expect(result).toBeDefined();
      if (result) {
        const resultDate = new Date(result);
        expect(resultDate.getUTCHours()).toBe(11);
        expect(resultDate.getUTCMinutes()).toBe(30);
      }
    });

    it('should handle specific hour "0 9 * * *"', () => {
      // Set a fixed time: Jan 15, 2025, 10:00:00 (past 9am)
      const now = new Date("2025-01-15T10:00:00.000Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "0 9 * * *" };
      const result = computeNextRunAtMs(schedule, now);

      // Should be next day at 9:00
      expect(result).toBeDefined();
      if (result) {
        const resultDate = new Date(result);
        expect(resultDate.getUTCDate()).toBe(16);
        expect(resultDate.getUTCHours()).toBe(9);
        expect(resultDate.getUTCMinutes()).toBe(0);
      }
    });

    it('should handle step syntax "*/15 * * * *"', () => {
      // Set a fixed time: Jan 15, 2025, 10:07:00
      const now = new Date("2025-01-15T10:07:00.000Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "*/15 * * * *" };
      const result = computeNextRunAtMs(schedule, now);

      // Should be 10:15:00
      expect(result).toBeDefined();
      if (result) {
        const resultDate = new Date(result);
        expect(resultDate.getUTCMinutes()).toBe(15);
      }
    });

    it('should handle day of week "0 9 * * 1"', () => {
      // Jan 15, 2025 is a Wednesday (day 3)
      const now = new Date("2025-01-15T10:00:00.000Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "0 9 * * 1" }; // Monday
      const result = computeNextRunAtMs(schedule, now);

      // Should be next Monday (Jan 20, 2025)
      expect(result).toBeDefined();
      if (result) {
        const resultDate = new Date(result);
        expect(resultDate.getUTCDay()).toBe(1); // Monday
        expect(resultDate.getUTCDate()).toBe(20);
      }
    });

    it('should handle day range "0 9 * * 1-5" for weekdays', () => {
      // Jan 18, 2025 is a Saturday
      const now = new Date("2025-01-18T10:00:00.000Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "0 9 * * 1-5" };
      const result = computeNextRunAtMs(schedule, now);

      // Should be next Monday (Jan 20, 2025)
      expect(result).toBeDefined();
      if (result) {
        const resultDate = new Date(result);
        expect(resultDate.getUTCDay()).toBe(1); // Monday
      }
    });

    it('should handle specific day of month "0 0 1 * *"', () => {
      // Jan 15, 2025
      const now = new Date("2025-01-15T00:00:00.000Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "0 0 1 * *" };
      const result = computeNextRunAtMs(schedule, now);

      // Should be Feb 1, 2025
      expect(result).toBeDefined();
      if (result) {
        const resultDate = new Date(result);
        expect(resultDate.getUTCMonth()).toBe(1); // February (0-indexed)
        expect(resultDate.getUTCDate()).toBe(1);
      }
    });
  });

  describe("edge cases", () => {
    it("should handle nowMs of 0", () => {
      const schedule: CronSchedule = { kind: "every", everyMs: 1000 };
      const result = computeNextRunAtMs(schedule, 0);
      expect(result).toBe(1000);
    });

    it("should handle very small intervals", () => {
      const schedule: CronSchedule = { kind: "every", everyMs: 1 };
      const now = Date.now();
      const result = computeNextRunAtMs(schedule, now);
      expect(result).toBe(now + 1);
    });
  });
});
