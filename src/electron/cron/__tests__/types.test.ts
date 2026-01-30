/**
 * Tests for cron types and utility functions
 */

import { describe, it, expect } from 'vitest';
import { describeSchedule, parseIntervalToMs, type CronSchedule } from '../types';

describe('describeSchedule', () => {
  describe('at schedule (one-time)', () => {
    it('should format a future date correctly', () => {
      const schedule: CronSchedule = {
        kind: 'at',
        atMs: new Date('2025-12-25T10:00:00').getTime(),
      };
      const result = describeSchedule(schedule);
      expect(result).toMatch(/Once at/);
      expect(result).toMatch(/12\/25\/2025|25\/12\/2025/); // Locale-dependent
    });
  });

  describe('every schedule (interval)', () => {
    it('should describe seconds interval', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 30000 };
      expect(describeSchedule(schedule)).toBe('Every 30 seconds');
    });

    it('should describe minutes interval', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 60000 };
      expect(describeSchedule(schedule)).toBe('Every 1 minute');
    });

    it('should describe multiple minutes interval', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 300000 };
      expect(describeSchedule(schedule)).toBe('Every 5 minutes');
    });

    it('should describe hours interval', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 3600000 };
      expect(describeSchedule(schedule)).toBe('Every 1 hour');
    });

    it('should describe multiple hours interval', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 7200000 };
      expect(describeSchedule(schedule)).toBe('Every 2 hours');
    });

    it('should describe days interval', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 86400000 };
      expect(describeSchedule(schedule)).toBe('Every 1 day');
    });

    it('should describe multiple days interval', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 172800000 };
      expect(describeSchedule(schedule)).toBe('Every 2 days');
    });
  });

  describe('cron schedule', () => {
    it('should describe every hour cron', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 * * * *' };
      expect(describeSchedule(schedule)).toBe('Every hour');
    });

    it('should describe every 15 minutes cron', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '*/15 * * * *' };
      expect(describeSchedule(schedule)).toBe('Every 15 minutes');
    });

    it('should describe every 30 minutes cron', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '*/30 * * * *' };
      expect(describeSchedule(schedule)).toBe('Every 30 minutes');
    });

    it('should describe daily at midnight cron', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 0 * * *' };
      expect(describeSchedule(schedule)).toBe('Daily at midnight');
    });

    it('should describe daily at 9:00 AM cron', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *' };
      expect(describeSchedule(schedule)).toBe('Daily at 9:00 AM');
    });

    it('should describe weekdays at 9:00 AM cron', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * 1-5' };
      expect(describeSchedule(schedule)).toBe('Weekdays at 9:00 AM');
    });

    it('should describe weekly on Sunday cron', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 0 * * 0' };
      expect(describeSchedule(schedule)).toBe('Weekly on Sunday');
    });

    it('should describe monthly on the 1st cron', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 0 1 * *' };
      expect(describeSchedule(schedule)).toBe('Monthly on the 1st');
    });

    it('should show raw expression for unknown cron patterns', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '30 14 * * 2' };
      expect(describeSchedule(schedule)).toBe('Cron: 30 14 * * 2');
    });

    it('should include timezone if provided', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '30 14 * * 2', tz: 'America/New_York' };
      expect(describeSchedule(schedule)).toBe('Cron: 30 14 * * 2 (America/New_York)');
    });
  });
});

describe('parseIntervalToMs', () => {
  describe('seconds', () => {
    it('should parse "5s"', () => {
      expect(parseIntervalToMs('5s')).toBe(5000);
    });

    it('should parse "5sec"', () => {
      expect(parseIntervalToMs('5sec')).toBe(5000);
    });

    it('should parse "5second"', () => {
      expect(parseIntervalToMs('5second')).toBe(5000);
    });

    it('should parse "5seconds"', () => {
      expect(parseIntervalToMs('5seconds')).toBe(5000);
    });

    it('should parse "30 seconds" with space', () => {
      expect(parseIntervalToMs('30 seconds')).toBe(30000);
    });
  });

  describe('minutes', () => {
    it('should parse "5m"', () => {
      expect(parseIntervalToMs('5m')).toBe(300000);
    });

    it('should parse "5min"', () => {
      expect(parseIntervalToMs('5min')).toBe(300000);
    });

    it('should parse "5minute"', () => {
      expect(parseIntervalToMs('5minute')).toBe(300000);
    });

    it('should parse "5minutes"', () => {
      expect(parseIntervalToMs('5minutes')).toBe(300000);
    });

    it('should parse "1 minute" with space', () => {
      expect(parseIntervalToMs('1 minute')).toBe(60000);
    });
  });

  describe('hours', () => {
    it('should parse "1h"', () => {
      expect(parseIntervalToMs('1h')).toBe(3600000);
    });

    it('should parse "1hr"', () => {
      expect(parseIntervalToMs('1hr')).toBe(3600000);
    });

    it('should parse "1hour"', () => {
      expect(parseIntervalToMs('1hour')).toBe(3600000);
    });

    it('should parse "2hours"', () => {
      expect(parseIntervalToMs('2hours')).toBe(7200000);
    });

    it('should parse "24 hours"', () => {
      expect(parseIntervalToMs('24 hours')).toBe(86400000);
    });
  });

  describe('days', () => {
    it('should parse "1d"', () => {
      expect(parseIntervalToMs('1d')).toBe(86400000);
    });

    it('should parse "1day"', () => {
      expect(parseIntervalToMs('1day')).toBe(86400000);
    });

    it('should parse "7days"', () => {
      expect(parseIntervalToMs('7days')).toBe(604800000);
    });

    it('should parse "30 days"', () => {
      expect(parseIntervalToMs('30 days')).toBe(2592000000);
    });
  });

  describe('decimals', () => {
    it('should parse "1.5h"', () => {
      expect(parseIntervalToMs('1.5h')).toBe(5400000);
    });

    it('should parse "0.5d"', () => {
      expect(parseIntervalToMs('0.5d')).toBe(43200000);
    });
  });

  describe('case insensitivity', () => {
    it('should parse uppercase "5M"', () => {
      expect(parseIntervalToMs('5M')).toBe(300000);
    });

    it('should parse "5HOURS"', () => {
      expect(parseIntervalToMs('5HOURS')).toBe(18000000);
    });
  });

  describe('invalid inputs', () => {
    it('should return null for invalid format', () => {
      expect(parseIntervalToMs('invalid')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(parseIntervalToMs('')).toBeNull();
    });

    it('should return null for just a number', () => {
      expect(parseIntervalToMs('5')).toBeNull();
    });

    it('should return null for unknown unit', () => {
      expect(parseIntervalToMs('5weeks')).toBeNull();
    });
  });

  describe('whitespace handling', () => {
    it('should handle leading/trailing whitespace', () => {
      expect(parseIntervalToMs('  5m  ')).toBe(300000);
    });
  });
});
