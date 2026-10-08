/**
 * An in-process PACT provider for tests, modelled on the reference provider at
 * openpactprotocol@838c6bd (reference/provider/src/a2a/handler.ts, delegation/oauth.ts):
 * card and RFC 8414 metadata, personal-agent JWT checks, RFC 8628 device flow with single-use
 * refresh rotation, contexts bound to (pa, sub) and brand user, messageId deduplication with the
 * "no reply yet" case, step-up tasks that are not stored, and ES256-signed receipts.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  decodeCompactJws,
  generateEs256KeyPair,
  publicKeyFromJwk,
  signCompactJws,
  verifyCompactJws,
  type Es256KeyPair,
} from "../../jws";
import { PactTransportError, type PactHttpResponse, type PolicyCheckedHttp } from "../../transport";

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export type FakeHandler = (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): FakeResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function a2aError(reason: string, message: string): FakeResponse {
  const map: Record<string, [number, string]> = {
    INVALID_PARAMS: [400, "INVALID_ARGUMENT"],
    CONTENT_TYPE_NOT_SUPPORTED: [400, "INVALID_ARGUMENT"],
    UNSUPPORTED_OPERATION: [400, "FAILED_PRECONDITION"],
    TASK_NOT_FOUND: [404, "NOT_FOUND"],
    INTERNAL: [500, "INTERNAL"],
  };
  const [code, status] = map[reason] ?? [500, "INTERNAL"];
  return json(
    {
      error: {
        code,
        status,
        message,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason,
            domain: "a2a-protocol.org",
          },
        ],
      },
    },
    code,
  );
}

function header(request: FakeRequest, name: string): string | undefined {
  const key = Object.keys(request.headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? request.headers[key] : undefined;
}

export interface FakeScope {
  id: string;
  description: string;
}

interface DeviceRow {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scopes: string[];
  status: "pending" | "approved" | "denied" | "consumed";
  grantId?: string;
  brandUserId?: string;
  expiresAt: number;
  lastPolledAt?: number;
  interval: number;
}

interface GrantRow {
  id: string;
  clientId: string;
  brandUserId: string;
  scopes: string[];
  revoked: boolean;
  expiresAt: number;
}

interface StoredMessage {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  text: string;
  metadata?: Record<string, unknown>;
}

interface Conversation {
  id: string;
  paUser: string;
  brandUserId: string | null;
  closed: boolean;
  messages: StoredMessage[];
}

export interface FakeProviderOptions {
  origin: string;
  brandId: string;
  name?: string;
  audience: string;
  delegated?: boolean;
  scopes?: FakeScope[];
  /** issuer → JWKS keys of registered personal agents. */
  registeredIssuers: Record<string, () => { keys: unknown[] }>;
  now?: () => number;
}

export class FakePactProvider {
  readonly key: Es256KeyPair = generateEs256KeyPair();
  readonly conversations = new Map<string, Conversation>();
  readonly devices: DeviceRow[] = [];
  readonly grants = new Map<string, GrantRow>();
  readonly refreshTokens = new Map<string, { grantId: string; used: boolean }>();
  readonly requests: FakeRequest[] = [];
  disabledIssuers = new Set<string>();
  /** messageIds whose turn is "still processing" (stored without a reply) once. */
  processingOnce = new Set<string>();
  /** Drop the next reply after processing (the client sees a timeout). */
  dropNextReply = false;
  /** Omit the receipt on the next delegated reply. */
  omitNextReceipt = false;
  /** Tamper with the next receipt's envelope claims. */
  tamperNextReceipt = false;
  /** Report scopes outside the grant in the next receipt. */
  overreachNextReceipt = false;
  /** Attach the previous turn's receipt to the next reply (replayed evidence). */
  replayNextReceipt = false;
  /** Keep demanding this scope on every turn, even after it is granted (a broken provider). */
  alwaysMissingScope: string | null = null;
  /** Answer the next N token polls with slow_down. */
  slowDownPolls = 0;
  private lastReceipt: unknown = null;
  /** Map the user's scope approval: given requested scopes, which to grant (or "deny"). */
  approvalPolicy: (requested: string[]) => string[] | "deny" = (requested) => requested;
  brandUserId = "brand-user-4471";

