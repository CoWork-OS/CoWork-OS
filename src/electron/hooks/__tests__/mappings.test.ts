/**
 * Tests for hooks mappings - path normalization, template rendering, and mapping resolution
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron app for path resolution
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

import {
  normalizeHooksPath,
  resolveHookMappings,
  applyHookMappings,
} from '../mappings';
import type {
  HooksConfig,
  HookMappingConfig,
  HookMappingResolved,
  HookMappingContext,
} from '../types';

describe('normalizeHooksPath', () => {
  it('should return default path for undefined input', () => {
    expect(normalizeHooksPath(undefined)).toBe('/hooks');
  });

  it('should return default path for empty string', () => {
    expect(normalizeHooksPath('')).toBe('/hooks');
  });

  it('should return default path for whitespace only', () => {
    expect(normalizeHooksPath('   ')).toBe('/hooks');
  });

  it('should return default path for root path', () => {
    expect(normalizeHooksPath('/')).toBe('/hooks');
  });

  it('should add leading slash if missing', () => {
    expect(normalizeHooksPath('hooks')).toBe('/hooks');
  });

  it('should preserve leading slash', () => {
    expect(normalizeHooksPath('/hooks')).toBe('/hooks');
  });

  it('should remove trailing slashes', () => {
    expect(normalizeHooksPath('/hooks/')).toBe('/hooks');
    expect(normalizeHooksPath('/hooks///')).toBe('/hooks');
  });

  it('should handle custom paths', () => {
    expect(normalizeHooksPath('/api/webhooks')).toBe('/api/webhooks');
    expect(normalizeHooksPath('api/webhooks')).toBe('/api/webhooks');
    expect(normalizeHooksPath('/api/webhooks/')).toBe('/api/webhooks');
  });
});

describe('resolveHookMappings', () => {
  it('should return empty array for undefined config', () => {
    expect(resolveHookMappings(undefined)).toEqual([]);
  });

  it('should return empty array for config with no mappings or presets', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };
    expect(resolveHookMappings(config)).toEqual([]);
  });

  it('should resolve custom mappings', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [
        {
          id: 'test-mapping',
          match: { path: 'test' },
          action: 'agent',
          messageTemplate: 'Test message: {{payload.text}}',
        },
      ],
    };

    const resolved = resolveHookMappings(config);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('test-mapping');
    expect(resolved[0].matchPath).toBe('test');
    expect(resolved[0].action).toBe('agent');
    expect(resolved[0].messageTemplate).toBe('Test message: {{payload.text}}');
  });

  it('should resolve gmail preset', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: ['gmail'],
      mappings: [],
    };

    const resolved = resolveHookMappings(config);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('gmail');
    expect(resolved[0].matchPath).toBe('gmail');
    expect(resolved[0].action).toBe('agent');
    expect(resolved[0].name).toBe('Gmail');
  });

  it('should resolve resend preset', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: ['resend'],
      mappings: [],
    };

    const resolved = resolveHookMappings(config);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('resend');
    expect(resolved[0].matchPath).toBe('resend');
    expect(resolved[0].matchType).toBe('email.received');
    expect(resolved[0].action).toBe('agent');
    expect(resolved[0].name).toBe('Resend');
  });

  it('should place custom mappings before preset mappings', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: ['gmail'],
      mappings: [
        {
          id: 'custom',
          match: { path: 'custom' },
          action: 'wake',
        },
      ],
    };

    const resolved = resolveHookMappings(config);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].id).toBe('custom');
    expect(resolved[1].id).toBe('gmail');
  });

  it('should auto-generate mapping id if not provided', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [
        {
          match: { path: 'test' },
          action: 'agent',
        },
      ],
    };

    const resolved = resolveHookMappings(config);
    expect(resolved[0].id).toBe('mapping-1');
  });

  it('should default action to agent', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [
        {
          id: 'test',
          match: { path: 'test' },
        },
      ],
    };

    const resolved = resolveHookMappings(config);
    expect(resolved[0].action).toBe('agent');
  });

  it('should default wakeMode to now', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [
        {
          id: 'test',
          match: { path: 'test' },
        },
      ],
    };

    const resolved = resolveHookMappings(config);
    expect(resolved[0].wakeMode).toBe('now');
  });
});

describe('applyHookMappings', () => {
  const createContext = (
    path: string,
    payload: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): HookMappingContext => ({
    path,
    payload,
    headers,
    url: new URL(`http://localhost/hooks/${path}`),
  });

  it('should return null for empty mappings', async () => {
    const result = await applyHookMappings([], createContext('test'));
    expect(result).toBeNull();
  });

  it('should return null when no mapping matches', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchPath: 'other',
        action: 'agent',
        wakeMode: 'now',
      },
    ];

    const result = await applyHookMappings(mappings, createContext('test'));
    expect(result).toBeNull();
  });

  it('should match by path', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchPath: 'test',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Hello',
      },
    ];

    const result = await applyHookMappings(mappings, createContext('test'));
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action) {
      expect(result.action.kind).toBe('agent');
    }
  });

  it('should match by source in payload', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchSource: 'gmail',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Hello',
      },
    ];

    const result = await applyHookMappings(
      mappings,
      createContext('webhook', { source: 'gmail' }),
    );
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
  });

  it('should not match if source does not match', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchSource: 'gmail',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Hello',
      },
    ];

    const result = await applyHookMappings(
      mappings,
      createContext('webhook', { source: 'slack' }),
    );
    expect(result).toBeNull();
  });

  it('should match by event type in payload', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchType: 'email.received',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Hello',
      },
    ];

    const result = await applyHookMappings(
      mappings,
      createContext('resend', { type: 'email.received' }),
    );
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
  });

  it('should not match if event type does not match', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchType: 'email.received',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Hello',
      },
    ];

    const result = await applyHookMappings(
      mappings,
      createContext('resend', { type: 'email.delivered' }),
    );
    expect(result).toBeNull();
  });

  it('should render template with payload values', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchPath: 'test',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Message from {{from}}: {{text}}',
      },
    ];

    const result = await applyHookMappings(
      mappings,
      createContext('test', { from: 'Alice', text: 'Hello world' }),
    );

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action && result.action.kind === 'agent') {
      expect(result.action.message).toBe('Message from Alice: Hello world');
    }
  });

  it('should render nested payload values', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchPath: 'test',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Email from {{messages[0].from}}: {{messages[0].subject}}',
      },
    ];

    const result = await applyHookMappings(
      mappings,
      createContext('test', {
        messages: [{ from: 'Bob', subject: 'Test email' }],
      }),
    );

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action && result.action.kind === 'agent') {
      expect(result.action.message).toBe('Email from Bob: Test email');
    }
  });

  it('should handle missing template values gracefully', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchPath: 'test',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Value: {{missing}}',
      },
    ];

    const result = await applyHookMappings(mappings, createContext('test', {}));

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action && result.action.kind === 'agent') {
      expect(result.action.message).toBe('Value: ');
    }
  });

  it('should build wake action for wake action type', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchPath: 'test',
        action: 'wake',
        wakeMode: 'next-heartbeat',
        textTemplate: 'Wake event: {{event}}',
      },
    ];

    const result = await applyHookMappings(
      mappings,
      createContext('test', { event: 'new-email' }),
    );

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action && result.action.kind === 'wake') {
      expect(result.action.text).toBe('Wake event: new-email');
      expect(result.action.mode).toBe('next-heartbeat');
    }
  });

  it('should fail if wake action has empty text', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchPath: 'test',
        action: 'wake',
        wakeMode: 'now',
        textTemplate: '',
      },
    ];

    const result = await applyHookMappings(mappings, createContext('test', {}));

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toContain('text');
    }
  });

  it('should fail if agent action has empty message', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchPath: 'test',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: '',
      },
    ];

    const result = await applyHookMappings(mappings, createContext('test', {}));

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toContain('message');
    }
  });

  it('should include optional agent fields', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'test',
        matchPath: 'test',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Test',
        name: 'TestHook',
        sessionKey: 'hook:test:123',
        deliver: true,
        channel: 'telegram',
        to: '12345',
        model: 'gpt-4',
        thinking: 'low',
        timeoutSeconds: 120,
      },
    ];

    const result = await applyHookMappings(mappings, createContext('test', {}));

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action && result.action.kind === 'agent') {
      expect(result.action.name).toBe('TestHook');
      expect(result.action.sessionKey).toBe('hook:test:123');
      expect(result.action.deliver).toBe(true);
      expect(result.action.channel).toBe('telegram');
      expect(result.action.to).toBe('12345');
      expect(result.action.model).toBe('gpt-4');
      expect(result.action.thinking).toBe('low');
      expect(result.action.timeoutSeconds).toBe(120);
    }
  });

  it('should use first matching mapping', async () => {
    const mappings: HookMappingResolved[] = [
      {
        id: 'first',
        matchPath: 'test',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'First',
      },
      {
        id: 'second',
        matchPath: 'test',
        action: 'agent',
        wakeMode: 'now',
        messageTemplate: 'Second',
      },
    ];

    const result = await applyHookMappings(mappings, createContext('test', {}));

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action && result.action.kind === 'agent') {
      expect(result.action.message).toBe('First');
    }
  });
});
