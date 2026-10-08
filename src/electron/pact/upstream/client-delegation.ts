// Adapted from openpactprotocol/openpactprotocol@838c6bd1da9be39da04264e8b156dbb4e848a208
// packages/client/src/delegation.ts and packages/client/src/index.ts (Apache-2.0, see ./LICENSE
// and ./NOTICE).
// Modifications: the network calls, the `jose` dependency and the module-level JWKS cache are
// removed. What remains is the protocol logic the upstream client applies to card, OAuth and
// message:send payloads, exposed as pure functions so CoWork's policy-aware transport, signer and
// JWKS cache can drive it. Signature verification is injected (see receipt-verifier.ts).
import { A2AErrorResponseSchema, type AgentCard, type Message } from "./protocol";
import {
  DelegatedSendMessageResponseSchema,
  DeviceAuthorizationResponseSchema,
  OAuth2DeviceCodeSecuritySchemeSchema,
  OAuthErrorResponseSchema,
  PACT_METADATA,
  ReceiptClaimsSchema,
  ReceiptSchema,
  StepUpMetadataSchema,
  TokenResponseSchema,
  parseScope,
  type Receipt,
  type ReceiptClaims,
  type Task,
} from "./delegation";

export interface DelegationScheme {
  identitySchemeName: string;
  delegationSchemeName: string;
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  refreshUrl: string;
  metadataUrl: string;
  scopes: { id: string; description: string }[];
}

export function delegationScheme(card: AgentCard): DelegationScheme | undefined {
  const schemes = card.securitySchemes ?? {};
  for (const requirement of card.securityRequirements ?? []) {
    const names = Object.keys(requirement.schemes);
    if (names.length !== 2) continue;
    let identitySchemeName: string | undefined;
    let delegation: { name: string; scheme: ReturnType<typeof parseDelegationScheme> } | undefined;
    for (const name of names) {
      const scheme = schemes[name];
      if (!scheme) continue;
      if (
        "httpAuthSecurityScheme" in scheme &&
        scheme.httpAuthSecurityScheme.scheme.toLowerCase() === "bearer"
      ) {
        identitySchemeName = name;
        continue;
      }
      const parsed = parseDelegationScheme(scheme);
      if (parsed) delegation = { name, scheme: parsed };
    }
    if (!identitySchemeName || !delegation?.scheme) continue;
    const { flows, oauth2MetadataUrl } = delegation.scheme;
    return {
      identitySchemeName,
      delegationSchemeName: delegation.name,
      deviceAuthorizationUrl: flows.deviceCode.deviceAuthorizationUrl,
      tokenUrl: flows.deviceCode.tokenUrl,
      refreshUrl: flows.deviceCode.refreshUrl ?? flows.deviceCode.tokenUrl,
      metadataUrl: oauth2MetadataUrl,
      scopes: Object.entries(flows.deviceCode.scopes).map(([id, description]) => ({
        id,
        description,
      })),
    };
  }
  return undefined;
}

function parseDelegationScheme(scheme: unknown) {
  const parsed = OAuth2DeviceCodeSecuritySchemeSchema.safeParse(scheme);
  return parsed.success ? parsed.data.oauth2SecurityScheme : undefined;
}

export class OAuthError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly error: string,
    readonly description: string | undefined,
  ) {
    super(description ? `${error}: ${description}` : error);
    this.name = "OAuthError";
  }
}

export class A2AError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly status: string,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "A2AError";
  }
}

export class A2AHttpError extends Error {
  constructor(
    readonly status: number,
    readonly wwwAuthenticate: string | null,
  ) {
    super(`A2A HTTP request failed with status ${status}`);
    this.name = "A2AHttpError";
  }
}

export class DelegationTokenRejectedError extends A2AHttpError {
  constructor(status: number, wwwAuthenticate: string | null) {
    super(status, wwwAuthenticate);
    this.name = "DelegationTokenRejectedError";
  }
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalSeconds: number;
}

export interface DelegationToken {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt: number;
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "granted"; token: DelegationToken };

export type DelegatedSendResult =
  | { kind: "message"; message: Message; receipt?: Receipt }
  | {
      kind: "authRequired";
      task: Task;
      missingScopes: string[];
      verificationUriComplete?: string;
    };

