/**
 * HTTP Message Signatures (RFC 9421) for declared agent identity, following
 * draft-ietf-webbotauth-httpsig-protocol-00 ("Web Bot Auth"):
 *
 * - requests: `Signature-Agent` is a Dictionary whose member (keyed by the signature label) is
 *   the origin serving `/.well-known/http-message-signatures-directory`; the signature covers
 *   `@authority` and that member, with `created`, `expires`, `keyid`, `alg`, `nonce` and
 *   `tag="web-bot-auth"`;
 * - `keyid` is the base64url JWK SHA-256 thumbprint of the Ed25519 key (RFC 8037 A.3);
 * - the key directory response is a JWK Set signed over `@authority;req` and `content-digest`
 *   with `tag="http-message-signatures-directory"`.
 *
 * Pure functions over Node's crypto; no network access here.
 */
import { createHash, randomBytes, sign, verify, type KeyObject } from "node:crypto";

export const WEB_BOT_AUTH_TAG = "web-bot-auth";
export const DIRECTORY_SIGNATURE_TAG = "http-message-signatures-directory";
export const SIGNATURE_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const SIGNATURE_DIRECTORY_MEDIA_TYPE = "application/http-message-signatures-directory+json";
/** The draft recommends at most 24 hours; request signatures here live minutes. */
export const MAX_SIGNATURE_TTL_SECONDS = 24 * 60 * 60;

export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid?: string;
  use?: "sig";
}

/** RFC 7638 thumbprint of an Ed25519 key (RFC 8037 A.3): the draft's `keyid`. */
export function ed25519JwkThumbprint(x: string): string {
  // Required members only, in lexicographic order, with no whitespace.
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
  return createHash("sha256").update(canonical).digest("base64url");
}

/** The public half of a KeyObject as `x`, base64url without padding. */
export function ed25519PublicX(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("Not an Ed25519 public key");
  return jwk.x;
}

function sfString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface SignatureParams {
  created: number;
  expires: number;
  keyid: string;
  alg?: string;
  nonce?: string;
  tag: string;
}

function serializeParams(components: string, params: SignatureParams): string {
  return [
    components,
    `;created=${params.created}`,
    `;keyid=${sfString(params.keyid)}`,
    ...(params.alg ? [`;alg=${sfString(params.alg)}`] : []),
    `;expires=${params.expires}`,
    ...(params.nonce ? [`;nonce=${sfString(params.nonce)}`] : []),
    `;tag=${sfString(params.tag)}`,
  ].join("");
}

/** RFC 9421 §2.2.1: host and non-default port, lowercased. */
export function authorityOf(url: URL): string {
  return url.host.toLowerCase();
}

export function requestSignatureBase(input: {
  authority: string;
  label: string;
  /** Dictionary key of the Signature-Agent member; the draft's examples use the label. */
  agentKey?: string;
  signatureAgent: string;
  params: SignatureParams;
}): { base: string; signatureInput: string } {
  const agentMember = `"signature-agent";key=${sfString(input.agentKey ?? input.label)}`;
  const components = `("@authority" ${agentMember})`;
  const signatureParams = serializeParams(components, input.params);
  const base = [
    `"@authority": ${input.authority}`,
    `${agentMember}: ${sfString(input.signatureAgent)}`,
    `"@signature-params": ${signatureParams}`,
  ].join("\n");
  return { base, signatureInput: `${input.label}=${signatureParams}` };
}

export interface SignAgentRequestInput {
  url: string | URL;
  /** https origin of the key directory. */
  signatureAgent: string;
  privateKey: KeyObject;
  keyid: string;
  nowSeconds?: number;
  ttlSeconds?: number;
  label?: string;
  nonce?: string;
}

export interface SignedAgentRequest {
  headers: { "Signature-Agent": string; "Signature-Input": string; Signature: string };
  authority: string;
  keyid: string;
  created: number;
  expires: number;
}

/** Sign one request for its authority. */
export function signAgentRequest(input: SignAgentRequestInput): SignedAgentRequest {
  const url = typeof input.url === "string" ? new URL(input.url) : input.url;
  const label = input.label ?? "sig";
  const created = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const ttl = Math.min(MAX_SIGNATURE_TTL_SECONDS, Math.max(1, Math.floor(input.ttlSeconds ?? 300)));
  const params: SignatureParams = {
    created,
    expires: created + ttl,
    keyid: input.keyid,
    alg: "ed25519",
    nonce: input.nonce ?? randomBytes(32).toString("base64"),
    tag: WEB_BOT_AUTH_TAG,
  };
  const authority = authorityOf(url);
  const { base, signatureInput } = requestSignatureBase({
    authority,
    label,
    signatureAgent: input.signatureAgent,
    params,
  });
  const signature = sign(null, Buffer.from(base, "utf8"), input.privateKey).toString("base64");
  return {
    headers: {
      "Signature-Agent": `${label}=${sfString(input.signatureAgent)}`,
      "Signature-Input": signatureInput,
      Signature: `${label}=:${signature}:`,
    },
    authority,
    keyid: input.keyid,
    created: params.created,
    expires: params.expires,
  };
}

/**
 * A key directory body (JWK Set) and its response signature, made with the current key over
 * the authority the directory was requested from.
 */
