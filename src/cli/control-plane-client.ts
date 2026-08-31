import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export interface ControlPlaneConnectionOptions {
  url: string;
  token: string;
  deviceName?: string;
  timeoutMs?: number;
}

export interface ControlPlaneFrame {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
  event?: string;
  seq?: number;
  stateVersion?: string;
}

export class ControlPlaneRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "ControlPlaneRequestError";
    this.code = code;
    this.details = details;
  }
}

export class ControlPlaneClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(frame: ControlPlaneFrame) => void>();
  private readonly timeoutMs: number;

  constructor(private readonly options: ControlPlaneConnectionOptions) {
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.on("message", (data) => {
      const frame = parseFrame(String(data));
      if (!frame || frame.type !== "event") return;
      for (const listener of this.listeners) listener(frame);
    });

    await waitForOpen(ws, this.timeoutMs);
    await this.request("connect", {
      token: this.options.token,
      deviceName: this.options.deviceName ?? "cowork-cli",
    });
  }

  onEvent(listener: (frame: ControlPlaneFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const ws = this.requireSocket();
    const id = randomUUID();

    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new ControlPlaneRequestError(`Timed out waiting for ${method}`));
      }, timeoutMs);

      const onMessage = (data: WebSocket.RawData) => {
        const frame = parseFrame(String(data));
        if (!frame || frame.type !== "res" || frame.id !== id) return;
        clearTimeout(timer);
        ws.off("message", onMessage);
        if (frame.ok) {
          resolve(frame.payload as T);
          return;
        }
        reject(
          new ControlPlaneRequestError(
            frame.error?.message || `${method} failed`,
            frame.error?.code,
            frame.error?.details,
          ),
        );
      };

      ws.on("message", onMessage);
    });

    ws.send(
      JSON.stringify({ type: "req", id, method, ...(params !== undefined ? { params } : {}) }),
    );
    return response;
  }

  close(): void {
    if (!this.ws) return;
    this.ws.close();
    this.ws = null;
  }

  private requireSocket(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ControlPlaneRequestError("Control plane is not connected");
    }
    return this.ws;
  }
}

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new ControlPlaneRequestError("Timed out connecting to the control plane"));
    }, timeoutMs);

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

function parseFrame(raw: string): ControlPlaneFrame | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.type !== "req" && parsed.type !== "res" && parsed.type !== "event") return null;
    return parsed as ControlPlaneFrame;
  } catch {
    return null;
  }
}
