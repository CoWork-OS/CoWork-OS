import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  WEB_API_PATH,
  WEB_API_VERSION,
  WEB_APP_PATH,
  WEB_WORKSPACE_FILE_DOWNLOAD_PATH,
  WEB_WORKSPACE_FILE_UPLOAD_PATH,
  WEB_ARTIFACT_DOWNLOAD_PATH,
  type HostCapabilities,
  type HostCapabilityName,
  type HostIdentity,
  type WebErrorCode,
  type WebPublicBootstrap,
  type WebRpcRequest,
  type WebRpcResponse,
  type WebSessionBootstrap,
} from "../../shared/host-api/contracts";

const DEFAULT_PAIRING_TTL_MS = 90_000;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_SESSION_MAX_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_WS_TICKET_TTL_MS = 30_000;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BODY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_WS_MESSAGE_BYTES = 1024 * 1024;
const PAIRING_ATTEMPT_WINDOW_MS = 5 * 60_000;
const PAIRING_ATTEMPT_LIMIT = 5;
const MAX_PAIRING_CODES = 32;
const MAX_SESSIONS = 256;
const MAX_WS_TICKETS = 512;
const MAX_WS_CONNECTIONS = 128;
const MAX_PAIRING_ATTEMPT_KEYS = 1024;
const CSRF_HEADER = "x-cowork-csrf";
const WS_PROTOCOL = "cowork-web-v1";
const WS_TICKET_PREFIX = "cowork-ticket.";

export type WebDeploymentPolicy =
  | { mode: "loopback" }
  | {
      mode: "https-proxy";
      /** Canonical external HTTPS origin. Paths, credentials, and query strings are forbidden. */
      publicOrigin: string;
      /** Exact TCP peer addresses for the trusted TLS-terminating proxy. */
      trustedProxyAddresses: string[];
    };

export interface WebRequestContext {
  audience: string;
  identity: HostIdentity;
  sessionId: string;
  operationKey?: string;
}

export interface WebRpcMethod {
  capability?: HostCapabilityName;
  mutation?: boolean;
  validateParams?: (value: unknown) => unknown;
  handler: (context: WebRequestContext, params: unknown) => unknown | Promise<unknown>;
}

