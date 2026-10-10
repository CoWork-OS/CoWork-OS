import {
  HTML_SURFACE_BRIDGE_VERSION,
  HTML_SURFACE_MAX_MESSAGES_PER_SECOND,
  HtmlSurfaceFrameMessageSchema,
  clampSurfaceHeight,
  type HtmlSurfaceHostMessage,
  type HtmlSurfaceState,
} from "../../shared/answer-surfaces/html-bridge";

type FrameWindow = Pick<Window, "postMessage">;

export type HtmlSurfaceBridgeCallbacks = {
  onResize: (height: number) => void;
  onState: (state: HtmlSurfaceState) => void;
  onError?: (message: string) => void;
  /** The page asks for an action; answer with `actionResult(id, ok)`. */
  onAction?: (id: number, action: unknown) => void;
};

/** A random nonce for one mounted frame; the frame must echo it on every message. */
export function createSurfaceNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The app's side of the surface bridge for one frame. A message counts only when it
 * comes from that frame's own window (`source`), carries this mount's nonce, fits the
 * schema, and the frame is under its rate limit. Opaque-origin frames report the origin
 * "null", so the window identity is the check that matters, not the origin.
 */
export class HtmlSurfaceBridgeHost {
  private windowStart = 0;
  private windowCount = 0;

  constructor(
    private readonly getFrameWindow: () => FrameWindow | null | undefined,
    private readonly nonce: string,
    private readonly callbacks: HtmlSurfaceBridgeCallbacks,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns true when the message came from this frame and was acted on. */
  handle(event: { source: unknown; data: unknown }): boolean {
    const frame = this.getFrameWindow();
    if (!frame || event.source !== frame) return false;
    if (!this.withinRateLimit()) return false;
    const parsed = HtmlSurfaceFrameMessageSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.nonce !== this.nonce) return false;
    const message = parsed.data;
    switch (message.type) {
      case "resize":
        this.callbacks.onResize(clampSurfaceHeight(message.payload.height));
        return true;
      case "state.set":
        this.callbacks.onState(message.payload.state);
        return true;
      case "error":
        this.callbacks.onError?.(message.payload.message);
        return true;
      case "action":
        if (this.callbacks.onAction)
          this.callbacks.onAction(message.payload.id, message.payload.action);
        else this.actionResult(message.payload.id, false);
        return true;
    }
  }

  actionResult(id: number, ok: boolean): void {
    this.post({
      coworkSurface: HTML_SURFACE_BRIDGE_VERSION,
      type: "action.result",
      nonce: this.nonce,
      payload: { id, ok },
    });
  }

  init(payload: Extract<HtmlSurfaceHostMessage, { type: "init" }>["payload"]): void {
    this.post({
      coworkSurface: HTML_SURFACE_BRIDGE_VERSION,
      type: "init",
      nonce: this.nonce,
      payload,
    });
  }

  setTheme(payload: Extract<HtmlSurfaceHostMessage, { type: "theme" }>["payload"]): void {
    this.post({
      coworkSurface: HTML_SURFACE_BRIDGE_VERSION,
      type: "theme",
      nonce: this.nonce,
      payload,
    });
  }

  private post(message: HtmlSurfaceHostMessage): void {
    // An opaque origin cannot be named as a target, so "*" is the only option; the
    // message carries no secrets beyond the frame's own nonce and saved values.
    this.getFrameWindow()?.postMessage(message, "*");
  }

  private withinRateLimit(): boolean {
    const now = this.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= HTML_SURFACE_MAX_MESSAGES_PER_SECOND;
  }
}
