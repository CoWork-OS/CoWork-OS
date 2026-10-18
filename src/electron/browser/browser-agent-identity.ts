/**
 * Declared agent identity for in-app browser navigations CoWork makes. Signatures are added
 * per request by the partition's `onBeforeSendHeaders` hook while an agent navigation is in
 * progress, so each redirect hop gets its own signature and nothing is stored on the
 * navigation entry (a reload or back/forward by the user is never signed).
 */
import { getCoworkVersion } from "../gateway/router-helpers";
import { getAgentSigningKey } from "../identity/agent-signing-keys";
import {
  agentRequestIdentity,
  type AgentRequestIdentity,
} from "../security/agent-request-identity";
import { BrowserSettingsManager } from "../settings/browser-settings-manager";

export type AgentNavigationSignature = NonNullable<AgentRequestIdentity["signature"]>;

/** Signature headers for one navigation hop, or undefined when identity is off or unsigned. */
export function agentNavigationIdentity(url: string): AgentRequestIdentity | undefined {
  try {
    const settings = BrowserSettingsManager.loadSettings().declaredAgent;
    if (!settings.enabled || !settings.signatureAgent) return undefined;
    const identity = agentRequestIdentity(new URL(url), {
      settings,
      version: getCoworkVersion(),
      getKey: getAgentSigningKey,
      // The browser keeps its Chrome-compatible user agent: sign-in pages refuse unknown ones.
      includeUserAgent: false,
    });
    return identity?.signature ? identity : undefined;
  } catch {
    // Signing is additive: without it the navigation proceeds as before.
    return undefined;
  }
}
