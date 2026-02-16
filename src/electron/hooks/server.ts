/**
 * Hooks Webhook Server
 *
 * HTTP server for webhook endpoints (wake/agent/custom mappings).
 */

import http from 'http';
import { URL } from 'url';
import crypto from 'crypto';
import {
  HooksConfig,
  HooksConfigResolved,
  HookMappingResolved,
  HookMappingContext,
  HookAction,
  WakeHookPayload,
  AgentHookPayload,
  TaskMessageHookPayload,
  ApprovalRespondHookPayload,
  HookServerEvent,
  DEFAULT_HOOKS_PATH,
  DEFAULT_HOOKS_MAX_BODY_BYTES,
  DEFAULT_HOOKS_PORT,
} from './types';
import { resolveHookMappings, applyHookMappings, normalizeHooksPath } from './mappings';

const RESEND_SIGNATURE_ALLOWED_DRIFT_SECONDS = 300;
const RESEND_REPLAY_CACHE_MAX_ENTRIES = 10_000;

export interface HooksServerConfig {
  port: number;
  host?: string;
  enabled: boolean;
}

export interface HooksServerHandlers {
  /**
   * Handle a wake action (enqueue a system event)
   */
  onWake?: (action: { text: string; mode: 'now' | 'next-heartbeat' }) => Promise<void>;

  /**
   * Handle an agent action (run isolated agent turn)
   */
  onAgent?: (action: {
    message: string;
    name?: string;
    wakeMode: 'now' | 'next-heartbeat';
    sessionKey?: string;
    deliver?: boolean;
    channel?: string;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    workspaceId?: string;
  }) => Promise<{ taskId?: string }>;

  /**
   * Handle a follow-up message to an existing task
   */
  onTaskMessage?: (action: { taskId: string; message: string }) => Promise<void>;

  /**
   * Respond to an approval request for a task
   */
  onApprovalRespond?: (action: {
    approvalId: string;
    approved: boolean;
  }) => Promise<'handled' | 'duplicate' | 'not_found' | 'in_progress'>;

  /**
   * Event callback for logging/monitoring
   */
  onEvent?: (event: HookServerEvent) => void;
}

/**
 * Resolve hooks configuration
 */
export function resolveHooksConfig(config: HooksConfig): HooksConfigResolved | null {
  if (config.enabled !== true) return null;

  const token = config.token?.trim();
  if (!token) {
    throw new Error('hooks.enabled requires hooks.token');
  }

  const rawPath = config.path?.trim() || DEFAULT_HOOKS_PATH;
  const withSlash = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;

  if (trimmed === '/') {
    throw new Error('hooks.path may not be "/"');
  }

  const maxBodyBytes =
    config.maxBodyBytes && config.maxBodyBytes > 0
      ? config.maxBodyBytes
      : DEFAULT_HOOKS_MAX_BODY_BYTES;

  const mappings = resolveHookMappings(config);

  return {
    basePath: trimmed,
    token,
    maxBodyBytes,
    mappings,
    resend: config.resend
      ? {
          ...config.resend,
          webhookSecret: config.resend.webhookSecret?.trim() || undefined,
        }
      : undefined,
  };
}

export class HooksServer {
  private server: http.Server | null = null;
  private config: HooksServerConfig;
  private hooksConfig: HooksConfigResolved | null = null;
  private handlers: HooksServerHandlers = {};
  private resendSeenSvixIds: Map<string, number> = new Map();

  constructor(config: HooksServerConfig) {
    this.config = config;
  }

  /**
   * Set the hooks configuration (call before start)
   */
  setHooksConfig(config: HooksConfig): void {
    this.hooksConfig = resolveHooksConfig(config);
    this.resendSeenSvixIds.clear();
  }

  /**
   * Set handlers for hook actions
   */
  setHandlers(handlers: HooksServerHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Start the webhook server
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[HooksServer] Server disabled');
      return;
    }

