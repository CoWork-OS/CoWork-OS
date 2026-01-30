/**
 * Webhook Server for Cron Job Triggers
 * Provides HTTP endpoints to trigger scheduled tasks externally
 */

import http from 'http';
import { URL } from 'url';
import crypto from 'crypto';
import type { CronRunResult } from './types';

export interface WebhookServerConfig {
  port: number;
  host?: string;
  secret?: string; // Optional secret for request authentication
  enabled: boolean;
}

export interface WebhookTriggerPayload {
  jobId?: string;
  jobName?: string;
  secret?: string;
  force?: boolean; // Run even if not due
}

export interface WebhookTriggerResult {
  success: boolean;
  jobId?: string;
  taskId?: string;
  error?: string;
}

type TriggerHandler = (jobId: string, force: boolean) => Promise<CronRunResult>;

export class CronWebhookServer {
  private server: http.Server | null = null;
  private config: WebhookServerConfig;
  private triggerHandler: TriggerHandler | null = null;
  private jobLookup: (() => Promise<Array<{ id: string; name: string }>>) | null = null;

  constructor(config: WebhookServerConfig) {
    this.config = config;
  }

  /**
   * Set the handler for triggering jobs
   */
  setTriggerHandler(handler: TriggerHandler): void {
    this.triggerHandler = handler;
  }

  /**
   * Set the job lookup function for finding jobs by name
   */
  setJobLookup(lookup: () => Promise<Array<{ id: string; name: string }>>): void {
    this.jobLookup = lookup;
  }

  /**
   * Start the webhook server
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[CronWebhook] Webhook server disabled');
      return;
    }

    if (this.server) {
      console.log('[CronWebhook] Server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error('[CronWebhook] Request error:', err);
          this.sendJsonResponse(res, 500, { success: false, error: 'Internal server error' });
        });
      });

      this.server.on('error', (err) => {
        console.error('[CronWebhook] Server error:', err);
        reject(err);
      });

      const host = this.config.host || '127.0.0.1';
      this.server.listen(this.config.port, host, () => {
        console.log(`[CronWebhook] Server listening on http://${host}:${this.config.port}`);
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
        console.log('[CronWebhook] Server stopped');
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
    // Set CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');

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

    // Trigger endpoint
    if (url.pathname === '/trigger' && req.method === 'POST') {
      await this.handleTrigger(req, res);
      return;
    }

    // List jobs endpoint (for debugging)
    if (url.pathname === '/jobs' && req.method === 'GET') {
      await this.handleListJobs(req, res);
      return;
    }

    // Not found
    this.sendJsonResponse(res, 404, { success: false, error: 'Not found' });
  }

  /**
   * Handle trigger request
   */
  private async handleTrigger(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Parse body
    const body = await this.parseJsonBody<WebhookTriggerPayload>(req);
    if (!body) {
      this.sendJsonResponse(res, 400, { success: false, error: 'Invalid JSON body' });
      return;
    }

    // Verify secret if configured
    if (this.config.secret) {
      const providedSecret = body.secret || req.headers['x-webhook-secret'];
      if (!this.verifySecret(providedSecret as string | undefined)) {
        this.sendJsonResponse(res, 401, { success: false, error: 'Invalid or missing secret' });
        return;
      }
    }

    // Get job ID
    let jobId = body.jobId;

    // If jobName provided, look up the job ID
    if (!jobId && body.jobName && this.jobLookup) {
      const jobs = await this.jobLookup();
      const job = jobs.find((j) => j.name.toLowerCase() === body.jobName!.toLowerCase());
      if (job) {
        jobId = job.id;
      }
    }

    if (!jobId) {
      this.sendJsonResponse(res, 400, { success: false, error: 'Job ID or name required' });
      return;
    }

    if (!this.triggerHandler) {
      this.sendJsonResponse(res, 503, { success: false, error: 'Trigger handler not configured' });
      return;
    }

    // Trigger the job
    const result = await this.triggerHandler(jobId, body.force ?? false);

    if (result.ok && result.ran) {
      this.sendJsonResponse(res, 200, {
        success: true,
        jobId,
        taskId: result.taskId,
      });
    } else if (result.ok && !result.ran) {
      this.sendJsonResponse(res, 200, {
        success: false,
        jobId,
        error: `Job not run: ${result.reason}`,
      });
    } else {
      this.sendJsonResponse(res, 500, {
        success: false,
        jobId,
        error: result.error,
      });
    }
  }

  /**
   * Handle list jobs request
   */
  private async handleListJobs(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Verify secret if configured
    if (this.config.secret) {
      const providedSecret = req.headers['x-webhook-secret'];
      if (!this.verifySecret(providedSecret as string | undefined)) {
        this.sendJsonResponse(res, 401, { success: false, error: 'Invalid or missing secret' });
        return;
      }
    }

    if (!this.jobLookup) {
      this.sendJsonResponse(res, 503, { success: false, error: 'Job lookup not configured' });
      return;
    }

    const jobs = await this.jobLookup();
    this.sendJsonResponse(res, 200, { success: true, jobs });
  }

  /**
   * Verify the provided secret against configured secret
   */
  private verifySecret(provided: string | undefined): boolean {
    if (!this.config.secret) return true;
    if (!provided) return false;

    // Use timing-safe comparison
    const expected = Buffer.from(this.config.secret);
    const actual = Buffer.from(provided);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  /**
   * Parse JSON body from request
   */
  private parseJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        // Limit body size to 1MB
        if (body.length > 1024 * 1024) {
          resolve(null);
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  /**
   * Send JSON response
   */
  private sendJsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

// Generate a secure random secret
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
