/**
 * "Leave site?" for in-app browser pages that ask before unloading (a
 * `beforeunload` handler, usually unsaved form input).
 *
 * Electron cancels such an unload silently; this asks the user instead, for
 * reloads, navigations, popup windows closing and tabs closing. Closing a tab
 * first navigates the page away so its `beforeunload` runs: calling
 * `webContents.close()` on a webview guest destroys it whatever the page says.
 *
 * While CoWork is acting on the tab the unload goes ahead without a dialog, so
 * the agent is never stuck behind one.
 */

import type { BrowserSessionManager } from "./browser-session-manager";
import type { BrowserWorkbenchService } from "./browser-workbench-service";

export interface BrowserUnloadGuardDeps {
  manager: Pick<BrowserSessionManager, "findTabOwner">;
  service: Pick<BrowserWorkbenchService, "isDriving">;
  /**
   * Ask the user whether to leave; true leaves the page. Synchronous because
   * the page's unload waits on the event handler's decision.
   */
  confirmLeave: (guest: Any, context: { closingTab: boolean }) => boolean;
}

/** A page that never answers can't keep its tab open. */
const CLOSE_CHECK_TIMEOUT_MS = 10_000;
/** How long a "Stay" from the CDP dialog covers the will-prevent-unload that follows it. */
const STAY_ANSWER_TTL_MS = 2_000;

export class BrowserUnloadGuard {
  private readonly closing = new Set<number>();
  private readonly stayed = new Set<number>();
  /** "Stay" answered through CDP: Electron then reports the cancelled unload too. */
  private readonly stayedViaDialog = new Map<number, number>();

  constructor(private readonly deps: BrowserUnloadGuardDeps) {}

  attach(guest: Any): void {
    if (!guest || typeof guest.on !== "function") return;
    guest.on("will-prevent-unload", (event: Any) => {
      const answeredAt = this.stayedViaDialog.get(guest.id);
      this.stayedViaDialog.delete(guest.id);
      // The user already chose to stay in the CDP dialog for this unload.
      if (answeredAt !== undefined && Date.now() - answeredAt < STAY_ANSWER_TTL_MS) return;
      if (this.decide(guest)) event.preventDefault();
    });
  }

  /** The CDP "beforeunload" dialog, shown instead of will-prevent-unload once CoWork's debugger is attached. */
  decideDialog(guest: Any): boolean {
    const leave = this.decide(guest);
    if (!leave) this.stayedViaDialog.set(guest.id, Date.now());
    return leave;
  }

  /** Whether a page that asked to keep its changes may unload: true leaves. */
  private decide(guest: Any): boolean {
    const id = guest.id as number;
    const owner = this.deps.manager.findTabOwner(id);
    if (!owner || this.deps.service.isDriving(owner.taskId, owner.sessionId)) return true;
    const closingTab = this.closing.has(id);
    const leave = this.deps.confirmLeave(guest, { closingTab });
    if (!leave && closingTab) this.stayed.add(id);
    return leave;
  }

  /**
   * Run the page's unload check before its tab closes. Resolves true when the
   * tab may close (no handler, the user chose to leave, or the page is gone)
   * and false when the user chose to stay.
   */
  async confirmClose(guest: Any): Promise<boolean> {
    if (!guest || guest.isDestroyed?.()) return true;
    const id = guest.id as number;
    // A check is already showing for this tab; the first one decides.
    if (this.closing.has(id)) return false;
    this.closing.add(id);
    this.stayed.delete(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // Rejects with ERR_ABORTED when the user stays; either way the outcome is in `stayed`.
        Promise.resolve(guest.loadURL("about:blank")).catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, CLOSE_CHECK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.closing.delete(id);
    }
    return !this.stayed.delete(id);
  }
}