export interface WebApplicationOptions {
  /** Must be true to expose any browser route. Omission is fail-closed. */
  enabled?: boolean;
  webDirectory: string;
  deployment: WebDeploymentPolicy;
  getHostIdentity: () => HostIdentity;
  getCapabilities: (context: WebRequestContext) => HostCapabilities | Promise<HostCapabilities>;
  getSessionBootstrap: (
    context: WebRequestContext,
  ) =>
    | Omit<WebSessionBootstrap, "apiVersion" | "host" | "csrfToken">
    | Promise<Omit<WebSessionBootstrap, "apiVersion" | "host" | "csrfToken">>;
  /** Exact, named browser RPC methods. There is deliberately no channel fallback. */
  methods?: Record<string, WebRpcMethod>;
  /** Fixed streaming file route, invoked only after browser session and CSRF checks. */
  handleWorkspaceFileDownload?: (
    context: WebRequestContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
  /** Fixed raw upload route, invoked only after browser session and CSRF checks. */
  handleWorkspaceFileUpload?: (
    context: WebRequestContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
  /** Fixed one-use artifact download route, behind the same session and CSRF checks. */
  handleArtifactDownload?: (
    context: WebRequestContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
  onSessionRevoked?: (sessionId: string) => void;
  onClose?: () => void;
  appVersion?: string;
  pairingTtlMs?: number;
  sessionIdleTtlMs?: number;
  sessionMaxTtlMs?: number;
  wsTicketTtlMs?: number;
  maxRequestBytes?: number;
  /** Absolute deadline for reading JSON request bodies, including pairing requests. */
  requestBodyTimeoutMs?: number;
  maxWsMessageBytes?: number;
  maxWsConnections?: number;
  log?: (...args: unknown[]) => void;
}

export interface WebMountOptions {
  audience: string;
  listenerHost: string;
  getListenerPort: () => number | undefined;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export class WebApplicationError extends Error {
  constructor(
    readonly code: WebErrorCode,
    message: string,
    readonly statusCode = 400,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WebApplicationError";
  }
}

interface PairingRecord {
  audience: string;
  expiresAt: number;
}

interface SessionRecord {
  id: string;
  audience: string;
  installationId: string;
  profileId: string;
  generation: string;
  csrfToken: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

interface TicketRecord {
  audience: string;
  sessionKey: string;
  installationId: string;
  profileId: string;
  generation: string;
  expiresAt: number;
}

interface PairingAttemptRecord {
  startedAt: number;
  count: number;
}

interface RequestSecurityContext {
  origin: string;
  secure: boolean;
  remoteAddress: string;
}

export class WebApplication {
  readonly enabled: boolean;
  private readonly options: WebApplicationOptions;
  private readonly methods: Map<string, WebRpcMethod>;
  private readonly pairingCodes = new Map<string, PairingRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly pairingAttempts = new Map<string, PairingAttemptRecord>();
  private readonly mounts = new Map<string, WebApplicationMount>();
  private readonly cookieSalt = crypto.randomBytes(16).toString("hex");
  private readonly webDirectory: string;
  private readonly deployment: WebDeploymentPolicy;
  private readonly publicOrigin: URL | null;

  constructor(options: WebApplicationOptions) {
    if (
      options.requestBodyTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.requestBodyTimeoutMs) ||
        options.requestBodyTimeoutMs < 1 ||
        options.requestBodyTimeoutMs > MAX_REQUEST_BODY_TIMEOUT_MS)
    ) {
      throw new Error(
        `Browser JSON body timeout must be between 1 and ${MAX_REQUEST_BODY_TIMEOUT_MS} ms.`,
      );
    }
    this.options = options;
    this.enabled = options.enabled === true;
    this.webDirectory = path.resolve(options.webDirectory);
    this.deployment = options.deployment;
    this.methods = new Map(Object.entries(options.methods ?? {}));

    for (const [name, method] of this.methods) {
      if (!isValidMethodName(name) || typeof method?.handler !== "function") {
        throw new Error(`Invalid browser RPC registration: ${name}`);
      }
    }

    if (this.deployment.mode === "https-proxy") {
      this.publicOrigin = parseCanonicalPublicOrigin(this.deployment.publicOrigin);
      if (this.deployment.trustedProxyAddresses.length === 0) {
        throw new Error("HTTPS proxy mode requires at least one trusted proxy address.");
      }
    } else {
      this.publicOrigin = null;
    }
  }

  /**
   * Mount this application on one listener. Use a unique audience per listener
   * so cookies, pairing codes, sessions, and tickets cannot cross listeners.
   */
  mount(options: WebMountOptions): WebApplicationMount {
    if (!this.enabled) throw new Error("The browser application is disabled.");
    if (!options.audience.trim()) throw new Error("A browser listener audience is required.");
    if (this.mounts.has(options.audience)) {
      throw new Error(`Browser listener audience is already mounted: ${options.audience}`);
    }

    this.assertListenerBinding(options.listenerHost);
    const mount = new WebApplicationMount(this, options);
    this.mounts.set(options.audience, mount);
    return mount;
  }

  /** Internal mount helpers kept explicit so the listener adapter has no access to auth state. */
  createMountCookieName(audience: string): string {
    const identity = this.options.getHostIdentity();
    const cookieHash = hash(`${identity.installationId}:${audience}:${this.cookieSalt}`).slice(
      0,
      24,
    );
    return this.deployment.mode === "https-proxy" ? `__Host-cw_${cookieHash}` : `cw_${cookieHash}`;
  }

  getWebSocketMessageLimit(): number {
    return this.options.maxWsMessageBytes ?? DEFAULT_MAX_WS_MESSAGE_BYTES;
  }

  getWebSocketConnectionLimit(): number {
    return this.options.maxWsConnections ?? MAX_WS_CONNECTIONS;
  }

  unregisterMount(audience: string, mount: WebApplicationMount): void {
    if (this.mounts.get(audience) === mount) this.mounts.delete(audience);
  }

  logMountError(message: string, error: unknown): void {
    this.log(message, error);
  }

  /** Generate a short-lived code for a trusted operator or host pairing action. */
  createPairingCode(audience: string): PairingCode {
    if (!this.enabled) throw new Error("The browser application is disabled.");
    if (!this.mounts.has(audience)) throw new Error("Browser listener is not active.");
    this.pruneExpiredRecords();
    if (this.pairingCodes.size >= MAX_PAIRING_CODES) {
      throw new WebApplicationError("RATE_LIMITED", "Too many active pairing codes.", 429, true);
    }

    const code = crypto.randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + (this.options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS);
    this.pairingCodes.set(hash(code), { audience, expiresAt });
    return { code, expiresAt };
  }

  /** Revoke browser authority after a local host action or listener shutdown. */
  revokeSessions(audience?: string): void {
    for (const [key, session] of this.sessions) {
      if (!audience || session.audience === audience) this.revokeSession(key);
    }
    for (const [key, ticket] of this.tickets) {
      if (!audience || ticket.audience === audience) this.tickets.delete(key);
    }
    for (const [key, pairing] of this.pairingCodes) {
      if (!audience || pairing.audience === audience) this.pairingCodes.delete(key);
    }
    for (const key of this.pairingAttempts.keys()) {
      if (!audience || key.startsWith(`${audience}:`)) this.pairingAttempts.delete(key);
    }
  }

  /** Close every mounted WebSocket server and invalidate in-memory authority. */
  async close(): Promise<void> {
    const mounts = [...this.mounts.values()];
    await Promise.all(mounts.map((mount) => mount.close()));
    this.revokeSessions();
    this.options.onClose?.();
  }

  assertListenerBinding(listenerHost: string): void {
    if (this.deployment.mode === "loopback") {
      if (!isLoopbackHost(listenerHost)) {
        throw new Error(
          "Browser HTTP is enabled only on a loopback listener without HTTPS proxy configuration.",
        );
      }
      return;
    }

    if (this.publicOrigin?.protocol !== "https:") {
      throw new Error("Browser remote access requires a configured HTTPS public origin.");
    }
  }

  getPublicBootstrap(): WebPublicBootstrap {
    const identity = this.options.getHostIdentity();
    return {
      apiVersion: WEB_API_VERSION,
      appVersion: this.options.appVersion || identity.appVersion,
      authentication: "required",
    };
  }

  handleRequest(
    audience: string,
    listenerHost: string,
    getListenerPort: () => number | undefined,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const url = parseRequestUrl(req.url);
    if (!isWebApplicationPath(url.pathname)) return Promise.resolve(false);
    const mount = this.mounts.get(audience);
    if (!this.enabled || !mount) {
      this.closeIncompleteRequestAfterError(req, res);
      writeError(
        res,
        new WebApplicationError("UNSUPPORTED_CAPABILITY", "Browser application is disabled.", 404),
      );
      return Promise.resolve(true);
    }

    const security = this.validateRequestSecurity(req, listenerHost, getListenerPort, false);
    if (security instanceof WebApplicationError) {
      this.closeIncompleteRequestAfterError(req, res);
      writeError(res, security);
      return Promise.resolve(true);
    }
    this.setCommonSecurityHeaders(res, security.origin);
    return this.routeHttp(audience, security, url, req, res).catch((error) => {
      this.closeIncompleteRequestAfterError(req, res);
      writeError(res, asWebError(error));
      return true;
    });
  }

  async handleUpgrade(
    audience: string,
    listenerHost: string,
    getListenerPort: () => number | undefined,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const url = parseRequestUrl(req.url);
    if (url.pathname !== `${WEB_API_PATH}/ws`) return false;
    const mount = this.mounts.get(audience);
    if (!this.enabled || !mount) {
      rejectUpgrade(socket, 404, "Not Found");
      return true;
    }

    const security = this.validateRequestSecurity(req, listenerHost, getListenerPort, true);
    if (security instanceof WebApplicationError) {
      rejectUpgrade(socket, security.statusCode, security.message);
      return true;
    }

    const protocols = parseWebSocketProtocols(req.headers["sec-websocket-protocol"]);
    const ticketProtocol = protocols.find((protocol) => protocol.startsWith(WS_TICKET_PREFIX));
    const protocolCount = protocols.filter((protocol) =>
      protocol.startsWith(WS_TICKET_PREFIX),
    ).length;
    if (!protocols.includes(WS_PROTOCOL) || !ticketProtocol || protocolCount !== 1) {
      rejectUpgrade(socket, 401, "WebSocket ticket required");
      return true;
    }

    const sessionResult = this.authenticateRequest(audience, req, mount.cookieName);
    if (sessionResult.error || !sessionResult.session) {
      rejectUpgrade(socket, 401, "Session required");
      return true;
    }

    const ticket = ticketProtocol.slice(WS_TICKET_PREFIX.length);
    const ticketRecord = this.consumeTicket(ticket, audience, sessionResult.session);
    if (!ticketRecord) {
      rejectUpgrade(socket, 401, "Invalid or expired WebSocket ticket");
      return true;
    }

    const wsContext: WebRequestContext = {
      audience,
      identity: this.options.getHostIdentity(),
      sessionId: sessionResult.session.id,
    };
    await mount.acceptWebSocket(req, socket, head, wsContext, sessionResult.session, protocols);
    return true;
  }

  private async routeHttp(
    audience: string,
    security: RequestSecurityContext,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    if (url.pathname === "/app") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
      } else {
        res.writeHead(308, { Location: WEB_APP_PATH, "Cache-Control": "no-store" });
        res.end();
      }
      return true;
    }

    if (url.pathname.startsWith(`${WEB_APP_PATH}`)) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
        return true;
      }
      await this.serveApplicationAsset(url.pathname, req.method === "HEAD", res);
      return true;
    }

