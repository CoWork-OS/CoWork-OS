import { describe, expect, it } from 'vitest';
import { getChannelRegistry } from '../channel-registry';

describe('ChannelRegistry', () => {
  const registry = getChannelRegistry();

  it('requires email mode fields for IMAP/SMTP email configs', () => {
    const result = registry.validateConfig('email', {
      protocol: 'imap-smtp',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: email');
    expect(result.errors).toContain('Missing required field: password');
    expect(result.errors).toContain('Missing required field: imapHost');
    expect(result.errors).toContain('Missing required field: smtpHost');
  });

  it('requires Loom credentials for Loom email configs', () => {
    const result = registry.validateConfig('email', {
      protocol: 'loom',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: loomBaseUrl');
    expect(result.errors).toContain('Missing required field: loomAccessToken');
  });

  it('rejects invalid LOOM folder names', () => {
    const result = registry.validateConfig('email', {
      protocol: 'loom',
      loomBaseUrl: 'http://127.0.0.1',
      loomAccessToken: 'token',
      loomMailboxFolder: 'INBOX/../Work',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('LOOM mailbox folder contains invalid characters');
  });

  it('rejects invalid email protocols', () => {
    const result = registry.validateConfig('email', {
      protocol: 'smtp2',
      imapHost: 'imap.example.com',
      smtpHost: 'smtp.example.com',
      email: 'test@example.com',
      password: 'secret',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid email protocol: smtp2');
  });
});
