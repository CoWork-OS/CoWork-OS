/**
 * Tests for hooks server - configuration resolution and request handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock electron app for path resolution
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

import { resolveHooksConfig, HooksServer } from '../server';
import type { HooksConfig } from '../types';
import http from 'http';
import crypto from 'crypto';

// Helper to wait a bit between requests
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('resolveHooksConfig', () => {
  it('should return null when hooks not enabled', () => {
    const config: HooksConfig = {
      enabled: false,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    expect(resolveHooksConfig(config)).toBeNull();
  });

  it('should throw when enabled but no token', () => {
    const config: HooksConfig = {
      enabled: true,
      token: '',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    expect(() => resolveHooksConfig(config)).toThrow('hooks.enabled requires hooks.token');
  });

  it('should throw when enabled with whitespace-only token', () => {
    const config: HooksConfig = {
      enabled: true,
      token: '   ',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    expect(() => resolveHooksConfig(config)).toThrow('hooks.enabled requires hooks.token');
  });

  it('should throw when path is root', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    expect(() => resolveHooksConfig(config)).toThrow('hooks.path may not be "/"');
  });

  it('should resolve valid config', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    const resolved = resolveHooksConfig(config);
    expect(resolved).not.toBeNull();
    expect(resolved?.basePath).toBe('/hooks');
    expect(resolved?.token).toBe('test-token');
    expect(resolved?.maxBodyBytes).toBe(256 * 1024);
  });

  it('should normalize path with leading slash', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: 'webhooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    const resolved = resolveHooksConfig(config);
    expect(resolved?.basePath).toBe('/webhooks');
  });

  it('should normalize path by removing trailing slashes', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks/',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    const resolved = resolveHooksConfig(config);
    expect(resolved?.basePath).toBe('/hooks');
  });

  it('should use default max body bytes when not specified', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 0,
      presets: [],
      mappings: [],
    };

    const resolved = resolveHooksConfig(config);
    expect(resolved?.maxBodyBytes).toBe(256 * 1024);
  });

  it('should resolve mappings from presets', () => {
    const config: HooksConfig = {
      enabled: true,
      token: 'test-token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: ['gmail'],
      mappings: [],
    };

    const resolved = resolveHooksConfig(config);
    expect(resolved?.mappings).toHaveLength(1);
    expect(resolved?.mappings[0].id).toBe('gmail');
  });
});

describe('HooksServer', () => {
  let server: HooksServer;
  // Use a random port to avoid conflicts
  const getTestPort = () => 19877 + Math.floor(Math.random() * 1000);
  let TEST_PORT: number;

  beforeEach(() => {
    TEST_PORT = getTestPort();
    server = new HooksServer({
      port: TEST_PORT,
      host: '127.0.0.1',
      enabled: true,
    });
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
      // Wait for port to be released
      await delay(50);
    }
  });

  describe('lifecycle', () => {
    it('should not be running initially', () => {
      expect(server.isRunning()).toBe(false);
    });

    it('should return null address when not running', () => {
      expect(server.getAddress()).toBeNull();
    });

    it('should not start when disabled', async () => {
      const disabledServer = new HooksServer({
        port: TEST_PORT,
        host: '127.0.0.1',
        enabled: false,
      });

      await disabledServer.start();
      expect(disabledServer.isRunning()).toBe(false);
    });
  });

  describe('with running server', () => {
    beforeEach(async () => {
      server.setHooksConfig({
        enabled: true,
        token: 'test-secret-token',
        path: '/hooks',
        maxBodyBytes: 256 * 1024,
        presets: [],
        mappings: [],
      });
      await server.start();
    });

    it('should be running after start', () => {
      expect(server.isRunning()).toBe(true);
    });

    it('should return address when running', () => {
      const addr = server.getAddress();
      expect(addr).not.toBeNull();
      expect(addr?.host).toBe('127.0.0.1');
      expect(addr?.port).toBe(TEST_PORT);
    });

    it('should respond to health check', async () => {
      const response = await makeRequest('GET', '/health');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });

    it('should return 404 for non-hooks paths', async () => {
      const response = await makeRequest('GET', '/other');
      expect(response.statusCode).toBe(404);
    });

    it('should return 401 without token', async () => {
      const response = await makeRequest('POST', '/hooks/wake', {});
      expect(response.statusCode).toBe(401);
    });

    it('should return 401 with wrong token', async () => {
      const response = await makeRequest('POST', '/hooks/wake', {}, {
        'Authorization': 'Bearer wrong-token',
      });
      expect(response.statusCode).toBe(401);
    });

    it('should accept Bearer token in Authorization header', async () => {
      server.setHandlers({
        onWake: async () => {},
      });

      const response = await makeRequest(
        'POST',
        '/hooks/wake',
        { text: 'test', mode: 'now' },
        { 'Authorization': 'Bearer test-secret-token' },
      );
      expect(response.statusCode).toBe(200);
    });

    it('should accept X-CoWork-Token header', async () => {
      server.setHandlers({
        onWake: async () => {},
      });

      const response = await makeRequest(
        'POST',
        '/hooks/wake',
        { text: 'test', mode: 'now' },
        { 'X-CoWork-Token': 'test-secret-token' },
      );
      expect(response.statusCode).toBe(200);
    });

    it('should return 400 for invalid JSON body', async () => {
      const response = await makeRequestRaw(
        'POST',
        '/hooks/wake',
        'not json',
        {
          'Authorization': 'Bearer test-secret-token',
          'Content-Type': 'application/json',
        },
      );
      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for wake without text', async () => {
      const response = await makeRequest(
        'POST',
        '/hooks/wake',
        { mode: 'now' },
        { 'Authorization': 'Bearer test-secret-token' },
      );
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('text required');
    });

    it('should return 400 for agent without message', async () => {
      const response = await makeRequest(
        'POST',
        '/hooks/agent',
        { name: 'Test' },
        { 'Authorization': 'Bearer test-secret-token' },
      );
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('message required');
    });

    it('should call onWake handler', async () => {
      const onWake = vi.fn().mockResolvedValue(undefined);
      server.setHandlers({ onWake });

      const response = await makeRequest(
        'POST',
        '/hooks/wake',
        { text: 'Test wake event', mode: 'next-heartbeat' },
        { 'Authorization': 'Bearer test-secret-token' },
      );

      expect(response.statusCode).toBe(200);
      expect(onWake).toHaveBeenCalledWith({
        text: 'Test wake event',
        mode: 'next-heartbeat',
      });
    });

    it('should call onAgent handler', async () => {
      const onAgent = vi.fn().mockResolvedValue({ taskId: 'task-123' });
      server.setHandlers({ onAgent });

      const response = await makeRequest(
        'POST',
        '/hooks/agent',
        {
          message: 'Run a task',
          name: 'WebhookTask',
          sessionKey: 'hook:test:1',
        },
        { 'Authorization': 'Bearer test-secret-token' },
      );

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.taskId).toBe('task-123');

      expect(onAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Run a task',
          name: 'WebhookTask',
          sessionKey: 'hook:test:1',
          wakeMode: 'now',
          deliver: true,
        }),
      );
    });

    it('should call onTaskMessage handler', async () => {
      const onTaskMessage = vi.fn().mockResolvedValue(undefined);
      server.setHandlers({ onTaskMessage });

      const response = await makeRequest(
        'POST',
        '/hooks/task/message',
        { taskId: 'task-123', message: 'Hello' },
        { 'Authorization': 'Bearer test-secret-token' },
      );

      expect(response.statusCode).toBe(202);
      expect(onTaskMessage).toHaveBeenCalledWith({ taskId: 'task-123', message: 'Hello' });
    });

    it('should return 400 for task message without taskId', async () => {
      const onTaskMessage = vi.fn().mockResolvedValue(undefined);
      server.setHandlers({ onTaskMessage });

      const response = await makeRequest(
        'POST',
        '/hooks/task/message',
        { message: 'Hello' },
        { 'Authorization': 'Bearer test-secret-token' },
      );

      expect(response.statusCode).toBe(400);
    });

    it('should return 503 when no task message handler configured', async () => {
      const response = await makeRequest(
        'POST',
        '/hooks/task/message',
        { taskId: 'task-123', message: 'Hello' },
        { 'Authorization': 'Bearer test-secret-token' },
      );
      expect(response.statusCode).toBe(503);
    });

    it('should call onApprovalRespond handler', async () => {
      const onApprovalRespond = vi.fn().mockResolvedValue('handled');
      server.setHandlers({ onApprovalRespond });

      const response = await makeRequest(
        'POST',
        '/hooks/approval/respond',
        { approvalId: 'approval-1', approved: true },
        { 'Authorization': 'Bearer test-secret-token' },
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.status).toBe('handled');
      expect(onApprovalRespond).toHaveBeenCalledWith({ approvalId: 'approval-1', approved: true });
    });

    it('should return 404 when approval respond returns not_found', async () => {
      const onApprovalRespond = vi.fn().mockResolvedValue('not_found');
      server.setHandlers({ onApprovalRespond });

      const response = await makeRequest(
        'POST',
        '/hooks/approval/respond',
        { approvalId: 'approval-404', approved: true },
        { 'Authorization': 'Bearer test-secret-token' },
      );
      expect(response.statusCode).toBe(404);
    });

    it('should return 503 when no wake handler configured', async () => {
      const response = await makeRequest(
        'POST',
        '/hooks/wake',
        { text: 'test' },
        { 'Authorization': 'Bearer test-secret-token' },
      );
      expect(response.statusCode).toBe(503);
    });

    it('should return 503 when no agent handler configured', async () => {
      const response = await makeRequest(
        'POST',
        '/hooks/agent',
        { message: 'test' },
        { 'Authorization': 'Bearer test-secret-token' },
      );
      expect(response.statusCode).toBe(503);
    });

    it('should return 404 for unmapped custom paths', async () => {
      const response = await makeRequest(
        'POST',
        '/hooks/custom',
        { data: 'test' },
        { 'Authorization': 'Bearer test-secret-token' },
      );
      expect(response.statusCode).toBe(404);
    });

    it('should accept a signed resend webhook when secret is configured', async () => {
      const secretMaterial = Buffer.from('test-resend-secret').toString('base64');
      const webhookSecret = `whsec_${secretMaterial}`;

      server.setHooksConfig({
        enabled: true,
        token: 'test-secret-token',
        path: '/hooks',
        maxBodyBytes: 256 * 1024,
        presets: ['resend'],
        mappings: [],
        resend: {
          webhookSecret,
        },
      });

      const onAgent = vi.fn().mockResolvedValue({ taskId: 'task-resend-1' });
      server.setHandlers({ onAgent });

      const payload = JSON.stringify({
        type: 'email.received',
        data: {
          email_id: 'email_123',
          from: 'sender@example.com',
          to: 'inbox@example.com',
          subject: 'Hello',
          text: 'Body',
        },
      });

      const svixId = 'msg_123';
      const svixTimestamp = String(Math.floor(Date.now() / 1000));
      const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
      const signature = crypto
        .createHmac('sha256', Buffer.from(secretMaterial, 'base64'))
        .update(signedContent)
        .digest('base64');

      const response = await makeRequestRaw(
        'POST',
        '/hooks/resend',
        payload,
        {
          'Authorization': 'Bearer test-secret-token',
          'Content-Type': 'application/json',
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': `v1,${signature}`,
        },
      );

      expect(response.statusCode).toBe(202);
      expect(onAgent).toHaveBeenCalledTimes(1);
    });

    it('should reject resend webhook with invalid signature when secret is configured', async () => {
      const secretMaterial = Buffer.from('test-resend-secret').toString('base64');
      const webhookSecret = `whsec_${secretMaterial}`;

      server.setHooksConfig({
        enabled: true,
        token: 'test-secret-token',
        path: '/hooks',
        maxBodyBytes: 256 * 1024,
        presets: ['resend'],
        mappings: [],
        resend: {
          webhookSecret,
        },
      });

      server.setHandlers({
        onAgent: vi.fn().mockResolvedValue({ taskId: 'task-resend-2' }),
      });

      const payload = JSON.stringify({
        type: 'email.received',
        data: { email_id: 'email_456', subject: 'Invalid sig test' },
      });

      const response = await makeRequestRaw(
        'POST',
        '/hooks/resend',
        payload,
        {
          'Authorization': 'Bearer test-secret-token',
          'Content-Type': 'application/json',
          'svix-id': 'msg_invalid',
          'svix-timestamp': String(Math.floor(Date.now() / 1000)),
          'svix-signature': 'v1,invalid-signature',
        },
      );

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('signature');
    });

    it('should require resend signature for trailing-slash path when secret is configured', async () => {
      const secretMaterial = Buffer.from('test-resend-secret').toString('base64');
      const webhookSecret = `whsec_${secretMaterial}`;

      server.setHooksConfig({
        enabled: true,
        token: 'test-secret-token',
        path: '/hooks',
        maxBodyBytes: 256 * 1024,
        presets: ['resend'],
        mappings: [],
        resend: {
          webhookSecret,
        },
      });

      const onAgent = vi.fn().mockResolvedValue({ taskId: 'task-resend-3' });
      server.setHandlers({ onAgent });

      const payload = JSON.stringify({
        type: 'email.received',
        data: { email_id: 'email_789', subject: 'Trailing slash test' },
      });

      const response = await makeRequestRaw(
        'POST',
        '/hooks/resend/',
        payload,
        {
          'Authorization': 'Bearer test-secret-token',
          'Content-Type': 'application/json',
        },
      );

      expect(response.statusCode).toBe(401);
      expect(onAgent).not.toHaveBeenCalled();
    });

    it('should skip non-inbound resend events without creating tasks', async () => {
      const secretMaterial = Buffer.from('test-resend-secret').toString('base64');
      const webhookSecret = `whsec_${secretMaterial}`;

      server.setHooksConfig({
        enabled: true,
        token: 'test-secret-token',
        path: '/hooks',
        maxBodyBytes: 256 * 1024,
        presets: ['resend'],
        mappings: [],
        resend: {
          webhookSecret,
        },
      });

      const onAgent = vi.fn().mockResolvedValue({ taskId: 'task-resend-4' });
      server.setHandlers({ onAgent });

      const payload = JSON.stringify({
        type: 'email.delivered',
        data: { email_id: 'email_900', subject: 'Delivery event' },
      });

      const svixId = 'msg_delivered_1';
      const svixTimestamp = String(Math.floor(Date.now() / 1000));
      const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
      const signature = crypto
        .createHmac('sha256', Buffer.from(secretMaterial, 'base64'))
        .update(signedContent)
        .digest('base64');

      const response = await makeRequestRaw(
        'POST',
        '/hooks/resend',
        payload,
        {
          'Authorization': 'Bearer test-secret-token',
          'Content-Type': 'application/json',
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': `v1,${signature}`,
        },
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.skipped).toBe(true);
      expect(onAgent).not.toHaveBeenCalled();
    });

    it('should reject replayed resend webhook signatures by svix-id', async () => {
      const secretMaterial = Buffer.from('test-resend-secret').toString('base64');
      const webhookSecret = `whsec_${secretMaterial}`;

      server.setHooksConfig({
        enabled: true,
        token: 'test-secret-token',
        path: '/hooks',
        maxBodyBytes: 256 * 1024,
        presets: ['resend'],
        mappings: [],
        resend: {
          webhookSecret,
        },
      });

      const onAgent = vi.fn().mockResolvedValue({ taskId: 'task-resend-5' });
      server.setHandlers({ onAgent });

      const payload = JSON.stringify({
        type: 'email.received',
        data: {
          email_id: 'email_901',
          from: 'sender@example.com',
          to: 'inbox@example.com',
          subject: 'Replay test',
        },
      });

      const svixId = 'msg_replay_1';
      const svixTimestamp = String(Math.floor(Date.now() / 1000));
      const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
      const signature = crypto
        .createHmac('sha256', Buffer.from(secretMaterial, 'base64'))
        .update(signedContent)
        .digest('base64');

      const headers = {
        'Authorization': 'Bearer test-secret-token',
        'Content-Type': 'application/json',
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${signature}`,
      };

      const first = await makeRequestRaw('POST', '/hooks/resend', payload, headers);
      expect(first.statusCode).toBe(202);

      const second = await makeRequestRaw('POST', '/hooks/resend', payload, headers);
      expect(second.statusCode).toBe(401);
      expect(onAgent).toHaveBeenCalledTimes(1);
    });

    it('should handle OPTIONS preflight', async () => {
      const response = await makeRequest('OPTIONS', '/hooks/wake');
      expect(response.statusCode).toBe(204);
    });

    it('should stop gracefully', async () => {
      await server.stop();
      expect(server.isRunning()).toBe(false);
    });
  });

  // Helper functions for making HTTP requests
  function makeRequest(
    method: string,
    path: string,
    body?: object,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: string }> {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    return makeRequestRaw(method, path, bodyStr, {
      ...headers,
      'Content-Type': 'application/json',
    });
  }

  function makeRequestRaw(
    method: string,
    path: string,
    body?: string,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path,
          method,
          headers,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            resolve({ statusCode: res.statusCode || 500, body });
          });
        },
      );

      req.on('error', reject);

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
});