    if (url.pathname === `${WEB_API_PATH}/bootstrap`) {
      if (req.method !== "GET") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
        return true;
      }
      writeJson(res, 200, this.getPublicBootstrap(), { "Cache-Control": "no-store" });
      return true;
    }

    if (url.pathname === `${WEB_API_PATH}/session/pair`) {
      if (req.method !== "POST") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
        return true;
      }
      this.requireExactOrigin(req, security);
      const body = await readJsonBody(
        req,
        this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
        this.options.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS,
      );
      const pairingCode =
        body && typeof body === "object" && "code" in body && typeof body.code === "string"
          ? body.code
          : "";
      const mount = this.mounts.get(audience);
      if (!mount)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Browser listener is unavailable.",
          404,
        );
      this.consumePairingCode(audience, pairingCode, security.remoteAddress);
      const session = this.createSession(audience);
      const setCookie = this.serializeSessionCookie(mount.cookieName, session.id, security.secure);
      writeJson(
        res,
        200,
        { apiVersion: WEB_API_VERSION, csrfToken: session.csrfToken },
        { "Set-Cookie": setCookie, "Cache-Control": "no-store" },
      );
      return true;
    }

    if (url.pathname === `${WEB_API_PATH}/session/bootstrap`) {
      if (req.method !== "GET") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
        return true;
      }
      this.requireOriginIfPresent(req, security);
      const mount = this.mounts.get(audience);
      if (!mount)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Browser listener is unavailable.",
          404,
        );
      const { session, error } = this.authenticateRequest(audience, req, mount.cookieName);
      if (error || !session) {
        if (error?.code === "STALE_HOST") {
          res.setHeader("Set-Cookie", this.clearSessionCookie(mount.cookieName, security.secure));
        }
        throw error || new WebApplicationError("UNAUTHENTICATED", "Authentication required.", 401);
      }
      const response = await this.getSessionBootstrap(audience, session);
      writeJson(res, 200, response, { "Cache-Control": "no-store" });
      return true;
    }

    if (url.pathname === `${WEB_API_PATH}/session/logout`) {
      if (req.method !== "POST") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
        return true;
      }
      this.requireExactOrigin(req, security);
      const mount = this.mounts.get(audience);
      if (!mount)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Browser listener is unavailable.",
          404,
        );
      const { session, error } = this.authenticateRequest(audience, req, mount.cookieName);
      if (error || !session)
        throw error || new WebApplicationError("UNAUTHENTICATED", "Authentication required.", 401);
      this.requireCsrf(req, session);
      this.revokeSession(hash(session.id));
      writeJson(
        res,
        200,
        { apiVersion: WEB_API_VERSION, loggedOut: true },
        {
          "Set-Cookie": this.clearSessionCookie(mount.cookieName, security.secure),
          "Cache-Control": "no-store",
        },
      );
      return true;
    }

    if (url.pathname === `${WEB_API_PATH}/session/ws-ticket`) {
      if (req.method !== "POST") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
        return true;
      }
      this.requireExactOrigin(req, security);
      const mount = this.mounts.get(audience);
      if (!mount)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Browser listener is unavailable.",
          404,
        );
      const { session, error } = this.authenticateRequest(audience, req, mount.cookieName);
      if (error || !session)
        throw error || new WebApplicationError("UNAUTHENTICATED", "Authentication required.", 401);
      this.requireCsrf(req, session);
      const ticket = this.createTicket(audience, session);
      writeJson(
        res,
        200,
        { apiVersion: WEB_API_VERSION, ticket: ticket.value, expiresAt: ticket.expiresAt },
        { "Cache-Control": "no-store" },
      );
      return true;
    }

    if (url.pathname === WEB_WORKSPACE_FILE_UPLOAD_PATH) {
      return await this.routeWorkspaceFileUpload(audience, security, req, res);
    }

    if (url.pathname === WEB_WORKSPACE_FILE_DOWNLOAD_PATH) {
      if (req.method !== "POST") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
        return true;
      }
      this.requireExactOrigin(req, security);
      const mount = this.mounts.get(audience);
      if (!mount)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Browser listener is unavailable.",
          404,
        );
      const { session, error } = this.authenticateRequest(audience, req, mount.cookieName);
      if (error || !session)
        throw error || new WebApplicationError("UNAUTHENTICATED", "Authentication required.", 401);
      this.requireCsrf(req, session);
      const handler = this.options.handleWorkspaceFileDownload;
      if (!handler)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Workspace file transfer is unavailable.",
          404,
        );
      await handler(this.requestContext(audience, session), req, res);
      return true;
    }

    if (url.pathname === WEB_ARTIFACT_DOWNLOAD_PATH) {
      if (req.method !== "POST") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
        return true;
      }
      this.requireExactOrigin(req, security);
      const mount = this.mounts.get(audience);
      if (!mount) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Browser listener is unavailable.",
          404,
        );
      }
      const { session, error } = this.authenticateRequest(audience, req, mount.cookieName);
      if (error || !session) {
        throw error || new WebApplicationError("UNAUTHENTICATED", "Authentication required.", 401);
      }
      this.requireCsrf(req, session);
      const handler = this.options.handleArtifactDownload;
      if (!handler) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Artifact downloads are unavailable.",
          404,
        );
      }
      await handler(this.requestContext(audience, session), req, res);
      return true;
    }

    if (url.pathname === `${WEB_API_PATH}/rpc`) {
      if (req.method !== "POST") {
        writeError(res, new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405));
        return true;
      }
      this.requireExactOrigin(req, security);
      const mount = this.mounts.get(audience);
      if (!mount)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Browser listener is unavailable.",
          404,
        );
      const { session, error } = this.authenticateRequest(audience, req, mount.cookieName);
      if (error || !session)
        throw error || new WebApplicationError("UNAUTHENTICATED", "Authentication required.", 401);
      this.requireCsrf(req, session);
      const input = await readJsonBody(
        req,
        this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
        this.options.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS,
      );
      const response = await this.dispatchRpc(audience, session, input as WebRpcRequest);
      writeJson(res, 200, response, { "Cache-Control": "no-store" });
      return true;
    }

    writeError(res, new WebApplicationError("UNSUPPORTED_CAPABILITY", "Not found.", 404));
    return true;
  }

  private async routeWorkspaceFileUpload(
    audience: string,
    security: RequestSecurityContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    if (req.method !== "POST") {
      throw new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405);
    }
    this.requireExactOrigin(req, security);
    const mount = this.mounts.get(audience);
    if (!mount) {
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "Browser listener is unavailable.",
        404,
      );
    }
    const { session, error } = this.authenticateRequest(audience, req, mount.cookieName);
    if (error || !session) {
      throw error || new WebApplicationError("UNAUTHENTICATED", "Authentication required.", 401);
    }
    this.requireCsrf(req, session);
    const handler = this.options.handleWorkspaceFileUpload;
    if (!handler) {
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "Workspace file upload is unavailable.",
        404,
      );
    }
    await handler(this.requestContext(audience, session), req, res);
    return true;
  }

  private closeIncompleteRequestAfterError(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (req.complete || req.destroyed || res.headersSent || res.writableEnded) {
      return;
    }
    res.shouldKeepAlive = false;
    res.setHeader("Connection", "close");
    res.once("finish", () => req.destroy());
  }

  async dispatchRpc(
    audience: string,
    session: SessionRecord,
    rawRequest: unknown,
  ): Promise<WebRpcResponse> {
    const candidateId =
      rawRequest && typeof rawRequest === "object"
        ? (rawRequest as Record<string, unknown>).id
        : undefined;
    const id =
      typeof candidateId === "string" && candidateId.length <= 128 ? candidateId : "invalid";
    try {
      const request = validateRpcRequest(rawRequest);
      this.assertActiveSession(session);
      const method = this.methods.get(request.method);
      if (!method) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Unsupported browser operation.",
          404,
        );
      }
      const context = this.requestContext(audience, session, request.operationKey);
      if (method.capability) {
        const capabilities = await this.options.getCapabilities(context);
        if (capabilities[method.capability]?.available !== true) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "This operation is unavailable on this host.",
            403,
          );
        }
      }
      if (method.mutation && !request.operationKey) {
        throw new WebApplicationError(
          "INVALID_REQUEST",
          "A stable operation key is required.",
          400,
        );
      }
      const params = method.validateParams ? method.validateParams(request.params) : request.params;
      const result = await method.handler(context, params);
      const serialized = JSON.stringify(result ?? null);
      if (serialized === undefined) {
        throw new WebApplicationError(
          "INVALID_REQUEST",
          "Browser operation result is not serializable.",
          500,
        );
      }
      if (
        Buffer.byteLength(serialized, "utf8") >
        (this.options.maxWsMessageBytes ?? DEFAULT_MAX_WS_MESSAGE_BYTES)
      ) {
        throw new WebApplicationError(
          "INVALID_REQUEST",
          "Browser operation result is too large.",
          413,
        );
      }
      return { apiVersion: WEB_API_VERSION, type: "response", id, result: result ?? null };
    } catch (error) {
      const normalized = asWebError(error);
      return {
        apiVersion: WEB_API_VERSION,
        type: "response",
        id,
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
        },
      };
    }
  }

  async getSessionBootstrap(
    audience: string,
    session: SessionRecord,
  ): Promise<WebSessionBootstrap & { csrfToken: string }> {
    const context = this.requestContext(audience, session);
    const [data, capabilities] = await Promise.all([
      this.options.getSessionBootstrap(context),
      this.options.getCapabilities(context),
    ]);
    return {
      apiVersion: WEB_API_VERSION,
      host: context.identity,
      capabilities,
      providerReady: data.providerReady,
      onboardingCompleted: data.onboardingCompleted,
      disclaimerAccepted: data.disclaimerAccepted,
      activeWorkspaceId: data.activeWorkspaceId,
      csrfToken: session.csrfToken,
    };
  }

  validateRequestSecurity(
    req: http.IncomingMessage,
    listenerHost: string,
    getListenerPort: () => number | undefined,
    requireOrigin: boolean,
  ): RequestSecurityContext | WebApplicationError {
    const hostHeader = singleHeader(req.headers.host);
    if (!hostHeader) return new WebApplicationError("INVALID_REQUEST", "Invalid Host header.", 400);

    let hostUrl: URL;
    try {
      hostUrl = new URL(`http://${hostHeader}`);
    } catch {
      return new WebApplicationError("INVALID_REQUEST", "Invalid Host header.", 400);
    }
    if (
      hostUrl.username ||
      hostUrl.password ||
      hostUrl.pathname !== "/" ||
      hostUrl.search ||
      hostUrl.hash
    ) {
      return new WebApplicationError("INVALID_REQUEST", "Invalid Host header.", 400);
    }

    const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "unknown");
    let origin: string;
    let secure = false;

    if (this.deployment.mode === "loopback") {
      if (!isLoopbackHost(listenerHost) || !isLoopbackHost(hostUrl.hostname)) {
        return new WebApplicationError(
          "FORBIDDEN",
          "Browser access is restricted to loopback.",
          403,
        );
      }
      const listenerPort = getListenerPort();
      if (listenerPort !== undefined && listenerPort > 0 && hostUrl.port !== String(listenerPort)) {
        return new WebApplicationError(
          "FORBIDDEN",
          "Host does not match the browser listener.",
          403,
        );
      }
      secure = Boolean((req.socket as import("net").Socket & { encrypted?: boolean }).encrypted);
      origin = `${secure ? "https" : "http"}://${hostUrl.host}`;
    } else {
      const publicOrigin = this.publicOrigin;
      if (!publicOrigin)
        return new WebApplicationError("FORBIDDEN", "HTTPS public origin is unavailable.", 403);
      if (hostUrl.host.toLowerCase() !== publicOrigin.host.toLowerCase()) {
        return new WebApplicationError(
          "FORBIDDEN",
          "Host does not match the configured public origin.",
          403,
        );
      }
      const isTrustedProxy = this.deployment.trustedProxyAddresses
        .map(normalizeRemoteAddress)
        .includes(remoteAddress);
      const forwardedProto = singleHeader(req.headers["x-forwarded-proto"]);
      const directTls = Boolean(
        (req.socket as import("net").Socket & { encrypted?: boolean }).encrypted,
      );
      if (!directTls && (!isTrustedProxy || forwardedProto !== "https")) {
        return new WebApplicationError(
          "FORBIDDEN",
          "HTTPS through the configured trusted proxy is required.",
          403,
        );
      }
      if (forwardedProto && forwardedProto !== "https") {
        return new WebApplicationError("FORBIDDEN", "Invalid forwarded protocol.", 403);
      }
      secure = true;
      origin = publicOrigin.origin;
    }

    const originHeader = singleHeader(req.headers.origin);
    if (requireOrigin && !originHeader) {
      return new WebApplicationError("FORBIDDEN", "Origin header is required.", 403);
    }
    if (originHeader && !isExactOrigin(originHeader, origin)) {
      return new WebApplicationError(
        "FORBIDDEN",
        "Origin does not match the browser listener.",
        403,
      );
    }
    return { origin, secure, remoteAddress };
  }

  setCommonSecurityHeaders(res: http.ServerResponse, origin: string): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        `connect-src 'self' ${origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  }

  private requireExactOrigin(req: http.IncomingMessage, security: RequestSecurityContext): void {
    const origin = singleHeader(req.headers.origin);
    if (!origin || !isExactOrigin(origin, security.origin)) {
      throw new WebApplicationError(
        "FORBIDDEN",
        "Origin does not match the browser listener.",
        403,
      );
    }
    const fetchSite = singleHeader(req.headers["sec-fetch-site"]);
    if (fetchSite && fetchSite !== "same-origin") {
      throw new WebApplicationError("FORBIDDEN", "Cross-origin request rejected.", 403);
    }
  }

  private requireOriginIfPresent(
    req: http.IncomingMessage,
    security: RequestSecurityContext,
  ): void {
    const origin = singleHeader(req.headers.origin);
    if (origin && !isExactOrigin(origin, security.origin)) {
      throw new WebApplicationError(
        "FORBIDDEN",
        "Origin does not match the browser listener.",
        403,
      );
    }
  }

  private requireCsrf(req: http.IncomingMessage, session: SessionRecord): void {
    const csrf = singleHeader(req.headers[CSRF_HEADER]);
    if (!csrf || !timingSafeEqualString(csrf, session.csrfToken)) {
      throw new WebApplicationError("FORBIDDEN", "Invalid CSRF token.", 403);
    }
  }

  private consumePairingCode(audience: string, code: string, remoteAddress: string): void {
    this.pruneExpiredRecords();
    const attemptKey = `${audience}:${remoteAddress}`;
    const now = Date.now();
    const attempt = this.pairingAttempts.get(attemptKey);
    if (
      attempt &&
      now - attempt.startedAt < PAIRING_ATTEMPT_WINDOW_MS &&
      attempt.count >= PAIRING_ATTEMPT_LIMIT
    ) {
      throw new WebApplicationError("RATE_LIMITED", "Too many pairing attempts.", 429, true);
    }
    if (!attempt || now - attempt.startedAt >= PAIRING_ATTEMPT_WINDOW_MS) {
      if (!attempt && this.pairingAttempts.size >= MAX_PAIRING_ATTEMPT_KEYS) {
        throw new WebApplicationError("RATE_LIMITED", "Too many pairing sources.", 429, true);
      }
      this.pairingAttempts.set(attemptKey, { startedAt: now, count: 1 });
    } else {
      attempt.count += 1;
    }

    if (!code || code.length < 24 || code.length > 128) {
      throw new WebApplicationError("UNAUTHENTICATED", "Invalid or expired pairing code.", 401);
    }
    const key = hash(code);
    const record = this.pairingCodes.get(key);
    if (!record || record.audience !== audience || record.expiresAt <= now) {
      this.pairingCodes.delete(key);
      throw new WebApplicationError("UNAUTHENTICATED", "Invalid or expired pairing code.", 401);
    }
    this.pairingCodes.delete(key);
    this.pairingAttempts.delete(attemptKey);
  }

  private createSession(audience: string): SessionRecord {
    this.pruneExpiredRecords();
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new WebApplicationError("RATE_LIMITED", "Too many active browser sessions.", 429, true);
    }
    const identity = this.options.getHostIdentity();
    const id = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const session: SessionRecord = {
      id,
      audience,
      installationId: identity.installationId,
      profileId: identity.profileId,
      generation: identity.generation,
      csrfToken: crypto.randomBytes(32).toString("base64url"),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + (this.options.sessionMaxTtlMs ?? DEFAULT_SESSION_MAX_TTL_MS),
    };
    this.sessions.set(hash(id), session);
    return session;
  }

  private createTicket(
    audience: string,
    session: SessionRecord,
  ): { value: string; expiresAt: number } {
    this.pruneExpiredRecords();
    if (this.tickets.size >= MAX_WS_TICKETS) {
      throw new WebApplicationError(
        "RATE_LIMITED",
        "Too many active WebSocket tickets.",
        429,
        true,
      );
    }
    const identity = this.options.getHostIdentity();
    this.assertSessionIdentity(session, identity);
    const value = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + (this.options.wsTicketTtlMs ?? DEFAULT_WS_TICKET_TTL_MS);
    this.tickets.set(hash(value), {
      audience,
      sessionKey: hash(session.id),
      installationId: identity.installationId,
      profileId: identity.profileId,
      generation: identity.generation,
      expiresAt,
    });
    return { value, expiresAt };
  }

  private consumeTicket(
    ticket: string,
    audience: string,
    session: SessionRecord,
  ): TicketRecord | null {
    this.pruneExpiredRecords();
    const key = hash(ticket);
    const record = this.tickets.get(key);
    if (
      !record ||
      record.audience !== audience ||
      record.sessionKey !== hash(session.id) ||
      record.expiresAt <= Date.now()
    ) {
      return null;
    }
    this.tickets.delete(key);
    const identity = this.options.getHostIdentity();
    if (
      record.installationId !== identity.installationId ||
      record.profileId !== identity.profileId ||
      record.generation !== identity.generation
    ) {
      return null;
    }
    return record;
  }

  private authenticateRequest(
    audience: string,
    req: http.IncomingMessage,
    cookieName: string,
  ): { session?: SessionRecord; error?: WebApplicationError } {
    const cookieValue = readCookie(req.headers.cookie, cookieName);
    if (!cookieValue)
      return { error: new WebApplicationError("UNAUTHENTICATED", "Authentication required.", 401) };
    const key = hash(cookieValue);
    const session = this.sessions.get(key);
    if (!session || session.audience !== audience) {
      return { error: new WebApplicationError("UNAUTHENTICATED", "Authentication required.", 401) };
    }

    const now = Date.now();
    if (
      now - session.lastUsedAt > (this.options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS) ||
      now >= session.expiresAt
    ) {
      this.revokeSession(key);
      return { error: new WebApplicationError("UNAUTHENTICATED", "Session expired.", 401) };
    }
    try {
      this.assertSessionIdentity(session, this.options.getHostIdentity());
    } catch (error) {
      this.revokeSession(key);
      return { error: asWebError(error) };
    }
    session.lastUsedAt = now;
    return { session };
  }

  private assertSessionIdentity(session: SessionRecord, identity: HostIdentity): void {
    if (
      session.installationId !== identity.installationId ||
      session.profileId !== identity.profileId ||
      session.generation !== identity.generation
    ) {
      throw new WebApplicationError(
        "STALE_HOST",
        "The host identity changed. Pair this browser again.",
        401,
      );
    }
  }

  private assertActiveSession(session: SessionRecord): void {
    const key = hash(session.id);
    const now = Date.now();
    if (
      this.sessions.get(key) !== session ||
      session.expiresAt <= now ||
      now - session.lastUsedAt > (this.options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS)
    ) {
      this.revokeSession(key);
      throw new WebApplicationError("UNAUTHENTICATED", "Session expired.", 401);
    }
    try {
      this.assertSessionIdentity(session, this.options.getHostIdentity());
    } catch (error) {
      this.revokeSession(key);
      throw error;
    }
    session.lastUsedAt = now;
  }

  private requestContext(
    audience: string,
    session: SessionRecord,
    operationKey?: string,
  ): WebRequestContext {
    const identity = this.options.getHostIdentity();
    this.assertSessionIdentity(session, identity);
    return { audience, identity, sessionId: session.id, ...(operationKey ? { operationKey } : {}) };
  }

  private serializeSessionCookie(cookieName: string, value: string, secure: boolean): string {
    return [
      `${cookieName}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor((this.options.sessionMaxTtlMs ?? DEFAULT_SESSION_MAX_TTL_MS) / 1000)}`,
      ...(secure ? ["Secure"] : []),
    ].join("; ");
  }

  private clearSessionCookie(cookieName: string, secure: boolean): string {
    return [
      `${cookieName}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
      ...(secure ? ["Secure"] : []),
    ].join("; ");
  }

  private revokeSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    this.sessions.delete(sessionKey);
    this.options.onSessionRevoked?.(session.id);
    for (const [ticketKey, ticket] of this.tickets) {
      if (ticket.sessionKey === sessionKey) this.tickets.delete(ticketKey);
    }
    this.mounts.get(session.audience)?.closeSessionSockets(session.id);
  }

  private pruneExpiredRecords(): void {
    const now = Date.now();
    for (const [key, value] of this.pairingCodes)
      if (value.expiresAt <= now) this.pairingCodes.delete(key);
    for (const [key, value] of this.tickets) if (value.expiresAt <= now) this.tickets.delete(key);
    for (const [key, value] of this.sessions) {
      if (
        value.expiresAt <= now ||
        now - value.lastUsedAt > (this.options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS)
      )
        this.revokeSession(key);
    }
    for (const [key, value] of this.pairingAttempts) {
      if (now - value.startedAt >= PAIRING_ATTEMPT_WINDOW_MS) this.pairingAttempts.delete(key);
    }
  }

  private async serveApplicationAsset(
    pathname: string,
    headOnly: boolean,
    res: http.ServerResponse,
  ): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname.slice(WEB_APP_PATH.length));
    } catch {
      writeError(res, new WebApplicationError("INVALID_REQUEST", "Invalid application path.", 400));
      return;
    }
    if (decoded.includes("\0") || decoded.includes("\\")) {
      writeError(res, new WebApplicationError("INVALID_REQUEST", "Invalid application path.", 400));
      return;
    }

    const relative = decoded || "index.html";
    let filePath = path.resolve(this.webDirectory, relative);
    if (!isWithinPath(this.webDirectory, filePath)) {
      writeError(res, new WebApplicationError("FORBIDDEN", "Invalid application path.", 403));
      return;
    }

    try {
      const canonicalRoot = await fs.promises.realpath(this.webDirectory);
      let canonicalFile = await fs.promises.realpath(filePath).catch(() => null);
      if (!canonicalFile) {
        filePath = path.join(this.webDirectory, "index.html");
        canonicalFile = await fs.promises.realpath(filePath).catch(() => null);
      }
      if (!canonicalFile || !isWithinPath(canonicalRoot, canonicalFile)) {
        writeError(
          res,
          new WebApplicationError("UNSUPPORTED_CAPABILITY", "Application asset not found.", 404),
        );
        return;
      }
      const stat = await fs.promises.stat(canonicalFile);
      if (!stat.isFile()) {
        writeError(
          res,
          new WebApplicationError("UNSUPPORTED_CAPABILITY", "Application asset not found.", 404),
        );
        return;
      }
      const contentType = contentTypeFor(canonicalFile);
      const isIndex = path.basename(canonicalFile) === "index.html";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        "Cache-Control": isIndex ? "no-store" : "public, max-age=31536000, immutable",
      });
      if (headOnly) {
        res.end();
        return;
      }
      fs.createReadStream(canonicalFile).pipe(res);
    } catch {
      writeError(
        res,
        new WebApplicationError("UNSUPPORTED_CAPABILITY", "Application is unavailable.", 404),
      );
    }
  }

  private log(message: string, details?: unknown): void {
    this.options.log?.(message, details);
  }
}

