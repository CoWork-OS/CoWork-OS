import {
  WEB_API_PATH,
  WEB_API_VERSION,
  WEB_ERROR_CODES,
  type WebError,
  type WebErrorCode,
  type WebRpcEvent,
  type WebRpcRequest,
  type WebSessionBootstrap,
} from "../shared/host-api/contracts";

export class WebTransportError extends Error {
  readonly code: WebErrorCode;
  readonly retryable: boolean;

  constructor(error: WebError) {
    super(error.message);
    this.name = "WebTransportError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export type BrowserConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reauth_required"
  | "version_mismatch"
  | "closed";

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  mutation: boolean;
};

/** Build URLs beside /app/ while preserving a reverse-proxy path prefix. */
export function webEndpoint(path: string, appUrl = document.baseURI): URL {
  const suffix = path.replace(/^\/+/, "");
  return new URL(`../${WEB_API_PATH.slice(1)}/${suffix}`, appUrl);
}

export class BrowserHostTransport {
  private socket: WebSocket | null = null;
  private openingSocket: WebSocket | null = null;
  private rejectOpening: ((error: Error) => void) | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = true;
  private state: BrowserConnectionState = "closed";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: WebRpcEvent) => void>();
  private readonly stateListeners = new Set<(state: BrowserConnectionState) => void>();

  constructor(private session: WebSessionBootstrap) {}

  get connectionState(): BrowserConnectionState {
    return this.state;
  }

