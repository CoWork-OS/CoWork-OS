/**
 * Hooks Configuration Types
 *
 * Webhook ingress for wake and isolated agent runs.
 */

import type { ChannelType } from '../../shared/types';

// ============ Hook Configuration ============

export interface HooksConfig {
  enabled: boolean;
  token: string;
  path: string;
  maxBodyBytes: number;
  presets: string[];
  mappings: HookMappingConfig[];
  transformsDir?: string;
  gmail?: GmailHooksConfig;
  resend?: ResendHooksConfig;
}

export interface GmailHooksConfig {
  account?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  model?: string;
  thinking?: string;
  allowUnsafeExternalContent?: boolean;
  serve?: {
    bind?: string;
    port?: number;
    path?: string;
  };
  tailscale?: {
    mode?: 'off' | 'serve' | 'funnel';
    path?: string;
    target?: string;
  };
}

export interface ResendHooksConfig {
  webhookSecret?: string;
  allowUnsafeExternalContent?: boolean;
}

// ============ Hook Mapping Configuration ============

export interface HookMappingConfig {
  id?: string;
  match?: {
    path?: string;
    source?: string;
    type?: string;
  };
  action?: 'wake' | 'agent';
  wakeMode?: 'now' | 'next-heartbeat';
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  allowUnsafeExternalContent?: boolean;
  channel?: HookMessageChannel;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: {
    module: string;
    export?: string;
  };
}

export type HookMessageChannel = ChannelType | 'last';

// ============ Resolved Hook Mapping ============

export interface HookMappingResolved {
  id: string;
  matchPath?: string;
  matchSource?: string;
  matchType?: string;
  action: 'wake' | 'agent';
  wakeMode?: 'now' | 'next-heartbeat';
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  allowUnsafeExternalContent?: boolean;
  channel?: HookMessageChannel;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: HookMappingTransformResolved;
}

export interface HookMappingTransformResolved {
  modulePath: string;
  exportName?: string;
}

// ============ Hook Payloads ============

export interface WakeHookPayload {
  text: string;
  mode?: 'now' | 'next-heartbeat';
}

export interface AgentHookPayload {
  message: string;
  name?: string;
  sessionKey?: string;
  wakeMode?: 'now' | 'next-heartbeat';
  deliver?: boolean;
  channel?: HookMessageChannel;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  workspaceId?: string;
}

export interface TaskMessageHookPayload {
  taskId: string;
  message: string;
}

export interface ApprovalRespondHookPayload {
  approvalId: string;
  approved: boolean;
}

// ============ Hook Actions ============

export type HookAction =
  | {
      kind: 'wake';
      text: string;
      mode: 'now' | 'next-heartbeat';
    }
  | {
      kind: 'agent';
      message: string;
      name?: string;
      wakeMode: 'now' | 'next-heartbeat';
      sessionKey?: string;
      deliver?: boolean;
      allowUnsafeExternalContent?: boolean;
      channel?: HookMessageChannel;
      to?: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
    };

export type HookMappingResult =
  | { ok: true; action: HookAction }
  | { ok: true; action: null; skipped: true }
  | { ok: false; error: string };

// ============ Hook Context ============

export interface HookMappingContext {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  url: URL;
  path: string;
}

// ============ Resolved Hooks Config ============

export interface HooksConfigResolved {
  basePath: string;
  token: string;
  maxBodyBytes: number;
  mappings: HookMappingResolved[];
  resend?: ResendHooksConfig;
}

// ============ Gmail Runtime Config ============

export interface GmailHookRuntimeConfig {
  account: string;
  label: string;
  topic: string;
  subscription: string;
  pushToken: string;
  hookToken: string;
  hookUrl: string;
  includeBody: boolean;
  maxBytes: number;
  renewEveryMinutes: number;
  serve: {
    bind: string;
    port: number;
    path: string;
  };
  tailscale: {
    mode: 'off' | 'serve' | 'funnel';
    path: string;
    target?: string;
  };
}

// ============ Hook Server Events ============

export interface HookServerEvent {
  action: 'started' | 'stopped' | 'request' | 'error';
  timestamp: number;
  path?: string;
  method?: string;
  statusCode?: number;
  error?: string;
}

// ============ Default Values ============

export const DEFAULT_HOOKS_PATH = '/hooks';
export const DEFAULT_HOOKS_MAX_BODY_BYTES = 256 * 1024; // 256KB
export const DEFAULT_HOOKS_PORT = 9877;

export const DEFAULT_GMAIL_LABEL = 'INBOX';
export const DEFAULT_GMAIL_TOPIC = 'cowork-gmail-watch';
export const DEFAULT_GMAIL_SUBSCRIPTION = 'cowork-gmail-watch-push';
export const DEFAULT_GMAIL_SERVE_BIND = '127.0.0.1';
export const DEFAULT_GMAIL_SERVE_PORT = 8788;
export const DEFAULT_GMAIL_SERVE_PATH = '/gmail-pubsub';
export const DEFAULT_GMAIL_MAX_BYTES = 20_000;
export const DEFAULT_GMAIL_RENEW_MINUTES = 12 * 60; // 12 hours

export const DEFAULT_HOOKS_CONFIG: HooksConfig = {
  enabled: false,
  token: '',
  path: DEFAULT_HOOKS_PATH,
  maxBodyBytes: DEFAULT_HOOKS_MAX_BODY_BYTES,
  presets: [],
  mappings: [],
};

// ============ Gmail Preset Mapping ============

export const GMAIL_PRESET_MAPPING: HookMappingConfig = {
  id: 'gmail',
  match: { path: 'gmail' },
  action: 'agent',
  wakeMode: 'now',
  name: 'Gmail',
  sessionKey: 'hook:gmail:{{messages[0].id}}',
  messageTemplate:
    'New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}',
};

export const RESEND_PRESET_MAPPING: HookMappingConfig = {
  id: 'resend',
  match: { path: 'resend', type: 'email.received' },
  action: 'agent',
  wakeMode: 'now',
  name: 'Resend',
  sessionKey: 'hook:resend:{{data.email_id}}',
  messageTemplate:
    'Inbound email event: {{type}}\nFrom: {{data.from}}\nTo: {{data.to}}\nSubject: {{data.subject}}\nEmail ID: {{data.email_id}}\n\nIf email_id is present, call resend.get_received_email to retrieve full body/headers before drafting or replying.',
};

export const HOOK_PRESET_MAPPINGS: Record<string, HookMappingConfig[]> = {
  gmail: [GMAIL_PRESET_MAPPING],
  resend: [RESEND_PRESET_MAPPING],
};
