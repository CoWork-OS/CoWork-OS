/**
 * Screen sharing (getDisplayMedia) for in-app browser pages.
 *
 * Electron has no built-in source picker, so without a handler every request
 * fails. Here a request from a registered workbench tab shows a picker in that
 * tab with the screens and windows to share; nothing is shared until the user
 * picks one. Requests from anything else, requests the admin policy blocks
 * ("display-capture") and unanswered requests are denied.
 */

import { randomUUID } from "crypto";
import type { BrowserPermissionOwner } from "./browser-permissions";
import { permissionOrigin } from "./browser-permissions";

export interface BrowserScreenShareSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** PNG data URL, small. */
  thumbnail: string;
}

export interface BrowserScreenSharePrompt extends BrowserPermissionOwner {
  requestId: string;
  origin: string;
  sources: BrowserScreenShareSource[];
  at: number;
}

export interface BrowserScreenShareDeps {
  resolveOwner: (webContentsId: number) => BrowserPermissionOwner | null;
  /** The webContents a request's frame belongs to (Electron's webContents.fromFrame). */
  contentsForFrame: (frame: Any) => Any | null;
  /** desktopCapturer.getSources for screens and windows. */
  listSources: () => Promise<Array<{ id: string; name: string; thumbnail?: Any }>>;
  sendPrompt: (prompt: BrowserScreenSharePrompt) => boolean;
  /** Admin policy: true denies screen sharing outright. */
  isBlocked: () => boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const MAX_SOURCES = 24;

interface Pending {
  prompt: BrowserScreenSharePrompt;
  sources: Map<string, Any>;
  callback: (streams: Any) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserScreenShare {
  private readonly attached = new WeakSet<object>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: BrowserScreenShareDeps) {}

  attach(electronSession: Any): void {
    if (!electronSession || this.attached.has(electronSession)) return;
    if (typeof electronSession.setDisplayMediaRequestHandler !== "function") return;
    this.attached.add(electronSession);
    electronSession.setDisplayMediaRequestHandler((request: Any, callback: (s: Any) => void) => {
      void this.handleRequest(request, callback).catch(() => callback({}));
    });
  }

  async handleRequest(request: Any, callback: (streams: Any) => void): Promise<void> {
    if (this.deps.isBlocked()) return callback({});
    const contents = request?.frame ? this.deps.contentsForFrame(request.frame) : null;
    const webContentsId = typeof contents?.id === "number" ? contents.id : -1;
    const owner = webContentsId >= 0 ? this.deps.resolveOwner(webContentsId) : null;
    const origin = permissionOrigin(request?.securityOrigin || contents?.getURL?.());
    if (!owner || !origin) return callback({});

    const listed = await this.deps.listSources();
    const sources = new Map<string, Any>();
    const offered: BrowserScreenShareSource[] = [];
    for (const source of listed.slice(0, MAX_SOURCES)) {
      if (!source?.id) continue;
      sources.set(source.id, source);
      offered.push({
        id: source.id,
        name: String(source.name || "").slice(0, 200),
        kind: source.id.startsWith("screen:") ? "screen" : "window",
        thumbnail:
          typeof source.thumbnail?.toDataURL === "function" ? source.thumbnail.toDataURL() : "",
      });
    }
    if (offered.length === 0) return callback({});

    const prompt: BrowserScreenSharePrompt = {
      ...owner,
      requestId: randomUUID(),
      origin,
      sources: offered,
      at: Date.now(),
    };
    const timer = setTimeout(
      () => this.respond(prompt.requestId, null),
      this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    this.pending.set(prompt.requestId, { prompt, sources, callback, timer });
    if (!this.deps.sendPrompt(prompt)) this.respond(prompt.requestId, null);
  }

  /** The user's choice; null cancels. Only a source that was offered can be shared. */
  respond(requestId: string, sourceId: string | null): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    const source = sourceId ? entry.sources.get(sourceId) : undefined;
    entry.callback(source && !this.deps.isBlocked() ? { video: source } : {});
    return true;
  }

  listPending(taskId: string, sessionId: string): BrowserScreenSharePrompt[] {
    return Array.from(this.pending.values())
      .map((entry) => entry.prompt)
      .filter((prompt) => prompt.taskId === taskId && prompt.sessionId === sessionId);
  }
}