export function signedSignatureDirectory(input: {
  /** The authority the directory request was made to. */
  requestAuthority: string;
  /** Every key to publish, the signing key first. */
  keys: Ed25519PublicJwk[];
  privateKey: KeyObject;
  nowSeconds?: number;
  ttlSeconds?: number;
}): { body: string; headers: Record<string, string> } {
  const [signingKey] = input.keys;
  if (!signingKey) throw new Error("A key directory needs at least one key");
  const keyid = signingKey.kid ?? ed25519JwkThumbprint(signingKey.x);
  const body = JSON.stringify({
    keys: input.keys.map((key) => ({
      kty: "OKP",
      crv: "Ed25519",
      kid: key.kid ?? ed25519JwkThumbprint(key.x),
      x: key.x,
      use: "sig",
    })),
  });
  const digest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
  const created = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const ttl = Math.min(MAX_SIGNATURE_TTL_SECONDS, Math.max(1, input.ttlSeconds ?? 86_400));
  const components = `("@authority";req "content-digest")`;
  // The draft's directory example carries no `alg`; the key type already fixes it.
  const signatureParams = serializeParams(components, {
    created,
    expires: created + ttl,
    keyid,
    tag: DIRECTORY_SIGNATURE_TAG,
  });
  const base = [
    `"@authority";req: ${input.requestAuthority.toLowerCase()}`,
    `"content-digest": ${digest}`,
    `"@signature-params": ${signatureParams}`,
  ].join("\n");
  const signature = sign(null, Buffer.from(base, "utf8"), input.privateKey).toString("base64");
  return {
    body,
    headers: {
      "Content-Type": SIGNATURE_DIRECTORY_MEDIA_TYPE,
      "Cache-Control": "max-age=86400",
      // The signature covers the requested authority, so caches must not share it across hosts.
      Vary: "Host",
      "Content-Digest": digest,
      "Signature-Input": `binding=${signatureParams}`,
      Signature: `binding=:${signature}:`,
    },
  };
}

export type SignatureVerificationFailure =
  | "missing_headers"
  | "malformed"
  | "wrong_tag"
  | "unknown_key"
  | "expired"
  | "not_yet_valid"
  | "agent_mismatch"
  | "bad_signature";

/**
 * Verify a Web Bot Auth request signature against a JWK Set, as an origin would. Used by tests
 * and by the loopback check in Settings; CoWork never needs it to make requests.
 */
export function verifyAgentRequest(input: {
  url: string | URL;
  headers: Record<string, string | undefined>;
  jwks: { keys: Ed25519PublicJwk[] };
  publicKeyFromJwk: (jwk: Ed25519PublicJwk) => KeyObject;
  nowSeconds?: number;
}): { ok: true; keyid: string } | { ok: false; reason: SignatureVerificationFailure } {
  const header = (name: string) =>
    Object.entries(input.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const signatureInput = header("signature-input");
  const signature = header("signature");
  const agent = header("signature-agent");
  if (!signatureInput || !signature || !agent) return { ok: false, reason: "missing_headers" };
  const inputMatch =
    /^([a-z0-9_-]+)=\("@authority" "signature-agent";key="([^"]+)"\)((?:;[a-z]+=(?:"[^"]*"|\d+))+)$/.exec(
      signatureInput.trim(),
    );
  const signatureMatch = /^([a-z0-9_-]+)=:([A-Za-z0-9+/=]+):$/.exec(signature.trim());
  const agentMatch = /^([a-z0-9_-]+)="([^"]+)"$/.exec(agent.trim());
  if (!inputMatch || !signatureMatch || !agentMatch) return { ok: false, reason: "malformed" };
  const [, label, agentKey, paramText] = inputMatch;
  if (signatureMatch[1] !== label || agentMatch[1] !== agentKey) {
    return { ok: false, reason: "agent_mismatch" };
  }
  const params = new Map<string, string>();
  for (const part of paramText.split(";").filter(Boolean)) {
    const [key, raw] = part.split(/=(.*)/s);
    params.set(key, raw.startsWith('"') ? raw.slice(1, -1) : raw);
  }
  if (params.get("tag") !== WEB_BOT_AUTH_TAG) return { ok: false, reason: "wrong_tag" };
  const created = Number(params.get("created"));
  const expires = Number(params.get("expires"));
  const keyid = params.get("keyid") ?? "";
  const now = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  if (!Number.isFinite(created) || !Number.isFinite(expires))
    return { ok: false, reason: "malformed" };
  if (created > now + 60) return { ok: false, reason: "not_yet_valid" };
  if (expires <= now) return { ok: false, reason: "expired" };
  const jwk = input.jwks.keys.find((key) => ed25519JwkThumbprint(key.x) === keyid);
  if (!jwk) return { ok: false, reason: "unknown_key" };
  const url = typeof input.url === "string" ? new URL(input.url) : input.url;
  const base = [
    `"@authority": ${authorityOf(url)}`,
    `"signature-agent";key=${sfString(agentKey)}: ${sfString(agentMatch[2])}`,
    `"@signature-params": ${signatureInput.trim().slice(label.length + 1)}`,
  ].join("\n");
  const valid = verify(
    null,
    Buffer.from(base, "utf8"),
    input.publicKeyFromJwk(jwk),
    Buffer.from(signatureMatch[2], "base64"),
  );
  return valid ? { ok: true, keyid } : { ok: false, reason: "bad_signature" };
}