    if (this.server) {
      console.log('[HooksServer] Server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error('[HooksServer] Request error:', err);
          this.sendJsonResponse(res, 500, { success: false, error: 'Internal server error' });
        });
      });

      this.server.on('error', (err) => {
        console.error('[HooksServer] Server error:', err);
        this.emitEvent({ action: 'error', timestamp: Date.now(), error: String(err) });
        reject(err);
      });

      const host = this.config.host || '127.0.0.1';
      this.server.listen(this.config.port, host, () => {
        console.log(`[HooksServer] Server listening on http://${host}:${this.config.port}`);
        this.emitEvent({ action: 'started', timestamp: Date.now() });
        resolve();
      });
    });
  }

  /**
   * Stop the webhook server
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        console.log('[HooksServer] Server stopped');
        this.emitEvent({ action: 'stopped', timestamp: Date.now() });
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Check if the server is running
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Get the server address
   */
  getAddress(): { host: string; port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (typeof addr === 'string' || !addr) return null;
    return { host: addr.address, port: addr.port };
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CoWork-Token');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Health check endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      this.sendJsonResponse(res, 200, { status: 'ok', timestamp: Date.now() });
      return;
    }

    // Check if hooks are configured
    if (!this.hooksConfig) {
      this.sendJsonResponse(res, 503, { success: false, error: 'Hooks not configured' });
      return;
    }

    const basePath = this.hooksConfig.basePath;

    // Check if request is for hooks path
    if (!url.pathname.startsWith(basePath)) {
      this.sendJsonResponse(res, 404, { success: false, error: 'Not found' });
      return;
    }

    // Extract the hook path after base
    const hookPath = url.pathname.slice(basePath.length).replace(/^\/+/, '').replace(/\/+$/, '');

    // Emit request event
    this.emitEvent({
      action: 'request',
      timestamp: Date.now(),
      path: hookPath,
      method: req.method,
    });

    // Verify authentication
    const tokenResult = this.extractHookToken(req, url);
    if (!this.verifyToken(tokenResult.token)) {
      this.sendJsonResponse(res, 401, { success: false, error: 'Invalid or missing token' });
      return;
    }

    if (tokenResult.fromQuery) {
      console.warn('[HooksServer] Token provided via query param (deprecated)');
    }

    // Handle specific endpoints
    if (hookPath === 'wake' && req.method === 'POST') {
      await this.handleWake(req, res);
      return;
    }

    if (hookPath === 'agent' && req.method === 'POST') {
      await this.handleAgent(req, res);
      return;
    }

    if (hookPath === 'task/message' && req.method === 'POST') {
      await this.handleTaskMessage(req, res);
      return;
    }

    if (hookPath === 'approval/respond' && req.method === 'POST') {
      await this.handleApprovalRespond(req, res);
      return;
    }

    // Handle mapped endpoints
    if (req.method === 'POST') {
      await this.handleMapped(req, res, url, hookPath);
      return;
    }

    this.sendJsonResponse(res, 404, { success: false, error: 'Not found' });
  }

  /**
   * Handle /hooks/wake endpoint
   */
  private async handleWake(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.parseJsonBody<WakeHookPayload>(req);
    if (!body) {
      this.sendJsonResponse(res, 400, { success: false, error: 'Invalid JSON body' });
      return;
    }

    const text = body.text?.trim();
    if (!text) {
      this.sendJsonResponse(res, 400, { success: false, error: 'text required' });
      return;
    }

    const mode = body.mode === 'next-heartbeat' ? 'next-heartbeat' : 'now';

    if (this.handlers.onWake) {
      try {
        await this.handlers.onWake({ text, mode });
        this.sendJsonResponse(res, 200, { success: true });
      } catch (error) {
        console.error('[HooksServer] Wake handler error:', error);
        this.sendJsonResponse(res, 500, { success: false, error: String(error) });
      }
    } else {
      this.sendJsonResponse(res, 503, { success: false, error: 'Wake handler not configured' });
    }
  }

  /**
   * Handle /hooks/agent endpoint
   */
  private async handleAgent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.parseJsonBody<AgentHookPayload>(req);
    if (!body) {
      this.sendJsonResponse(res, 400, { success: false, error: 'Invalid JSON body' });
      return;
    }

    const message = body.message?.trim();
    if (!message) {
      this.sendJsonResponse(res, 400, { success: false, error: 'message required' });
      return;
    }

    const agentPayload = {
      message,
      name: body.name?.trim(),
      wakeMode: (body.wakeMode === 'next-heartbeat' ? 'next-heartbeat' : 'now') as 'now' | 'next-heartbeat',
      sessionKey: body.sessionKey?.trim(),
      deliver: body.deliver ?? true,
      channel: body.channel,
      to: body.to?.trim(),
      model: body.model?.trim(),
      thinking: body.thinking?.trim(),
      timeoutSeconds: body.timeoutSeconds,
      workspaceId: body.workspaceId?.trim(),
    };

    if (this.handlers.onAgent) {
      try {
        const result = await this.handlers.onAgent(agentPayload);
        // Return 202 Accepted for async operation
        this.sendJsonResponse(res, 202, { success: true, taskId: result.taskId });
      } catch (error) {
        console.error('[HooksServer] Agent handler error:', error);
        this.sendJsonResponse(res, 500, { success: false, error: String(error) });
      }
    } else {
      this.sendJsonResponse(res, 503, { success: false, error: 'Agent handler not configured' });
    }
  }

  /**
   * Handle /hooks/task/message endpoint
   */
  private async handleTaskMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.parseJsonBody<TaskMessageHookPayload>(req);
    if (!body) {
      this.sendJsonResponse(res, 400, { success: false, error: 'Invalid JSON body' });
      return;
    }

    const taskId = body.taskId?.trim();
    if (!taskId) {
      this.sendJsonResponse(res, 400, { success: false, error: 'taskId required' });
      return;
    }

    const message = body.message?.trim();
    if (!message) {
      this.sendJsonResponse(res, 400, { success: false, error: 'message required' });
      return;
    }

    if (!this.handlers.onTaskMessage) {
      this.sendJsonResponse(res, 503, { success: false, error: 'Task message handler not configured' });
      return;
    }

    try {
      await this.handlers.onTaskMessage({ taskId, message });
      // Return 202 Accepted for async operation
      this.sendJsonResponse(res, 202, { success: true });
    } catch (error: any) {
      const statusCode =
        typeof error?.statusCode === 'number' && Number.isFinite(error.statusCode) ? error.statusCode : 500;
      console.error('[HooksServer] Task message handler error:', error);
      this.sendJsonResponse(res, statusCode, { success: false, error: String(error) });
    }
  }

  /**
   * Handle /hooks/approval/respond endpoint
   */
  private async handleApprovalRespond(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.parseJsonBody<ApprovalRespondHookPayload>(req);
    if (!body) {
      this.sendJsonResponse(res, 400, { success: false, error: 'Invalid JSON body' });
      return;
    }

    const approvalId = body.approvalId?.trim();
    if (!approvalId) {
      this.sendJsonResponse(res, 400, { success: false, error: 'approvalId required' });
      return;
    }

    if (typeof body.approved !== 'boolean') {
      this.sendJsonResponse(res, 400, { success: false, error: 'approved must be boolean' });
      return;
    }

    if (!this.handlers.onApprovalRespond) {
      this.sendJsonResponse(res, 503, { success: false, error: 'Approval respond handler not configured' });
      return;
    }

    try {
      const status = await this.handlers.onApprovalRespond({ approvalId, approved: body.approved });
      const httpStatus = status === 'not_found' ? 404 : 200;
      this.sendJsonResponse(res, httpStatus, { success: true, status });
    } catch (error) {
      console.error('[HooksServer] Approval respond handler error:', error);
      this.sendJsonResponse(res, 500, { success: false, error: String(error) });
    }
  }

  /**
   * Handle mapped endpoints (e.g., /hooks/gmail)
   */
  private async handleMapped(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    hookPath: string,
  ): Promise<void> {
    if (!this.hooksConfig) {
      this.sendJsonResponse(res, 503, { success: false, error: 'Hooks not configured' });
      return;
    }

    const headers = this.normalizeHeaders(req);
    const rawBody = await this.parseTextBody(req);
    if (rawBody === null) {
      this.sendJsonResponse(res, 400, { success: false, error: 'Invalid JSON body' });
      return;
    }

    if (hookPath === 'resend' && !this.verifyResendSignature(headers, rawBody)) {
      this.sendJsonResponse(res, 401, { success: false, error: 'Invalid Resend webhook signature' });
      return;
    }

    const body = this.parseJsonFromText<Record<string, unknown>>(rawBody);
    if (!body) {
      this.sendJsonResponse(res, 400, { success: false, error: 'Invalid JSON body' });
      return;
    }

    const ctx: HookMappingContext = {
      payload: body,
      headers,
      url,
      path: hookPath,
    };

    const result = await applyHookMappings(this.hooksConfig.mappings, ctx);

    if (!result) {
      if (hookPath === 'resend') {
        const eventType = typeof body.type === 'string' ? body.type : undefined;
        if (eventType && eventType !== 'email.received') {
          this.sendJsonResponse(res, 200, {
            success: true,
            skipped: true,
            reason: `resend event '${eventType}' is not mapped`,
          });
          return;
        }
      }
      this.sendJsonResponse(res, 404, { success: false, error: 'No matching hook mapping' });
      return;
    }

    if (!result.ok) {
      this.sendJsonResponse(res, 400, { success: false, error: result.error });
      return;
    }

    if ('skipped' in result && result.skipped) {
      this.sendJsonResponse(res, 200, { success: true, skipped: true });
      return;
    }

    const action = result.action;
    if (!action) {
      this.sendJsonResponse(res, 200, { success: true, skipped: true });
      return;
    }

    // Execute the action
    if (action.kind === 'wake') {
      if (this.handlers.onWake) {
        try {
          await this.handlers.onWake({ text: action.text, mode: action.mode });
          this.sendJsonResponse(res, 200, { success: true });
        } catch (error) {
          console.error('[HooksServer] Wake handler error:', error);
          this.sendJsonResponse(res, 500, { success: false, error: String(error) });
        }
      } else {
        this.sendJsonResponse(res, 503, { success: false, error: 'Wake handler not configured' });
      }
    } else if (action.kind === 'agent') {
      if (this.handlers.onAgent) {
        try {
          const result = await this.handlers.onAgent({
            message: action.message,
            name: action.name,
            wakeMode: action.wakeMode,
            sessionKey: action.sessionKey,
            deliver: action.deliver,
            channel: action.channel,
            to: action.to,
            model: action.model,
            thinking: action.thinking,
            timeoutSeconds: action.timeoutSeconds,
          });
          this.sendJsonResponse(res, 202, { success: true, taskId: result.taskId });
        } catch (error) {
          console.error('[HooksServer] Agent handler error:', error);
          this.sendJsonResponse(res, 500, { success: false, error: String(error) });
        }
      } else {
        this.sendJsonResponse(res, 503, { success: false, error: 'Agent handler not configured' });
      }
    }
  }

  /**
   * Extract hook token from request
   */
  private extractHookToken(
    req: http.IncomingMessage,
    url: URL,
  ): { token: string | undefined; fromQuery: boolean } {
    // Check Authorization header
    const auth =
      typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      if (token) return { token, fromQuery: false };
    }

    // Check X-CoWork-Token header
    const headerToken =
      typeof req.headers['x-cowork-token'] === 'string'
        ? req.headers['x-cowork-token'].trim()
        : '';
    if (headerToken) return { token: headerToken, fromQuery: false };

    // Check query param (deprecated)
    const queryToken = url.searchParams.get('token');
    if (queryToken) return { token: queryToken.trim(), fromQuery: true };

    return { token: undefined, fromQuery: false };
  }

  /**
   * Verify the provided token
   */
  private verifyToken(provided: string | undefined): boolean {
    if (!this.hooksConfig?.token) return false;
    if (!provided) return false;

    // Use timing-safe comparison
    const expected = Buffer.from(this.hooksConfig.token);
    const actual = Buffer.from(provided);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  /**
   * Normalize request headers
   */
  private normalizeHeaders(req: http.IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        headers[key.toLowerCase()] = value.join(', ');
      }
    }
    return headers;
  }

  /**
   * Parse raw request body with timeout to prevent slow client DoS
   */
  private parseTextBody(req: http.IncomingMessage): Promise<string | null> {
    const maxBytes = this.hooksConfig?.maxBodyBytes || DEFAULT_HOOKS_MAX_BODY_BYTES;
    const REQUEST_TIMEOUT_MS = 30000; // 30 second timeout for request body

    return new Promise((resolve) => {
      let done = false;
      let total = 0;
      const chunks: Buffer[] = [];

      // Timeout to prevent slow client resource exhaustion
      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        console.warn('[HooksServer] Request body timeout - slow client detected');
        resolve(null);
        req.destroy();
      }, REQUEST_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
      };

      req.on('data', (chunk: Buffer) => {
        if (done) return;
        total += chunk.length;
        if (total > maxBytes) {
          done = true;
          cleanup();
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (done) return;
        done = true;
        cleanup();
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', () => {
        if (done) return;
        done = true;
        cleanup();
        resolve(null);
      });
    });
  }

  /**
   * Parse JSON body from request with timeout to prevent slow client DoS
   */
  private async parseJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
    const raw = await this.parseTextBody(req);
    if (raw === null) return null;
    return this.parseJsonFromText<T>(raw);
  }

  private parseJsonFromText<T>(raw: string): T | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {} as T;
    }
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return null;
    }
  }

  /**
   * Verify Resend webhook signature headers (Svix format) when a webhook secret is configured.
   * If no secret is configured, this check is skipped.
   */
  private verifyResendSignature(headers: Record<string, string>, rawBody: string): boolean {
    const secret = this.hooksConfig?.resend?.webhookSecret?.trim();
    if (!secret) return true;

    const svixId = headers['svix-id'];
    const svixTimestamp = headers['svix-timestamp'];
    const svixSignature = headers['svix-signature'];
    if (!svixId || !svixTimestamp || !svixSignature) return false;

    const tsSeconds = Number(svixTimestamp);
    if (!Number.isFinite(tsSeconds)) return false;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const allowedDriftSeconds = RESEND_SIGNATURE_ALLOWED_DRIFT_SECONDS;
    if (Math.abs(nowSeconds - tsSeconds) > allowedDriftSeconds) return false;

    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
    const secretMaterial = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
    const normalizedSecret = secretMaterial.replace(/-/g, '+').replace(/_/g, '/');

    let key: Buffer;
    if (/^[A-Za-z0-9+/=]+$/.test(normalizedSecret)) {
      const decoded = Buffer.from(normalizedSecret, 'base64');
      const reencoded = decoded.toString('base64').replace(/=+$/g, '');
      const original = normalizedSecret.replace(/=+$/g, '');
      key = decoded.length > 0 && reencoded === original
        ? decoded
        : Buffer.from(secretMaterial, 'utf8');
    } else {
      key = Buffer.from(secretMaterial, 'utf8');
    }

    const expected = crypto.createHmac('sha256', key).update(signedContent).digest('base64');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    const candidates = Array.from(svixSignature.matchAll(/v1,([^,\s]+)/g)).map(
      (match) => match[1],
    );

    for (const candidate of candidates) {
      const candidateBuffer = Buffer.from(candidate, 'utf8');
      if (
        candidateBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
      ) {
        if (this.isReplayResendMessage(svixId, nowSeconds)) {
          return false;
        }
        return true;
      }
    }

    return false;
  }

  private isReplayResendMessage(svixId: string, nowSeconds: number): boolean {
    this.pruneResendReplayCache(nowSeconds);
    if (this.resendSeenSvixIds.has(svixId)) {
      return true;
    }
    this.resendSeenSvixIds.set(svixId, nowSeconds);
    return false;
  }

  private pruneResendReplayCache(nowSeconds: number): void {
    const cutoff = nowSeconds - RESEND_SIGNATURE_ALLOWED_DRIFT_SECONDS;

    // Entries are inserted in arrival order, so stale entries appear first.
    while (this.resendSeenSvixIds.size > 0) {
      const first = this.resendSeenSvixIds.entries().next().value as [string, number] | undefined;
      if (!first || first[1] >= cutoff) break;
      this.resendSeenSvixIds.delete(first[0]);
    }

    if (this.resendSeenSvixIds.size <= RESEND_REPLAY_CACHE_MAX_ENTRIES) return;

    const overflow = this.resendSeenSvixIds.size - RESEND_REPLAY_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of this.resendSeenSvixIds.keys()) {
      this.resendSeenSvixIds.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  /**
   * Send JSON response
   */
  private sendJsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Emit a server event
   */
  private emitEvent(event: HookServerEvent): void {
    if (this.handlers.onEvent) {
      try {
        this.handlers.onEvent(event);
      } catch (error) {
        console.error('[HooksServer] Event handler error:', error);
      }
    }
  }
}
