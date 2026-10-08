/**
 * Compact JWS and JWT handling for PACT on Node's crypto module (ES256 and RS256 only).
 *
 * PACT needs four operations: verify provider-signed receipts, verify the development signer's
 * own tokens in tests, sign development personal-agent JWTs, and parse JWKS documents. Doing this
 * on node:crypto avoids a new dependency; the cost is owning JWK parsing, which is kept strict.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

/** The JWK shape node:crypto accepts for `format: "jwk"`. */
type NodeJwk = Extract<Parameters<typeof createPublicKey>[0], { format: "jwk" }>["key"];

export type PactJwsAlgorithm = "ES256" | "RS256";
export const PACT_JWS_ALGORITHMS: readonly PactJwsAlgorithm[] = ["ES256", "RS256"];

export interface PublicJwk {
  kty: "EC" | "RSA";
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export interface JwsHeader {
  alg: string;
  kid?: string;
  typ?: string;
  [key: string]: unknown;
}

export class JwsError extends Error {
  constructor(
    readonly code:
      | "malformed"
      | "unsupported_algorithm"
      | "unknown_key"
      | "bad_signature"
      | "invalid_key",
    message: string,
  ) {
    super(message);
    this.name = "JwsError";
  }
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;
const MIN_RSA_MODULUS_BITS = 2048;

export function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function base64UrlDecode(input: string): Buffer {
  if (!BASE64URL.test(input)) throw new JwsError("malformed", "Invalid base64url segment");
  return Buffer.from(input, "base64url");
}

export interface DecodedJws {
  header: JwsHeader;
  payload: Buffer;
  signingInput: string;
  signature: Buffer;
}

export function decodeCompactJws(jws: string): DecodedJws {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new JwsError("malformed", "Compact JWS must have three non-empty segments");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: unknown;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8"));
  } catch {
    throw new JwsError("malformed", "JWS header is not JSON");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new JwsError("malformed", "JWS header must be an object");
  }
  const typed = header as JwsHeader;
  if (typeof typed.alg !== "string") throw new JwsError("malformed", "JWS header has no alg");
  // Critical header parameters would change verification semantics; none are understood.
  if ("crit" in typed) throw new JwsError("malformed", "JWS crit headers are not supported");
  if (typed.kid !== undefined && typeof typed.kid !== "string") {
    throw new JwsError("malformed", "JWS kid must be a string");
  }
  return {
    header: typed,
    payload: base64UrlDecode(encodedPayload),
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: base64UrlDecode(encodedSignature),
  };
}

function isAllowedAlgorithm(alg: string): alg is PactJwsAlgorithm {
  return (PACT_JWS_ALGORITHMS as readonly string[]).includes(alg);
}

/**
 * Turn a public JWK into a key object. Private members are refused so a misconfigured JWKS
 * cannot leak signing material into this process, and weak RSA keys are refused.
 */
export function publicKeyFromJwk(jwk: unknown): { key: KeyObject; jwk: PublicJwk } {
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) {
    throw new JwsError("invalid_key", "JWK must be an object");
  }
  const record = jwk as Record<string, unknown>;
  for (const field of PRIVATE_JWK_FIELDS) {
    if (field in record) throw new JwsError("invalid_key", "JWKS must not contain private keys");
  }
  if (record.use !== undefined && record.use !== "sig") {
    throw new JwsError("invalid_key", "JWK is not a signing key");
  }
  let normalized: PublicJwk;
  if (record.kty === "EC") {
    if (record.crv !== "P-256" || typeof record.x !== "string" || typeof record.y !== "string") {
      throw new JwsError("invalid_key", "EC JWK must be P-256 with x and y");
    }
    normalized = { kty: "EC", crv: "P-256", x: record.x, y: record.y };
  } else if (record.kty === "RSA") {
    if (typeof record.n !== "string" || typeof record.e !== "string") {
      throw new JwsError("invalid_key", "RSA JWK must have n and e");
    }
    if (base64UrlDecode(record.n).length * 8 < MIN_RSA_MODULUS_BITS) {
      throw new JwsError("invalid_key", "RSA JWK modulus is too short");
    }
    normalized = { kty: "RSA", n: record.n, e: record.e };
  } else {
    throw new JwsError("invalid_key", "JWK kty must be EC or RSA");
  }
  if (typeof record.kid === "string") normalized.kid = record.kid;
  if (typeof record.alg === "string") normalized.alg = record.alg;
  if (typeof record.use === "string") normalized.use = record.use;
  try {
    const key = createPublicKey({ key: { ...normalized } as NodeJwk, format: "jwk" });
    return { key, jwk: normalized };
  } catch (error) {
    throw new JwsError(
      "invalid_key",
      `JWK could not be imported: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function keyMatchesAlgorithm(jwk: PublicJwk, alg: PactJwsAlgorithm): boolean {
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  return alg === "ES256" ? jwk.kty === "EC" : jwk.kty === "RSA";
}

export type JwsKeyResolver = (
  header: JwsHeader,
) => Promise<{ key: KeyObject; jwk: PublicJwk } | undefined>;

export async function verifyCompactJws(
  jws: string,
  resolveKey: JwsKeyResolver,
  options: { algorithms?: readonly PactJwsAlgorithm[]; typ?: string } = {},
): Promise<{ header: JwsHeader; payload: Buffer }> {
  const decoded = decodeCompactJws(jws);
  const allowed = options.algorithms ?? PACT_JWS_ALGORITHMS;
  if (!isAllowedAlgorithm(decoded.header.alg) || !allowed.includes(decoded.header.alg)) {
    throw new JwsError("unsupported_algorithm", `JWS alg ${decoded.header.alg} is not allowed`);
  }
  if (options.typ !== undefined && decoded.header.typ !== options.typ) {
    throw new JwsError("malformed", "JWS typ does not match");
  }
  const resolved = await resolveKey(decoded.header);
  if (!resolved) throw new JwsError("unknown_key", "No key matches the JWS header");
  if (!keyMatchesAlgorithm(resolved.jwk, decoded.header.alg)) {
    throw new JwsError("unknown_key", "Key type does not match the JWS algorithm");
  }
  const data = Buffer.from(decoded.signingInput, "ascii");
  const ok =
    decoded.header.alg === "ES256"
      ? cryptoVerify(
          "sha256",
          data,
          { key: resolved.key, dsaEncoding: "ieee-p1363" },
          decoded.signature,
        )
      : cryptoVerify("sha256", data, resolved.key, decoded.signature);
  if (!ok) throw new JwsError("bad_signature", "JWS signature is invalid");
  return { header: decoded.header, payload: decoded.payload };
}

/** Pick the JWKS entries a header may refer to. Without a kid, only an unambiguous key is used. */
export function selectJwksCandidates(
  keys: readonly { key: KeyObject; jwk: PublicJwk }[],
  header: JwsHeader,
): { key: KeyObject; jwk: PublicJwk }[] {
  if (!isAllowedAlgorithm(header.alg)) return [];
  const alg = header.alg;
  const usable = keys.filter((entry) => keyMatchesAlgorithm(entry.jwk, alg));
  if (header.kid !== undefined) return usable.filter((entry) => entry.jwk.kid === header.kid);
  return usable.length === 1 ? usable : [];
}

export function signCompactJws(
  payload: Buffer | string,
  header: { alg: PactJwsAlgorithm; kid: string; typ?: string },
  privateKey: KeyObject,
): string {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(payload);
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
  const signature =
    header.alg === "ES256"
      ? cryptoSign("sha256", signingInput, { key: privateKey, dsaEncoding: "ieee-p1363" })
      : cryptoSign("sha256", signingInput, privateKey);
  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(signature)}`;
}

/** RFC 7638 thumbprint, used as the development signer's kid. */
export function jwkThumbprint(jwk: PublicJwk): string {
  const members =
    jwk.kty === "EC"
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
      : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return createHash("sha256").update(JSON.stringify(members)).digest("base64url");
}

/** Import a stored ES256 private JWK (the install's device key). */
export function privateKeyFromJwk(jwk: Record<string, string>): KeyObject {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) {
    throw new JwsError("invalid_key", "Device key must be a P-256 private JWK");
  }
  return createPrivateKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } as NodeJwk,
    format: "jwk",
  });
}

export interface Es256KeyPair {
  privateKey: KeyObject;
  publicJwk: PublicJwk & { kid: string; alg: "ES256"; use: "sig" };
}

export function generateEs256KeyPair(): Es256KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exported = publicKey.export({ format: "jwk" }) as { crv: string; x: string; y: string };
  const base: PublicJwk = { kty: "EC", crv: exported.crv, x: exported.x, y: exported.y };
  return {
    privateKey,
    publicJwk: { ...base, kid: jwkThumbprint(base), alg: "ES256", use: "sig" },
  };
}

export function decodeJwtPayloadUnverified(token: string): Record<string, unknown> {
  const decoded = decodeCompactJws(token);
  const payload = JSON.parse(decoded.payload.toString("utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JwsError("malformed", "JWT payload must be an object");
  }
  return payload as Record<string, unknown>;
}
