/**
 * ShortcutGuard — blocks dangerous system shortcuts during CUA sessions.
 *
 * Registers Electron globalShortcut intercepts for key combos that could
 * disrupt a computer use session. The guard is enabled when the CUA session
 * starts and disabled when it ends.
 *
 * Limitation: Electron's globalShortcut cannot intercept all macOS system
 * shortcuts (e.g. Cmd+Tab, Cmd+Space are handled by the OS before Electron
 * sees them). For those, the ComputerUseTools blocklist in computer_key
 * provides a secondary safety net.
 */

import { globalShortcut } from "electron";

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

  get isActive(): boolean {
    return this._active;
  }

  /**
   * Start intercepting dangerous shortcuts.
   * Intercepted shortcuts are silently swallowed (no-op handler).
   */
  enable(): void {
    if (this._active) return;
    this._active = true;

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
  }

  /**
   * Stop intercepting shortcuts and restore normal behavior.
   */
  disable(): void {
    if (!this._active) return;
    this._active = false;

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
