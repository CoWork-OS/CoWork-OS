/**
 * Personal-agent identity: the client side of the PACT signer contract (docs/pact-signer.md).
 *
 * The desktop never holds the issuer's private key. It asks a signer for a short-lived JWT for its
 * own subject and a provider-assigned audience, checks the token's claims locally, and caches one
 * token per audience for well under the 300 s PACT maximum. Three deployments share this contract:
 * managed (CoWork-operated), self-hosted (customer-operated) and development (in-process, tests).
 */
import { randomUUID } from "node:crypto";
import { decodeCompactJws, signCompactJws, type Es256KeyPair, type PactJwsAlgorithm } from "./jws";
import { PactTransportError, type PactTransport } from "./transport";

export const PACT_JWT_MAX_LIFETIME_SECONDS = 300;
export const PACT_JWT_MAX_FUTURE_IAT_SECONDS = 30;
/** Reuse a cached token only while it is younger than this and has this much life left. */
const TOKEN_CACHE_MAX_AGE_MS = 240_000;
const TOKEN_MIN_REMAINING_MS = 45_000;
const DEVICE_ASSERTION_TTL_SECONDS = 60;

export type PactSignerErrorCode =
  | "not_configured"
  | "unavailable"
  | "disabled"
  | "rejected"
  | "invalid_token"
  | "audience_not_registered";

export class PactSignerError extends Error {
  constructor(
    readonly code: PactSignerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PactSignerError";
  }
}

export interface PactSignedToken {
  token: string;
  issuer: string;
  subject: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
}

/** What every deployment provides. */
export interface PactSigner {
  readonly deployment: "managed" | "self_hosted" | "development";
  readonly issuer: string;
  sign(audience: string): Promise<PactSignedToken>;
  status(): Promise<PactSignerStatus>;
}

export interface PactSignerStatus {
  ok: boolean;
  issuer: string;
  subject?: string;
  jwksUri: string;
  disabled: boolean;
  /** Provider origin → assigned audience, when the signer knows its registrations. */
  audiences: Record<string, string>;
  reason?: string;
}

/**
 * Local claim checks on a token the signer returned. A signer that answers with another issuer,
 * audience or subject, an unsupported algorithm, or a lifetime the provider would reject is
 * treated as broken rather than passed through.
 */
export function checkSignedToken(input: {
  token: string;
  issuer: string;
  audience: string;
  expectedSubject?: string;
  nonce?: string;
  nowMs: number;
}): PactSignedToken {
  let decoded: ReturnType<typeof decodeCompactJws>;
  try {
    decoded = decodeCompactJws(input.token);
  } catch {
    throw new PactSignerError("invalid_token", "Signer returned a malformed token");
  }
  if (decoded.header.alg !== "ES256" && decoded.header.alg !== "RS256") {
    throw new PactSignerError("invalid_token", "Signer used an algorithm PACT does not allow");
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(decoded.payload.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new PactSignerError("invalid_token", "Signer token payload is not JSON");
  }
  const { iss, sub, aud, iat, exp } = claims;
  if (iss !== input.issuer) throw new PactSignerError("invalid_token", "Signer token issuer differs");
  if (aud !== input.audience) {
    throw new PactSignerError("invalid_token", "Signer token audience differs");
  }
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 256) {
    throw new PactSignerError("invalid_token", "Signer token has no usable subject");
  }
  if (input.expectedSubject !== undefined && sub !== input.expectedSubject) {
    throw new PactSignerError("invalid_token", "Signer token subject changed");
  }
  if (input.nonce !== undefined && claims.jti !== undefined && typeof claims.jti !== "string") {
    throw new PactSignerError("invalid_token", "Signer token jti is not a string");
  }
  if (typeof iat !== "number" || typeof exp !== "number" || !Number.isInteger(iat) || !Number.isInteger(exp)) {
    throw new PactSignerError("invalid_token", "Signer token has no integer iat/exp");
  }
  const nowSeconds = Math.floor(input.nowMs / 1000);
  if (exp <= iat || exp - iat > PACT_JWT_MAX_LIFETIME_SECONDS) {
    throw new PactSignerError("invalid_token", "Signer token lifetime exceeds 300 seconds");
  }
  if (iat > nowSeconds + PACT_JWT_MAX_FUTURE_IAT_SECONDS) {
    throw new PactSignerError("invalid_token", "Signer token is issued in the future");
  }
  if (exp <= nowSeconds) throw new PactSignerError("invalid_token", "Signer token is already expired");
  return {
    token: input.token,
    issuer: iss,
    subject: sub,
    audience: aud,
    issuedAt: iat * 1000,
    expiresAt: exp * 1000,
  };
}

/** Per-audience cache in front of any signer; concurrent callers share one signing request. */
export class PactTokenCache {
  private readonly tokens = new Map<string, { token: PactSignedToken; fetchedAt: number }>();
  private readonly inflight = new Map<string, Promise<PactSignedToken>>();

  constructor(
    private readonly signer: PactSigner,
    private readonly now: () => number = Date.now,
  ) {}

  get deployment(): PactSigner["deployment"] {
    return this.signer.deployment;
  }

  get issuer(): string {
    return this.signer.issuer;
  }