  onEvent(listener: (event: WebRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onState(listener: (state: BrowserConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  updateSession(session: WebSessionBootstrap): void {
    if (
      session.host.installationId !== this.session.host.installationId ||
      session.host.profileId !== this.session.host.profileId ||
      session.host.generation !== this.session.host.generation
    ) {
      this.close();
      throw new WebTransportError({
        code: "STALE_HOST",
        message: "The CoWork host changed. Reload its current state before continuing.",
        retryable: false,
      });
    }
    this.session = session;
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this.connect();
    } catch (error) {
      this.handleConnectionFailure(error);
    }
  }

  async retryNow(): Promise<void> {
    if (this.state === "version_mismatch") return;
    this.stopped = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      await this.connect();
    } catch (error) {
      this.handleConnectionFailure(error);
    }
  }

  async request<T>(
    method: string,
    params: unknown,
    options: { operationKey?: string; mutation?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new WebTransportError({
        code: "HOST_UNAVAILABLE",
        message: "The CoWork host is disconnected.",
        retryable: true,
      });
    }
    if (options.mutation && !options.operationKey) {
      throw new WebTransportError({
        code: "INVALID_REQUEST",
        message: "A stable operation key is required for this action.",
        retryable: false,
      });
    }

    const id = crypto.randomUUID();
    const frame: WebRpcRequest = {
      apiVersion: WEB_API_VERSION,
      type: "request",
      id,
      method,
      params,
      ...(options.operationKey ? { operationKey: options.operationKey } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new WebTransportError({
              code: options.mutation ? "OUTCOME_UNKNOWN" : "HOST_UNAVAILABLE",
              message: options.mutation
                ? "The host has not confirmed this action. Reconcile its operation key before retrying."
                : "The CoWork host did not respond.",
              retryable: !options.mutation,
            }),
          );
        },
        Math.min(120_000, Math.max(1_000, options.timeoutMs ?? 30_000)),
      );
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timeout,
        mutation: options.mutation === true,
      });
      try {
        this.socket!.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Could not send request to the host."));
      }
    });
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    const rejectOpening = this.rejectOpening;
    this.rejectOpening = null;
    this.openingSocket = null;
    rejectOpening?.(new Error("The browser connection was closed."));
    socket?.close();
    this.rejectPending();
    this.setState("closed");
  }

  private async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.setState("connecting");
    this.connecting = this.openSocket().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openSocket(): Promise<void> {
    const ticketResponse = await fetch(webEndpoint("session/ws-ticket"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-CoWork-CSRF": this.session.csrfToken },
    });
    if (this.stopped) return;
    if (ticketResponse.status === 401) {
      this.setState("reauth_required");
      throw new WebTransportError({
        code: "UNAUTHENTICATED",
        message: "Sign in to the CoWork host again.",
        retryable: false,
      });
    }
    if (!ticketResponse.ok) {
      throw new WebTransportError({
        code: "HOST_UNAVAILABLE",
        message: "Could not open the CoWork connection.",
        retryable: true,
      });
    }
    let ticketBody: unknown;
    try {
      ticketBody = await ticketResponse.json();
    } catch {
      throw new WebTransportError({
        code: "INVALID_REQUEST",
        message: "The CoWork host returned an invalid connection ticket.",
        retryable: false,
      });
    }
    if (this.stopped) return;
    if (
      !isRecord(ticketBody) ||
      typeof ticketBody.ticket !== "string" ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(ticketBody.ticket)
    ) {
      throw new WebTransportError({
        code: "INVALID_REQUEST",
        message: "The CoWork host returned an invalid connection ticket.",
        retryable: false,
      });
    }
    const url = webEndpoint("ws");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, ["cowork-web-v1", `cowork-ticket.${ticketBody.ticket}`]);
      this.socket = socket;
      this.openingSocket = socket;
      this.rejectOpening = reject;
      let opened = false;
      const settleOpenFailure = (error: Error) => {
        if (this.openingSocket === socket) {
          this.openingSocket = null;
          this.rejectOpening = null;
        }
        reject(error);
      };
      socket.addEventListener("open", () => {
        if (this.socket !== socket || this.stopped) {
          settleOpenFailure(new Error("The browser connection was closed."));
          socket.close();
          return;
        }
        opened = true;
        if (this.openingSocket === socket) {
          this.openingSocket = null;
          this.rejectOpening = null;
        }
        this.attempts = 0;
        this.setState("connected");
        resolve();
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data, socket));
      socket.addEventListener("error", () => {
        if (!opened) settleOpenFailure(new Error("Could not open the CoWork connection."));
      });
      socket.addEventListener("close", () => {
        const isCurrentSocket = this.socket === socket;
        if (isCurrentSocket) {
          this.socket = null;
          this.rejectPending();
        }
        if (!opened) settleOpenFailure(new Error("Could not open the CoWork connection."));
        if (!isCurrentSocket) return;
        if (this.state === "version_mismatch") return;
        if (this.stopped) return;
        this.setState("disconnected");
        this.scheduleReconnect();
      });
    });
  }

  private handleMessage(raw: unknown, socket: WebSocket): void {
    if (this.socket !== socket) return;
    if (typeof raw !== "string") {
      this.closeForProtocolError("Invalid response");
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      this.closeForProtocolError("Invalid response");
      return;
    }
    if (!isRecord(frame) || typeof frame.apiVersion !== "number") {
      this.closeForProtocolError("Invalid response");
      return;
    }
    if (frame.apiVersion !== WEB_API_VERSION) {
      this.closeForProtocolError("Protocol mismatch", true);
      return;
    }
    if (frame.type === "event") {
      if (
        typeof frame.topic !== "string" ||
        frame.topic.length === 0 ||
        frame.topic.length > 128 ||
        !Object.prototype.hasOwnProperty.call(frame, "payload") ||
        (frame.cursor !== undefined && typeof frame.cursor !== "string")
      ) {
        this.closeForProtocolError("Invalid event");
        return;
      }
      for (const listener of Array.from(this.eventListeners)) {
        try {
          listener(frame as unknown as WebRpcEvent);
        } catch {
          // A view listener must not prevent other subscribers receiving events.
        }
      }
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(frame, "result");
    const hasError = Object.prototype.hasOwnProperty.call(frame, "error");
    if (
      frame.type !== "response" ||
      typeof frame.id !== "string" ||
      frame.id.length === 0 ||
      frame.id.length > 128 ||
      hasResult === hasError ||
      (hasError && !isWebError(frame.error))
    ) {
      this.closeForProtocolError("Invalid response");
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(frame.id);
    if (hasError) pending.reject(new WebTransportError(frame.error as WebError));
    else pending.resolve(frame.result);
  }

  private closeForProtocolError(reason: string, versionMismatch = false): void {
    const socket = this.socket;
    if (versionMismatch) this.setState("version_mismatch");
    else this.setState("disconnected");
    socket?.close(1002, reason);
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new WebTransportError({
          code: pending.mutation ? "OUTCOME_UNKNOWN" : "HOST_UNAVAILABLE",
          message: pending.mutation
            ? "The host may have accepted this action. Reconcile before retrying."
            : "The CoWork host disconnected.",
          retryable: !pending.mutation,
        }),
      );
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.retryTimer ||
      this.state === "reauth_required" ||
      this.state === "version_mismatch"
    ) {
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5));
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        void this.connect().catch((error) => {
          this.handleConnectionFailure(error);
        });
      },
      delay * (0.8 + Math.random() * 0.4),
    );
  }

  private handleConnectionFailure(error: unknown): void {
    if (this.stopped || this.state === "reauth_required" || this.state === "version_mismatch") {
      return;
    }
    this.setState("disconnected");
    if (!(error instanceof WebTransportError) || error.retryable) this.scheduleReconnect();
  }

  private setState(state: BrowserConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of Array.from(this.stateListeners)) {
      try {
        listener(state);
      } catch {
        // UI listeners must not interrupt connection lifecycle handling.
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWebError(value: unknown): value is WebError {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    (WEB_ERROR_CODES as readonly string[]).includes(value.code) &&
    typeof value.message === "string" &&
    value.message.length <= 1_000 &&
    typeof value.retryable === "boolean"
  );
}
