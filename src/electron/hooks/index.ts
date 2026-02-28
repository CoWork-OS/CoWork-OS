/**
 * Hooks Module
 *
 * Webhook ingress for wake and isolated agent runs.
 * Includes Gmail Pub/Sub integration.
 */

// Types
export * from "./types";

// Settings Manager
export { HooksSettingsManager, generateHookToken } from "./settings";

// Hook Mappings
export { resolveHookMappings, applyHookMappings, normalizeHooksPath } from "./mappings";

// Webhook Server
export { HooksServer, resolveHooksConfig } from "./server";
export type { HooksServerConfig, HooksServerHandlers } from "./server";

// Shared ingress/idempotency
export {
  HookAgentIngress,
  initializeHookAgentIngress,
  getHookAgentIngress,
} from "./agent-ingress";
export { HookSessionRepository } from "./HookSessionRepository";

// Gmail Watcher
export {
  startGmailWatcher,
  stopGmailWatcher,
  isGmailWatcherRunning,
  isGogAvailable,
  resolveGmailRuntimeConfig,
  getGmailRuntimeConfig,
} from "./gmail-watcher";
export type { GmailWatcherStartResult } from "./gmail-watcher";
