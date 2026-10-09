import {
  LOGIC_PROTOCOL_VERSION,
  LogicRunnerMessageSchema,
  type LogicRunnerMessage,
} from "../../shared/answer-surfaces/logic";
import { createSurfaceNonce } from "./html-surface-bridge";

type FrameWindow = Pick<Window, "postMessage">;
type Listener = (message: Extract<LogicRunnerMessage, { type: "result" | "error" }>) => void;

const READY_TIMEOUT_MS = 5000;

/**
 * The app's side of the surface-logic runner (see shared/answer-surfaces/logic.ts). A
 * message counts only when it comes from the runner frame's own window, carries this
 * runner's nonce and fits the schema; results are validated again by the caller against
 * the outputs the surface declared.
 */
export class SurfaceLogicChannel {
  private readonly listeners = new Map<string, Listener>();
  private ready = false;
  private readyWaiters: Array<(ok: boolean) => void> = [];

  constructor(
    private readonly getFrameWindow: () => FrameWindow | null | undefined,
    private readonly nonce: string,
  ) {}

  hello(): void {
    this.post({ type: "hello" });
  }

  handle(event: { source: unknown; data: unknown }): boolean {
    const frame = this.getFrameWindow();
    if (!frame || event.source !== frame) return false;
    const parsed = LogicRunnerMessageSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.nonce !== this.nonce) return false;
    const message = parsed.data;
    if (message.type === "ready") {
      this.ready = true;
      for (const resolve of this.readyWaiters.splice(0)) resolve(true);
      return true;
    }
    this.listeners.get(message.id)?.(message);
    return true;
  }

  whenReady(timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.readyWaiters.push(resolve);
      setTimeout(() => resolve(this.ready), timeoutMs);
    });
  }

  load(id: string, code: string, listener: Listener): void {
    this.listeners.set(id, listener);
    this.post({ type: "load", id, code });
  }

  run(id: string, seq: number, state: Record<string, unknown>): void {
    this.post({ type: "run", id, seq, state });
  }

  dispose(id: string): void {
    this.listeners.delete(id);
    this.post({ type: "dispose", id });
  }

  private post(message: Record<string, unknown>): void {
    // The runner has an opaque origin, so "*" is the only possible target. Messages carry
    // only the surface's code and control values, which the runner may see anyway.
    this.getFrameWindow()?.postMessage(
      { coworkLogic: LOGIC_PROTOCOL_VERSION, nonce: this.nonce, ...message },
      "*",
    );
  }
}

let channelPromise: Promise<SurfaceLogicChannel | null> | null = null;

/**
 * The single runner frame for this window, created on first use. Null where the desktop
 * runner is unavailable (the browser host), so surfaces show their no-logic state.
 */
export function getSurfaceLogicChannel(): Promise<SurfaceLogicChannel | null> {
  if (channelPromise) return channelPromise;
  channelPromise = (async () => {
    const getUrl =
      typeof window === "undefined" ? undefined : window.electronAPI?.getAnswerSurfaceLogicRunner;
    if (!getUrl) return null;
    let url: string;
    try {
      url = (await getUrl()).url;
    } catch {
      return null;
    }
    const frame = document.createElement("iframe");
    // No allow-same-origin: the runner stays on an opaque origin with no app access.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.title = "Answer calculations";
    frame.className = "answer-surface-logic-runner";
    frame.referrerPolicy = "no-referrer";
    const channel = new SurfaceLogicChannel(() => frame.contentWindow, createSurfaceNonce());
    window.addEventListener("message", (event) => channel.handle(event));
    frame.addEventListener("load", () => channel.hello());
    frame.src = url;
    document.body.appendChild(frame);
    if (!(await channel.whenReady())) {
      frame.remove();
      channelPromise = null;
      return null;
    }
    return channel;
  })();
  return channelPromise;
}