  async token(audience: string): Promise<PactSignedToken> {
    const cached = this.tokens.get(audience);
    const at = this.now();
    if (
      cached &&
      at - cached.fetchedAt < TOKEN_CACHE_MAX_AGE_MS &&
      cached.token.expiresAt - at > TOKEN_MIN_REMAINING_MS
    ) {
      return cached.token;
    }
    const pending = this.inflight.get(audience);
    if (pending) return pending;
    const request = this.signer
      .sign(audience)
      .then((token) => {
        this.tokens.set(audience, { token, fetchedAt: this.now() });
        return token;
      })
      .finally(() => this.inflight.delete(audience));
    this.inflight.set(audience, request);
    return request;
  }

  /** Drop cached tokens, e.g. after a 401 or a signer configuration change. */
  invalidate(audience?: string): void {
    if (audience === undefined) this.tokens.clear();
    else this.tokens.delete(audience);
  }

  status(): Promise<PactSignerStatus> {
    return this.signer.status();
  }
}

export type PactSignerAuth =
  | { mode: "credential"; credential: string }
  | { mode: "device_key"; keyPair: Es256KeyPair; subject?: string };

function readJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PactSignerError("unavailable", "Signer returned a non-JSON response");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PactSignerError("unavailable", "Signer returned an unexpected response");
  }
  return value as Record<string, unknown>;
}

/**
 * The HTTP contract client used for managed and self-hosted deployments. The signer URL comes
 * from settings; the transport applies network policy and DNS pinning like every PACT hop.
 */
export class HttpPactSigner implements PactSigner {
  constructor(
    private readonly options: {
      deployment: "managed" | "self_hosted";
      issuer: string;
      signerUrl: string;
      auth: PactSignerAuth;
      transport: () => PactTransport;
      expectedSubject?: string;
      now?: () => number;
    },
  ) {}

  get deployment(): "managed" | "self_hosted" {
    return this.options.deployment;
  }

  get issuer(): string {
    return this.options.issuer;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private authorization(path: string): string {
    const auth = this.options.auth;
    if (auth.mode === "credential") return `Bearer ${auth.credential}`;
    // Proof of possession of the install's enrolled device key; the signer maps it to a subject.
    const iat = Math.floor(this.now() / 1000);
    const assertion = signCompactJws(
      JSON.stringify({
        iss: auth.keyPair.publicJwk.kid,
        aud: this.endpoint(path),
        iat,
        exp: iat + DEVICE_ASSERTION_TTL_SECONDS,
        jti: randomUUID(),
      }),
      { alg: "ES256" as PactJwsAlgorithm, kid: auth.keyPair.publicJwk.kid, typ: "pact-device+jwt" },
      auth.keyPair.privateKey,
    );
    return `PACT-Device ${assertion}`;
  }

  private endpoint(path: string): string {
    return `${this.options.signerUrl.replace(/\/+$/, "")}${path}`;
  }

  private async post(path: string, body: Record<string, unknown>) {
    let response;
    try {
      response = await this.options.transport().request({
        purpose: "signer",
        method: "POST",
        url: this.endpoint(path),
        headers: { Authorization: this.authorization(path), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof PactTransportError && error.code === "policy_denied") {
        throw new PactSignerError("unavailable", "Network policy blocks the PACT signer");
      }
      throw new PactSignerError("unavailable", "The PACT signer could not be reached");
    }
    if (response.status === 403) throw new PactSignerError("disabled", "The PACT signer is disabled");
    if (response.status === 401) {
      throw new PactSignerError("rejected", "The PACT signer rejected this device");
    }
    if (response.status === 404 || response.status === 422) {
      const parsed = readJsonObject(response.bodyText || "{}");
      if (parsed.error === "audience_not_registered") {
        throw new PactSignerError("audience_not_registered", "The signer has no registration for this provider");
      }
    }
    if (response.status !== 200) {
      throw new PactSignerError("unavailable", `The PACT signer returned ${response.status}`);
    }
    return readJsonObject(response.bodyText);
  }

  async sign(audience: string): Promise<PactSignedToken> {
    const nonce = randomUUID();
    const body = await this.post("/pact/sign", { audience, nonce });
    if (body.nonce !== nonce) {
      throw new PactSignerError("invalid_token", "Signer response does not echo the request nonce");
    }
    if (typeof body.token !== "string") {
      throw new PactSignerError("invalid_token", "Signer response has no token");
    }
    return checkSignedToken({
      token: body.token,
      issuer: this.options.issuer,
      audience,
      ...(this.options.expectedSubject === undefined
        ? {}
        : { expectedSubject: this.options.expectedSubject }),
      nonce,
      nowMs: this.now(),
    });
  }

  async status(): Promise<PactSignerStatus> {
    const jwksUri = `${this.options.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
    try {
      const body = await this.post("/pact/status", {});
      const audiences: Record<string, string> = {};
      if (body.audiences && typeof body.audiences === "object" && !Array.isArray(body.audiences)) {
        for (const [origin, audience] of Object.entries(body.audiences as Record<string, unknown>)) {
          if (typeof audience === "string" && audience) audiences[origin] = audience;
        }
      }
      const issuerMatches = body.issuer === this.options.issuer;
      return {
        ok: issuerMatches && body.disabled !== true,
        issuer: this.options.issuer,
        ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
        jwksUri,
        disabled: body.disabled === true,
        audiences,
        ...(issuerMatches ? {} : { reason: "The signer reports a different issuer" }),
      };
    } catch (error) {
      return {
        ok: false,
        issuer: this.options.issuer,
        jwksUri,
        disabled: error instanceof PactSignerError && error.code === "disabled",
        audiences: {},
        reason: error instanceof Error ? error.message : "Signer status is unavailable",
      };
    }
  }
}