  constructor(readonly options: FakeProviderOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get interfaceUrl(): string {
    return `${this.options.origin}/a2a/${this.options.brandId}`;
  }
  get oauthIssuer(): string {
    return `${this.interfaceUrl}/oauth`;
  }
  get cardUrl(): string {
    return `${this.interfaceUrl}/.well-known/agent-card.json`;
  }
  get scopes(): FakeScope[] {
    return (
      this.options.scopes ?? [
        { id: "orders:read", description: "Look up your orders and their status" },
        { id: "orders:cancel", description: "Cancel an order that has not shipped" },
      ]
    );
  }

  card(): Record<string, unknown> {
    const delegated = this.options.delegated !== false;
    return {
      name: this.options.name ?? "Example Co. Support",
      description: "Order support",
      supportedInterfaces: [
        { url: this.interfaceUrl, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
      ],
      provider: { organization: "Fake Provider", url: this.options.origin },
      version: "0.1.0",
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      securitySchemes: {
        platformJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
        ...(delegated
          ? {
              userDelegation: {
                oauth2SecurityScheme: {
                  flows: {
                    deviceCode: {
                      deviceAuthorizationUrl: `${this.oauthIssuer}/device_authorization`,
                      tokenUrl: `${this.oauthIssuer}/token`,
                      scopes: Object.fromEntries(
                        this.scopes.map((scope) => [scope.id, scope.description]),
                      ),
                    },
                  },
                  oauth2MetadataUrl: `${this.oauthIssuer}/.well-known/oauth-authorization-server`,
                },
              },
            }
          : {}),
      },
      securityRequirements: [
        { schemes: { platformJwt: { list: [] } } },
        ...(delegated
          ? [{ schemes: { platformJwt: { list: [] }, userDelegation: { list: [] } } }]
          : []),
      ],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [
        {
          id: "orders",
          name: "Orders",
          description: "Order status and changes.",
          tags: ["orders"],
        },
      ],
    };
  }

  /** Simulate the user signing in and approving (or denying) a pending user code. */
  decide(userCode?: string): void {
    const row = userCode
      ? this.devices.find((device) => device.userCode === userCode)
      : [...this.devices].reverse().find((device) => device.status === "pending");
    if (!row || row.status !== "pending") throw new Error("no pending device authorization");
    const decision = this.approvalPolicy(row.scopes);
    if (decision === "deny" || decision.length === 0) {
      row.status = "denied";
      return;
    }
    const grantId = `a2agrant_${randomUUID()}`;
    this.grants.set(grantId, {
      id: grantId,
      clientId: row.clientId,
      brandUserId: this.brandUserId,
      scopes: decision,
      revoked: false,
      expiresAt: this.now() + 30 * 24 * 3600_000,
    });
    row.status = "approved";
    row.grantId = grantId;
    row.brandUserId = this.brandUserId;
  }

  revokeAllGrants(): void {
    for (const grant of this.grants.values()) grant.revoked = true;
  }

  closeConversation(contextId: string): void {
    const conversation = this.conversations.get(contextId);
    if (conversation) conversation.closed = true;
  }

  private async verifyPaJwt(request: FakeRequest): Promise<{ issuer: string; sub: string } | null> {
    const match = header(request, "authorization")?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) return null;
    const token = match[1];
    let claims: Record<string, unknown>;
    try {
      const decoded = decodeCompactJws(token);
      if (decoded.header.alg !== "ES256" && decoded.header.alg !== "RS256") return null;
      claims = JSON.parse(decoded.payload.toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
    const issuer = typeof claims.iss === "string" ? claims.iss : "";
    const jwks = this.options.registeredIssuers[issuer];
    if (!jwks || this.disabledIssuers.has(issuer)) return null;
    try {
      await verifyCompactJws(token, async (jwsHeader) => {
        const keys = jwks().keys.map((key) => publicKeyFromJwk(key));
        return keys.find((entry) => entry.jwk.kid === jwsHeader.kid);
      });
    } catch {
      return null;
    }
    const now = Math.floor(this.now() / 1000);
    if (claims.aud !== this.options.audience) return null;
    if (
      typeof claims.sub !== "string" ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number"
    )
      return null;
    if (claims.exp - claims.iat > 300 || claims.iat > now + 30 || claims.exp < now - 30)
      return null;
    return { issuer, sub: claims.sub };
  }

  private signProviderJwt(claims: Record<string, unknown>, typ: string): string {
    return signCompactJws(
      JSON.stringify(claims),
      { alg: "ES256", kid: this.key.publicJwk.kid, typ },
      this.key.privateKey,
    );
  }

  private async verifyDelegation(
    request: FakeRequest,
    issuer: string,
  ): Promise<GrantRow | null | "invalid"> {
    const value = header(request, "x-a2a-user-delegation");
    if (value === undefined) return null;
    const token = value.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return "invalid";
    try {
      const verified = await verifyCompactJws(token, async () =>
        publicKeyFromJwk(this.key.publicJwk),
      );
      const claims = JSON.parse(verified.payload.toString("utf8")) as Record<string, unknown>;
      if (claims.aud !== this.interfaceUrl || claims.client_id !== issuer) return "invalid";
      if (typeof claims.exp !== "number" || claims.exp * 1000 < this.now()) return "invalid";
      const grant = this.grants.get(String(claims.grant_id));
      if (!grant || grant.revoked || grant.expiresAt < this.now()) return "invalid";
      return grant;
    } catch {
      return "invalid";
    }
  }

  private issueTokens(grant: GrantRow): FakeResponse {
    const iat = Math.floor(this.now() / 1000);
    const accessToken = this.signProviderJwt(
      {
        iss: this.oauthIssuer,
        aud: this.interfaceUrl,
        sub: grant.brandUserId,
        client_id: grant.clientId,
        scope: grant.scopes.join(" "),
        grant_id: grant.id,
        iat,
        exp: iat + 3600,
      },
      "at+jwt",
    );
    const refreshToken = `rt_${randomUUID().replace(/-/g, "")}`;
    this.refreshTokens.set(refreshToken, { grantId: grant.id, used: false });
    return json({
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      scope: grant.scopes.join(" "),
    });
  }

  private requiredScopes(text: string): string[] | null {
    if (/\bcancel\b/i.test(text)) return ["orders:cancel", "orders:read"];
    if (/\b(status|where|order)\b/i.test(text)) return ["orders:read"];
    return null;
  }

  readonly handle: FakeHandler = async (request) => {
    this.requests.push(request);
    const url = new URL(request.url);
    const path = url.pathname;
    const base = `/a2a/${this.options.brandId}`;
    if (request.method === "GET" && path === `${base}/.well-known/agent-card.json`) {
      return json(this.card(), 200, { "cache-control": "public, max-age=300" });
    }
    if (
      request.method === "GET" &&
      path === `${base}/oauth/.well-known/oauth-authorization-server`
    ) {
      return json({
        issuer: this.oauthIssuer,
        device_authorization_endpoint: `${this.oauthIssuer}/device_authorization`,
        token_endpoint: `${this.oauthIssuer}/token`,
        jwks_uri: `${this.oauthIssuer}/jwks.json`,
        scopes_supported: this.scopes.map((scope) => scope.id),
      });
    }
    if (request.method === "GET" && path === `${base}/oauth/jwks.json`) {
      return json({ keys: [this.key.publicJwk] });
    }
    const auth = await this.verifyPaJwt(request);
    if (path === `${base}/oauth/device_authorization` || path === `${base}/oauth/token`) {
      if (!auth) return { status: 401, headers: { "www-authenticate": 'Bearer realm="a2a"' } };
      const form = new URLSearchParams(request.body ?? "");
      if (form.get("client_id") !== auth.issuer) {
        return json(
          { error: "invalid_client", error_description: "client_id must equal issuer" },
          401,
        );
      }
      if (path.endsWith("device_authorization")) {
        const scopes = (form.get("scope") ?? "").split(" ").filter(Boolean);
        const known = new Set(this.scopes.map((scope) => scope.id));
        if (scopes.length === 0 || scopes.some((scope) => !known.has(scope))) {
          return json({ error: "invalid_scope", error_description: "unknown scope" }, 400);
        }
        const row: DeviceRow = {
          deviceCode: `dc_${randomUUID().replace(/-/g, "")}`,
          userCode: `WDJB-${String(this.devices.length).padStart(4, "0")}`,
          clientId: auth.issuer,
          scopes,
          status: "pending",
          expiresAt: this.now() + 600_000,
          interval: 1,
        };
        this.devices.push(row);
        const login = `https://brand.example/login?return_to=${encodeURIComponent(`${this.oauthIssuer}/consent?user_code=${row.userCode}`)}`;
        return json({
          device_code: row.deviceCode,
          user_code: row.userCode,
          verification_uri: "https://brand.example/login",
          verification_uri_complete: login,
          expires_in: 600,
          interval: row.interval,
        });
      }
      const grantType = form.get("grant_type");
      if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        const row = this.devices.find((device) => device.deviceCode === form.get("device_code"));
        if (!row || row.clientId !== auth.issuer) return json({ error: "invalid_grant" }, 400);
        if (row.expiresAt <= this.now()) return json({ error: "expired_token" }, 400);
        if (row.status === "denied") return json({ error: "access_denied" }, 400);
        if (row.status === "consumed") return json({ error: "invalid_grant" }, 400);
        if (this.slowDownPolls > 0) {
          this.slowDownPolls -= 1;
          return json({ error: "slow_down" }, 400);
        }
        if (row.status === "pending") {
          row.lastPolledAt = this.now();
          return json({ error: "authorization_pending" }, 400);
        }
        row.status = "consumed";
        return this.issueTokens(this.grants.get(row.grantId!)!);
      }
      if (grantType === "refresh_token") {
        const entry = this.refreshTokens.get(form.get("refresh_token") ?? "");
        if (!entry || entry.used) return json({ error: "invalid_grant" }, 400);
        entry.used = true;
        const grant = this.grants.get(entry.grantId);
        if (!grant || grant.revoked) return json({ error: "invalid_grant" }, 400);
        return this.issueTokens(grant);
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (request.method === "POST" && path === `${base}/message:send`) {
      if (!auth) return { status: 401, headers: { "www-authenticate": 'Bearer realm="a2a"' } };
      const delegation = await this.verifyDelegation(request, auth.issuer);
      if (delegation === "invalid") {
        return {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="a2a", error="invalid_token"' },
        };
      }
      let body: { message?: Record<string, unknown> };
      try {
        body = JSON.parse(request.body ?? "") as typeof body;
      } catch {
        return a2aError("INVALID_PARAMS", "Invalid JSON request body");
      }
      const message = body.message ?? {};
      if (message.taskId !== undefined) return a2aError("TASK_NOT_FOUND", "Task not found");
      if (message.role !== "ROLE_USER")
        return a2aError("INVALID_PARAMS", "Message role must be ROLE_USER");
      const parts = Array.isArray(message.parts)
        ? (message.parts as Record<string, unknown>[])
        : [];
      if (parts.length === 0 || parts.some((part) => typeof part.text !== "string")) {
        return a2aError("CONTENT_TYPE_NOT_SUPPORTED", "Content type not supported");
      }
      const text = parts.map((part) => String(part.text)).join("\n");
      if (!text.trim()) return a2aError("INVALID_PARAMS", "Message text must not be blank");
      const paUser = `${auth.issuer}:${auth.sub}`;
      let conversation: Conversation | undefined;
      if (typeof message.contextId === "string") {
        conversation = this.conversations.get(message.contextId);
        if (!conversation || conversation.paUser !== paUser)
          return a2aError("INVALID_PARAMS", "Unknown contextId");
        if (conversation.closed) return a2aError("UNSUPPORTED_OPERATION", "Conversation closed");
        if (
          delegation &&
          conversation.brandUserId &&
          conversation.brandUserId !== delegation.brandUserId
        ) {
          return a2aError("INVALID_PARAMS", "contextId already runs as a different Brand user");
        }
      } else {
        conversation = {
          id: randomUUID(),
          paUser,
          brandUserId: delegation?.brandUserId ?? null,
          closed: false,
          messages: [],
        };
        this.conversations.set(conversation.id, conversation);
      }
      const messageId = String(message.messageId ?? "");
      const duplicate = conversation.messages.findIndex(
        (stored) => stored.messageId === messageId && stored.role === "ROLE_USER",
      );
      if (duplicate >= 0) {
        const reply = conversation.messages[duplicate + 1];
        if (!reply || reply.role !== "ROLE_AGENT") {
          return a2aError(
            "INVALID_PARAMS",
            "messageId was already received in this context and has no reply yet",
          );
        }
        return json({
          message: {
            messageId: reply.messageId,
            contextId: conversation.id,
            role: "ROLE_AGENT",
            parts: [{ text: reply.text }],
            ...(reply.metadata ? { metadata: reply.metadata } : {}),
          },
        });
      }
      const required = this.options.delegated === false ? null : this.requiredScopes(text);
      if (required) {
        const granted = new Set(delegation?.scopes ?? []);
        const missing = required.filter((scope) => !granted.has(scope));
        if (this.alwaysMissingScope) missing.push(this.alwaysMissingScope);
        if (missing.length > 0 || !delegation) {
          // Spec §5.5 step-up: not failed, not stored; the context stays open.
          return json({
            task: {
              id: `t-${randomUUID()}`,
              contextId: conversation.id,
              status: {
                state: "TASK_STATE_AUTH_REQUIRED",
                message: {
                  messageId: randomUUID(),
                  contextId: conversation.id,
                  role: "ROLE_AGENT",
                  parts: [{ text: "I need permission." }],
                },
              },
              metadata: {
                "pact.missingScopes": missing.length > 0 ? missing : required,
                "pact.verificationUriComplete": "https://brand.example/login?return_to=x",
              },
            },
          });
        }
      }
      conversation.messages.push({ messageId, role: "ROLE_USER", text });
      if (this.processingOnce.has(messageId)) {
        this.processingOnce.delete(messageId);
        return a2aError(
          "INVALID_PARAMS",
          "messageId was already received in this context and has no reply yet",
        );
      }
      const replyText = /\bcancel\b/i.test(text)
        ? "Order #A-88213 is cancelled."
        : `Reply to: ${text.slice(0, 80)}`;
      let metadata: Record<string, unknown> | undefined;
      if (delegation && !this.omitNextReceipt) {
        const claims = {
          grantId: delegation.id,
          user: delegation.brandUserId,
          pa: auth.issuer,
          brand: this.interfaceUrl,
          scopesUsed: this.overreachNextReceipt
            ? [...(required ?? []), "orders:refund"]
            : (required ?? []),
          actions: required?.includes("orders:cancel")
            ? [{ tool: "cancel_order", argsHash: "h1" }]
            : [{ tool: "lookup_orders" }],
          ts: new Date(this.now()).toISOString(),
        };
        const jws = signCompactJws(
          JSON.stringify(claims),
          { alg: "ES256", kid: this.key.publicJwk.kid, typ: "pact-receipt+jws" },
          this.key.privateKey,
        );
        const receipt = {
          jws,
          claims: this.tamperNextReceipt ? { ...claims, actions: [] } : claims,
        };
        metadata = {
          "pact.receipt": this.replayNextReceipt && this.lastReceipt ? this.lastReceipt : receipt,
        };
        this.lastReceipt = receipt;
        conversation.brandUserId = delegation.brandUserId;
      }
      this.omitNextReceipt = false;
      this.tamperNextReceipt = false;
      this.overreachNextReceipt = false;
      this.replayNextReceipt = false;
      const reply: StoredMessage = {
        messageId: randomUUID(),
        role: "ROLE_AGENT",
        text: replyText,
        ...(metadata ? { metadata } : {}),
      };
      conversation.messages.push(reply);
      return json({
        message: {
          messageId: reply.messageId,
          contextId: conversation.id,
          role: "ROLE_AGENT",
          parts: [{ text: replyText }],
          ...(metadata ? { metadata } : {}),
        },
      });
    }
    return { status: 404 };
  };

  digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

/**
 * An in-memory PolicyCheckedHttp routing by origin, following GET redirects like the real client
 * and able to drop replies after the handler ran (the "reply lost" case).
 */
export class FakeNetwork implements PolicyCheckedHttp {
  readonly routes = new Map<string, FakeHandler>();
  readonly log: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
    [];
  /** Requests to these URL prefixes are refused as policy denials. */
  denied: string[] = [];
  /** Drop the reply of the next request whose URL matches (the handler still runs). */
  dropReplyFor: RegExp | null = null;

  route(origin: string, handler: FakeHandler): this {
    this.routes.set(origin, handler);
    return this;
  }

  async fetch(input: Parameters<PolicyCheckedHttp["fetch"]>[0]): Promise<PactHttpResponse> {
    const chain: string[] = [];
    let url = input.url;
    for (let hop = 0; hop <= input.maxRedirects; hop += 1) {
      if (this.denied.some((prefix) => url.startsWith(prefix))) {
        throw new PactTransportError("policy_denied", `Network access denied for "${url}"`);
      }
      chain.push(url);
      const origin = new URL(url).origin;
      const handler = this.routes.get(origin);
      if (!handler) throw new PactTransportError("destination_refused", "unknown host");
      this.log.push({
        url,
        method: input.method,
        headers: input.headers,
        ...(input.body ? { body: input.body } : {}),
      });
      const response = await handler({
        method: input.method,
        url,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      if (this.dropReplyFor && this.dropReplyFor.test(url)) {
        this.dropReplyFor = null;
        throw new PactTransportError("timeout", "The request timed out");
      }
      const headers = Object.fromEntries(
        Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      if (
        input.maxRedirects > 0 &&
        [301, 302, 303, 307, 308].includes(response.status) &&
        headers.location
      ) {
        url = new URL(headers.location, url).toString();
        continue;
      }
      const body = response.body ?? "";
      if (Buffer.byteLength(body) > input.maxBytes) {
        throw new PactTransportError("too_large", "The response is larger than CoWork accepts");
      }
      return {
        status: response.status,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        bodyText: body,
        url,
        chain,
      };
    }
    throw new PactTransportError("too_many_redirects", "Too many redirects");
  }
}
