/**
 * ShortcutGuard — blocks dangerous system shortcuts during CUA sessions.
 *
 * Registers Electron globalShortcut intercepts for key combos that could
 * disrupt a computer use session. The guard is enabled when the CUA session
 * starts and disabled when the session ends.
 *
 * Limitation: Electron's globalShortcut cannot intercept all macOS system
 * shortcuts (e.g. Cmd+Tab, Cmd+Space are handled by the OS before Electron
 * sees them). For those, the ComputerUseTools blocklist in keypress
 * provides a secondary safety net.
 */

import type { GlobalShortcut } from "electron";

function getGlobalShortcut(): GlobalShortcut | null {
  try {
    const electron = require("electron") as { globalShortcut?: GlobalShortcut };
    return electron.globalShortcut ?? null;
  } catch {
    return null;
  }
}

/**
 * Accelerators that Electron *can* register on macOS.
 * Cmd+Tab and Cmd+Space are OS-level and cannot be intercepted.
 */
const INTERCEPTABLE_SHORTCUTS = [
  "CommandOrControl+Q", // Quit foreground app
  "CommandOrControl+H", // Hide foreground app
  "CommandOrControl+M", // Minimize
  "CommandOrControl+W", // Close window
  "CommandOrControl+Option+Escape", // Force Quit dialog
];

export class ShortcutGuard {
  private registeredAccelerators: string[] = [];
  private _active = false;
  private escapeRegistered = false;
  private onEscapePress: (() => void) | null = null;

  get isActive(): boolean {
    return this._active;
  }

  /**
   * Start intercepting dangerous shortcuts.
   * Intercepted shortcuts are silently swallowed (no-op handler).
   * @param onEscape - Called when Escape is pressed (abort computer use).
   */
  enable(onEscape?: () => void): void {
    if (this._active) return;
    this._active = true;
    this.onEscapePress = onEscape ?? null;
    const globalShortcut = getGlobalShortcut();
    if (!globalShortcut) return;

    for (const accelerator of INTERCEPTABLE_SHORTCUTS) {
      try {
        const registered = globalShortcut.register(accelerator, () => {
          // Intentionally swallowed — prevents accidental app actions during CUA
        });
        if (registered) {
          this.registeredAccelerators.push(accelerator);
        }
      } catch {
        // Some accelerators may not be registerable on certain OS versions — skip
      }
    }

    if (this.onEscapePress) {
      try {
        const ok = globalShortcut.register("Escape", () => {
          this.onEscapePress?.();
        });
        if (ok) {
          this.escapeRegistered = true;
          this.registeredAccelerators.push("Escape");
        }
      } catch {
        // Escape may fail to register if another app reserved it
      }
    }
  }

  /**
   * Stop intercepting shortcuts and restore normal behavior.
   */
  disable(): void {
    if (!this._active) return;
    this._active = false;
    this.onEscapePress = null;
    this.escapeRegistered = false;
    const globalShortcut = getGlobalShortcut();
    if (!globalShortcut) {
      this.registeredAccelerators = [];
      return;
    }

    for (const accelerator of this.registeredAccelerators) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        // Best-effort cleanup
      }
    }
    this.registeredAccelerators = [];
  }
}
