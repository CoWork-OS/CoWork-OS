/**
 * Tests for hooks types and defaults
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HOOKS_CONFIG,
  DEFAULT_HOOKS_PATH,
  DEFAULT_HOOKS_MAX_BODY_BYTES,
  DEFAULT_HOOKS_PORT,
  DEFAULT_GMAIL_LABEL,
  DEFAULT_GMAIL_TOPIC,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_SERVE_BIND,
  DEFAULT_GMAIL_SERVE_PORT,
  DEFAULT_GMAIL_SERVE_PATH,
  DEFAULT_GMAIL_MAX_BYTES,
  DEFAULT_GMAIL_RENEW_MINUTES,
  GMAIL_PRESET_MAPPING,
  RESEND_PRESET_MAPPING,
  HOOK_PRESET_MAPPINGS,
} from '../types';

describe('hooks default values', () => {
  describe('general hooks defaults', () => {
    it('should have correct default path', () => {
      expect(DEFAULT_HOOKS_PATH).toBe('/hooks');
    });

    it('should have correct default max body bytes (256KB)', () => {
      expect(DEFAULT_HOOKS_MAX_BODY_BYTES).toBe(256 * 1024);
    });

    it('should have correct default port', () => {
      expect(DEFAULT_HOOKS_PORT).toBe(9877);
    });
  });

  describe('Gmail defaults', () => {
    it('should have correct default Gmail label', () => {
      expect(DEFAULT_GMAIL_LABEL).toBe('INBOX');
    });

    it('should have correct default Gmail topic', () => {
      expect(DEFAULT_GMAIL_TOPIC).toBe('cowork-gmail-watch');
    });

    it('should have correct default Gmail subscription', () => {
      expect(DEFAULT_GMAIL_SUBSCRIPTION).toBe('cowork-gmail-watch-push');
    });

    it('should have correct default Gmail serve bind', () => {
      expect(DEFAULT_GMAIL_SERVE_BIND).toBe('127.0.0.1');
    });

    it('should have correct default Gmail serve port', () => {
      expect(DEFAULT_GMAIL_SERVE_PORT).toBe(8788);
    });

    it('should have correct default Gmail serve path', () => {
      expect(DEFAULT_GMAIL_SERVE_PATH).toBe('/gmail-pubsub');
    });

    it('should have correct default Gmail max bytes', () => {
      expect(DEFAULT_GMAIL_MAX_BYTES).toBe(20_000);
    });

    it('should have correct default Gmail renew minutes (12 hours)', () => {
      expect(DEFAULT_GMAIL_RENEW_MINUTES).toBe(12 * 60);
    });
  });

  describe('DEFAULT_HOOKS_CONFIG', () => {
    it('should be disabled by default', () => {
      expect(DEFAULT_HOOKS_CONFIG.enabled).toBe(false);
    });

    it('should have empty token by default', () => {
      expect(DEFAULT_HOOKS_CONFIG.token).toBe('');
    });

    it('should have correct default path', () => {
      expect(DEFAULT_HOOKS_CONFIG.path).toBe(DEFAULT_HOOKS_PATH);
    });

    it('should have correct default max body bytes', () => {
      expect(DEFAULT_HOOKS_CONFIG.maxBodyBytes).toBe(DEFAULT_HOOKS_MAX_BODY_BYTES);
    });

    it('should have empty presets by default', () => {
      expect(DEFAULT_HOOKS_CONFIG.presets).toEqual([]);
    });

    it('should have empty mappings by default', () => {
      expect(DEFAULT_HOOKS_CONFIG.mappings).toEqual([]);
    });
  });
});

describe('Gmail preset mapping', () => {
  it('should have correct id', () => {
    expect(GMAIL_PRESET_MAPPING.id).toBe('gmail');
  });

  it('should match gmail path', () => {
    expect(GMAIL_PRESET_MAPPING.match?.path).toBe('gmail');
  });

  it('should use agent action', () => {
    expect(GMAIL_PRESET_MAPPING.action).toBe('agent');
  });

  it('should use now wake mode', () => {
    expect(GMAIL_PRESET_MAPPING.wakeMode).toBe('now');
  });

  it('should have Gmail name', () => {
    expect(GMAIL_PRESET_MAPPING.name).toBe('Gmail');
  });

  it('should have session key template', () => {
    expect(GMAIL_PRESET_MAPPING.sessionKey).toBe('hook:gmail:{{messages[0].id}}');
  });

  it('should have message template with from, subject, snippet, and body', () => {
    const template = GMAIL_PRESET_MAPPING.messageTemplate;
    expect(template).toContain('{{messages[0].from}}');
    expect(template).toContain('{{messages[0].subject}}');
    expect(template).toContain('{{messages[0].snippet}}');
    expect(template).toContain('{{messages[0].body}}');
  });
});

describe('HOOK_PRESET_MAPPINGS', () => {
  it('should have gmail preset', () => {
    expect(HOOK_PRESET_MAPPINGS).toHaveProperty('gmail');
  });

  it('should have resend preset', () => {
    expect(HOOK_PRESET_MAPPINGS).toHaveProperty('resend');
  });

  it('should have gmail preset as array with one mapping', () => {
    expect(Array.isArray(HOOK_PRESET_MAPPINGS.gmail)).toBe(true);
    expect(HOOK_PRESET_MAPPINGS.gmail).toHaveLength(1);
  });

  it('should have gmail preset mapping matching GMAIL_PRESET_MAPPING', () => {
    expect(HOOK_PRESET_MAPPINGS.gmail[0]).toEqual(GMAIL_PRESET_MAPPING);
  });

  it('should have resend preset mapping matching RESEND_PRESET_MAPPING', () => {
    expect(HOOK_PRESET_MAPPINGS.resend[0]).toEqual(RESEND_PRESET_MAPPING);
  });
});