export class WebApplicationMount {
  readonly cookieName: string;
  private readonly audience: string;
  private readonly listenerHost: string;
  private readonly getListenerPort: () => number | undefined;
  private readonly wsServer: WebSocketServer;
  private readonly sockets = new Map<
    WebSocket,
    { sessionId: string; context: WebRequestContext }
  >();
  private closed = false;

  constructor(
    private readonly app: WebApplication,
    options: WebMountOptions,
  ) {
    this.audience = options.audience;
    this.listenerHost = options.listenerHost;
    this.getListenerPort = options.getListenerPort;
    this.cookieName = app.createMountCookieName(this.audience);
    this.wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: app.getWebSocketMessageLimit(),
      handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    });
  }

  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    return this.app.handleRequest(this.audience, this.listenerHost, this.getListenerPort, req, res);
  }

  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    return this.app.handleUpgrade(
      this.audience,
      this.listenerHost,
      this.getListenerPort,
      req,
      socket,
      head,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.app.revokeSessions(this.audience);
    this.app.unregisterMount(this.audience, this);
    for (const ws of this.sockets.keys()) ws.close(1001, "Browser listener stopped");
    this.sockets.clear();
    if (this.wsServer.clients.size === 0) {
      await new Promise<void>((resolve) => this.wsServer.close(() => resolve()));
    } else {
      await new Promise<void>((resolve) => {
        this.wsServer.close(() => resolve());
        setTimeout(resolve, 500).unref();
      });
    }
  }

  closeSessionSockets(sessionId: string): void {
    for (const [ws, connection] of this.sockets) {
      if (connection.sessionId !== sessionId) continue;
      ws.close(4001, "Session revoked");
      this.sockets.delete(ws);
    }
  }

  async acceptWebSocket(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    context: WebRequestContext,
    session: SessionRecord,
    protocols: string[],
  ): Promise<WebSocket | null> {
    if (this.closed || !protocols.includes(WS_PROTOCOL)) {
      rejectUpgrade(socket, 400, "Invalid WebSocket upgrade");
      return null;
    }
    const maxConnections = this.app.getWebSocketConnectionLimit();
    if (this.sockets.size >= maxConnections) {
      rejectUpgrade(socket, 429, "Too many browser connections");
      return null;
    }

    return new Promise((resolve) => {
      this.wsServer.handleUpgrade(req, socket, head, (ws) => {
        const connectionContext = { ...context, sessionId: session.id };
        this.sockets.set(ws, { sessionId: session.id, context: connectionContext });
        ws.on("message", async (data, isBinary) => {
          if (isBinary) {
            ws.close(1003, "Binary frames are unsupported");
            return;
          }
          const payload = toBuffer(data);
          if (payload.length > this.app.getWebSocketMessageLimit()) {
            ws.close(1009, "Message too large");
            return;
          }
          let request: unknown;
          try {
            request = JSON.parse(payload.toString("utf8"));
          } catch {
            ws.send(
              JSON.stringify(rpcError("invalid", "INVALID_REQUEST", "Invalid JSON request.")),
            );
            return;
          }
          const response = await this.app.dispatchRpc(this.audience, session, request);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
        });
        ws.on("close", () => this.sockets.delete(ws));
        ws.on("error", (error) => this.app.logMountError("Browser WebSocket error", error));
        resolve(ws);
      });
    });
  }
}