export function readBody(text: string): unknown {
  if (!text) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Upstream `DeviceCodeClient.postForm` error handling, applied to a received response. */
export function throwForOAuthResponse(
  status: number,
  body: unknown,
  wwwAuthenticate: string | null,
): never {
  const oauthError = OAuthErrorResponseSchema.safeParse(body);
  if (status !== 401 && oauthError.success) {
    throw new OAuthError(status, oauthError.data.error, oauthError.data.error_description);
  }
  throw new A2AHttpError(status, wwwAuthenticate);
}

/** Upstream `DeviceCodeClient.start` scope check, run before any network call. */
export function assertRequestableScopes(
  requested: readonly string[],
  advertised: readonly { id: string }[],
): void {
  const known = new Set(advertised.map((scope) => scope.id));
  const unknown = requested.filter((scope) => !known.has(scope));
  if (requested.length === 0) throw new Error("Request at least one scope");
  if (unknown.length > 0) throw new Error(`Scopes not on the Agent Card: ${unknown.join(", ")}`);
}

export function toDeviceAuthorization(body: unknown, now: number): DeviceAuthorization {
  const response = DeviceAuthorizationResponseSchema.parse(body);
  return {
    deviceCode: response.device_code,
    userCode: response.user_code,
    verificationUri: response.verification_uri,
    verificationUriComplete: response.verification_uri_complete,
    expiresAt: now + response.expires_in * 1000,
    intervalSeconds: response.interval ?? 5,
  };
}

export function toDelegationToken(body: unknown, now: number): DelegationToken {
  const response = TokenResponseSchema.parse(body);
  return {
    accessToken: response.access_token,
    ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
    scopes: parseScope(response.scope),
    expiresAt: now + response.expires_in * 1000,
  };
}

/** Upstream `DeviceCodeClient.poll` mapping of pending and slow_down. */
export function interpretPollError(error: unknown): DevicePollResult | undefined {
  if (error instanceof OAuthError && error.error === "authorization_pending") {
    return { status: "pending" };
  }
  if (error instanceof OAuthError && error.error === "slow_down") return { status: "slow_down" };
  return undefined;
}

/** Upstream `DelegatedA2AClient.send` response handling, applied to a received response. */
export function interpretSendResponse(input: {
  status: number;
  body: unknown;
  wwwAuthenticate: string | null;
  sentDelegationToken: boolean;
}): DelegatedSendResult {
  if (input.status < 200 || input.status >= 300) {
    const parsedError = A2AErrorResponseSchema.safeParse(input.body);
    if (parsedError.success) {
      const error = parsedError.data.error;
      throw new A2AError(input.status, error.status, error.details[0]?.reason ?? "", error.message);
    }
    if (
      input.status === 401 &&
      input.sentDelegationToken &&
      /error="invalid_token"/.test(input.wwwAuthenticate ?? "")
    ) {
      throw new DelegationTokenRejectedError(input.status, input.wwwAuthenticate);
    }
    throw new A2AHttpError(input.status, input.wwwAuthenticate);
  }

  const parsed = DelegatedSendMessageResponseSchema.parse(input.body);
  if ("task" in parsed) {
    if (parsed.task.status.state !== "TASK_STATE_AUTH_REQUIRED") {
      throw new Error(`Unexpected task state ${parsed.task.status.state}`);
    }
    const metadata = StepUpMetadataSchema.parse(parsed.task.metadata ?? {});
    const link = metadata[PACT_METADATA.verificationUriComplete];
    return {
      kind: "authRequired",
      task: parsed.task,
      missingScopes: metadata[PACT_METADATA.missingScopes],
      ...(link === undefined ? {} : { verificationUriComplete: link }),
    };
  }
  const rawReceipt = parsed.message.metadata?.[PACT_METADATA.receipt];
  return {
    kind: "message",
    message: parsed.message,
    ...(rawReceipt === undefined ? {} : { receipt: ReceiptSchema.parse(rawReceipt) }),
  };
}

export class ReceiptVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptVerificationError";
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Upstream `verifyReceipt` after the signature step: the verified payload must be valid claims,
 * equal to the envelope claims, and match the expected bindings.
 */
export function checkVerifiedReceiptPayload(
  receipt: Receipt,
  payload: unknown,
  expected?: Partial<Pick<ReceiptClaims, "grantId" | "user" | "pa" | "brand">>,
): ReceiptClaims {
  const claims = ReceiptClaimsSchema.safeParse(payload);
  if (!claims.success) throw new ReceiptVerificationError("Receipt payload has invalid claims");
  if (canonicalJson(claims.data) !== canonicalJson(receipt.claims)) {
    throw new ReceiptVerificationError("Receipt claims do not match the signed payload");
  }
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (value !== undefined && claims.data[key as keyof ReceiptClaims] !== value) {
      throw new ReceiptVerificationError(`Receipt ${key} does not match`);
    }
  }
  return claims.data;
}

/** Upstream `interfaceUrl`: select by binding and version, never by position. */
export function interfaceUrl(card: AgentCard): string {
  const agentInterface = card.supportedInterfaces.find(
    (candidate) => candidate.protocolBinding === "HTTP+JSON" && candidate.protocolVersion === "1.0",
  );
  if (!agentInterface) throw new Error("Agent Card has no HTTP+JSON 1.0 interface");
  return agentInterface.url;
}
