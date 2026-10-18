/**
 * How CoWork identifies itself on requests it makes for the user, when declared agent identity
 * is on (Settings > Browser). Off by default: then nothing here changes a request.
 */
import { hostMatchesDomains, type DeclaredAgentSettings } from "../../shared/browser-settings";
import type { AgentSigningKey } from "../identity/agent-signing-keys";
import {
  signAgentRequest,
  signedSignatureDirectory,
  type Ed25519PublicJwk,
} from "./http-message-signature";

/**
 * Agent request signatures cover only the authority, so anyone who sees one can replay it
 * against that host until it expires; keep the window short (the draft allows up to 24 hours).
 */
const REQUEST_SIGNATURE_TTL_SECONDS = 60;

/** Request headers CoWork's declared identity owns; a page or caller never supplies them. */
const AGENT_IDENTITY_HEADER_NAMES = new Set(["signature", "signature-input", "signature-agent"]);

export function isAgentIdentityHeader(name: string): boolean {
  return AGENT_IDENTITY_HEADER_NAMES.has(name.toLowerCase());
}

export function honestUserAgent(version: string): string {
  return `CoWork-OS/${version || "dev"} (+https://coworkosapp.com/agent)`;
}

export interface AgentRequestIdentity {
  /** Headers to add to (or replace on) this hop. */
  headers: Record<string, string>;
  userAgentMode: "declared" | "compatible";
  /** What was signed, for the audit trail; absent when no directory origin is set. */
  signature?: { keyid: string; authority: string; expires: number };
}

/**
 * Identity headers for one request hop, or undefined when declared identity is off. The
 * signature is bound to the hop's authority, so it is recomputed for every redirect target.
 */
export function agentRequestIdentity(
  url: URL,
  options: {
    settings: DeclaredAgentSettings;
    version: string;
    getKey: () => AgentSigningKey | undefined;
    /** The in-app browser keeps its own user agent and only adds the signature. */
    includeUserAgent?: boolean;
    nowSeconds?: number;
  },
): AgentRequestIdentity | undefined {
  if (!options.settings.enabled) return undefined;
  const compatible = hostMatchesDomains(url.hostname, options.settings.compatibleUserAgentDomains);
  const headers: Record<string, string> = {};
  if (options.includeUserAgent !== false && !compatible) {
    headers["User-Agent"] = honestUserAgent(options.version);
  }
  let signature: AgentRequestIdentity["signature"];
  const key = options.settings.signatureAgent ? options.getKey() : undefined;
  // Only over https: a signature seen on a cleartext hop would verify for the https origin.
  if (key && url.protocol === "https:") {
    const signed = signAgentRequest({
      url,
      signatureAgent: options.settings.signatureAgent,
      privateKey: key.privateKey,
      keyid: key.keyid,
      ttlSeconds: REQUEST_SIGNATURE_TTL_SECONDS,
      ...(options.nowSeconds !== undefined ? { nowSeconds: options.nowSeconds } : {}),
    });
    Object.assign(headers, signed.headers);
    signature = { keyid: signed.keyid, authority: signed.authority, expires: signed.expires };
  }
  return {
    headers,
    userAgentMode: compatible ? "compatible" : "declared",
    ...(signature ? { signature } : {}),
  };
}

/**
 * The signed key directory a self-hosted coworkd serves, or undefined when it should not: only
 * while declared identity is on, and only to requests for the configured directory origin's
 * host, so the response is never signed over an authority a client chose.
 */
export function agentSignatureDirectory(
  requestAuthority: string,
  options: {
    settings: DeclaredAgentSettings;
    getKey: () => AgentSigningKey | undefined;
    getJwks: (key: AgentSigningKey) => { keys: Ed25519PublicJwk[] } | undefined;
  },
): { body: string; headers: Record<string, string> } | undefined {
  if (!options.settings.enabled || !options.settings.signatureAgent) return undefined;
  const directoryHost = new URL(options.settings.signatureAgent).host.toLowerCase();
  if (requestAuthority.toLowerCase() !== directoryHost) return undefined;
  const key = options.getKey();
  const jwks = key ? options.getJwks(key) : undefined;
  if (!key || !jwks) return undefined;
  return signedSignatureDirectory({
    requestAuthority: directoryHost,
    keys: jwks.keys,
    privateKey: key.privateKey,
  });
}
