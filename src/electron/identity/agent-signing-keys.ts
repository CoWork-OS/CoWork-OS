/**
 * The profile's Ed25519 key for declared agent identity (Web Bot Auth). The private key lives
 * only in the encrypted settings store; the public key is meant to be published in a key
 * directory the user hosts or coworkd serves.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import {
  ed25519JwkThumbprint,
  ed25519PublicX,
  type Ed25519PublicJwk,
} from "../security/http-message-signature";

const CATEGORY = "agent-identity" as const;
/** A replaced key stays in the directory this long, so cached directories keep verifying. */
export const PREVIOUS_KEY_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredAgentIdentity {
  privateKeyPem: string;
  createdAt: number;
  /** Public half of the key this one replaced, kept until `retiredAt + overlap`. */
  previous?: { x: string; retiredAt: number };
}

export interface AgentSigningKey {
  privateKey: KeyObject;
  /** base64url public key. */
  x: string;
  /** RFC 7638 thumbprint; the `keyid` of every signature. */
  keyid: string;
  createdAt: number;
  previous?: { x: string; retiredAt: number };
}

export class AgentSigningKeyUnavailableError extends Error {
  constructor(readonly status: string) {
    super(
      `The agent identity key could not be read (${status}); requests are sent unsigned until it can.`,
    );
    this.name = "AgentSigningKeyUnavailableError";
  }
}

let cached: AgentSigningKey | null = null;

function fromStored(stored: StoredAgentIdentity): AgentSigningKey {
  const privateKey = createPrivateKey(stored.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new AgentSigningKeyUnavailableError("not_an_ed25519_key");
  }
  const x = ed25519PublicX(createPublicKey(privateKey));
  return {
    privateKey,
    x,
    keyid: ed25519JwkThumbprint(x),
    createdAt: stored.createdAt,
    ...(stored.previous ? { previous: stored.previous } : {}),
  };
}

function createAndSave(previous?: StoredAgentIdentity["previous"]): AgentSigningKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const stored: StoredAgentIdentity = {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    createdAt: Date.now(),
    ...(previous ? { previous } : {}),
  };
  if (!SecureSettingsRepository.getInstance().save<StoredAgentIdentity>(CATEGORY, stored)) {
    throw new AgentSigningKeyUnavailableError("save_refused");
  }
  return fromStored(stored);
}

/**
 * The signing key, created only when none was ever stored. A stored key that cannot be read
 * (keychain change, corruption) is never silently replaced: that would break every published
 * directory. Undefined when the encrypted store is not open.
 */
export function getAgentSigningKey(): AgentSigningKey | undefined {
  if (cached) return cached;
  if (!SecureSettingsRepository.isInitialized()) return undefined;
  const result =
    SecureSettingsRepository.getInstance().loadWithStatus<StoredAgentIdentity>(CATEGORY);
  if (result.status === "not_found") {
    cached = createAndSave();
  } else if (result.status === "success" && result.data?.privateKeyPem) {
    try {
      cached = fromStored(result.data);
    } catch (error) {
      if (error instanceof AgentSigningKeyUnavailableError) throw error;
      throw new AgentSigningKeyUnavailableError("unreadable");
    }
  } else {
    throw new AgentSigningKeyUnavailableError(result.status);
  }
  return cached;
}

/**
 * Replace the key. The old public key stays in the directory for the overlap period, so sites
 * that cached the old directory keep verifying until they fetch the new one.
 */
export function rotateAgentSigningKey(): AgentSigningKey | undefined {
  if (!SecureSettingsRepository.isInitialized()) return undefined;
  let current: AgentSigningKey | undefined;
  try {
    current = getAgentSigningKey();
  } catch (error) {
    // The user chose to replace a key that can no longer be read: there is no old key to keep.
    if (!(error instanceof AgentSigningKeyUnavailableError)) throw error;
  }
  cached = createAndSave(current ? { x: current.x, retiredAt: Date.now() } : undefined);
  return cached;
}

/** The JWK Set to publish at `/.well-known/http-message-signatures-directory`. */
export function agentPublicJwks(
  key = getAgentSigningKey(),
  now = Date.now(),
): { keys: Ed25519PublicJwk[] } | undefined {
  if (!key) return undefined;
  const keys: Ed25519PublicJwk[] = [
    { kty: "OKP", crv: "Ed25519", kid: key.keyid, x: key.x, use: "sig" },
  ];
  if (key.previous && now - key.previous.retiredAt < PREVIOUS_KEY_OVERLAP_MS) {
    keys.push({
      kty: "OKP",
      crv: "Ed25519",
      kid: ed25519JwkThumbprint(key.previous.x),
      x: key.previous.x,
      use: "sig",
    });
  }
  return { keys };
}

/** Test hook: forget the cached key. */
export function resetAgentSigningKeyCache(): void {
  cached = null;
}