function validateRpcRequest(value: unknown): WebRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid RPC request.", 400);
  }
  const record = value as Record<string, unknown>;
  if (record.apiVersion !== WEB_API_VERSION || record.type !== "request") {
    throw new WebApplicationError("INVALID_REQUEST", "Unsupported RPC protocol version.", 400);
  }
  if (typeof record.id !== "string" || record.id.length < 1 || record.id.length > 128) {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid RPC request ID.", 400);
  }
  if (!isValidMethodName(record.method)) {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid browser operation name.", 400);
  }
  if (!Object.prototype.hasOwnProperty.call(record, "params")) {
    throw new WebApplicationError("INVALID_REQUEST", "RPC params are required.", 400);
  }
  if (
    record.operationKey !== undefined &&
    (typeof record.operationKey !== "string" ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(record.operationKey))
  ) {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid operation key.", 400);
  }
  return value as WebRpcRequest;
}

function rpcError(id: string, code: WebErrorCode, message: string): WebRpcResponse {
  return {
    apiVersion: WEB_API_VERSION,
    type: "response",
    id,
    error: { code, message, retryable: false },
  };
}

function asWebError(error: unknown): WebApplicationError {
  if (error instanceof WebApplicationError) return error;
  return new WebApplicationError("INTERNAL_ERROR", "The browser operation failed.", 500);
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<unknown> {
  const contentType = singleHeader(req.headers["content-type"]);
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new WebApplicationError("INVALID_REQUEST", "Content-Type must be application/json.", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(new WebApplicationError("INVALID_REQUEST", "Request body is too large.", 413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onAborted = () =>
      finish(new WebApplicationError("INVALID_REQUEST", "Request body was interrupted.", 400));
    const timeout = setTimeout(
      () => finish(new WebApplicationError("INVALID_REQUEST", "Request body timed out.", 408)),
      timeoutMs,
    );
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid JSON request body.", 400);
  }
}

function parseRequestUrl(value?: string): URL {
  try {
    return new URL(value || "/", "http://web.invalid");
  } catch {
    return new URL("/invalid", "http://web.invalid");
  }
}

function isWebApplicationPath(pathname: string): boolean {
  return (
    pathname === "/app" ||
    pathname.startsWith(WEB_APP_PATH) ||
    pathname === WEB_API_PATH ||
    pathname.startsWith(`${WEB_API_PATH}/`)
  );
}

function parseCanonicalPublicOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The configured browser public origin is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (value !== parsed.origin && value !== `${parsed.origin}/`)
  ) {
    throw new Error("Browser public origin must be an HTTPS origin without a path.");
  }
  return parsed;
}

function isExactOrigin(raw: string, expected: string): boolean {
  try {
    const parsed = new URL(raw);
    return (
      parsed.origin === raw && parsed.origin === expected && !parsed.username && !parsed.password
    );
  } catch {
    return false;
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.length === 1) return value[0].trim();
  return undefined;
}

function isLoopbackHost(value: string): boolean {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizeRemoteAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

function isValidMethodName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-zA-Z0-9_.-]{0,79}$/.test(value);
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function readCookie(header: string | undefined, cookieName: string): string | null {
  if (!header || header.length > 16 * 1024) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== cookieName) continue;
    const value = entry.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(value)) return null;
    return value;
  }
  return null;
}

function parseWebSocketProtocols(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value || "";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return;
  const safeMessage = message.replace(/[\r\n]/g, " ");
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] || "Error"}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(safeMessage)}\r\n\r\n${safeMessage}`,
    );
  } finally {
    socket.destroy();
  }
}

function toBuffer(data: import("ws").RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function writeError(res: http.ServerResponse, error: WebApplicationError): void {
  if (res.headersSent || res.writableEnded) return;
  writeJson(res, error.statusCode, {
    apiVersion: WEB_API_VERSION,
    error: { code: error.code, message: error.message, retryable: error.retryable },
  });
}

function isWithinPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return contentTypes[extension] || "application/octet-stream";
}
