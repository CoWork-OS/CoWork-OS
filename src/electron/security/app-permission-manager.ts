/**
 * App-level permission manager for Computer Use Agent (CUA) sessions.
 *
 * Before the CUA interacts with a desktop application, it must request
 * per-app permission from the user. Permissions are session-scoped —
 * they are revoked when the CUA session ends.
 *
 * Access levels:
 *  - full_control: mouse clicks, keyboard input, screenshots
 *  - click_only:   screenshots, mouse movement, clicks/drag/scroll — no typing or key combos
 *  - view_only:    screenshots and mouse movement only (no clicks or typing)
 *  - denied:       no interaction allowed
 */

import { EventEmitter } from "events";

export type AppAccessLevel = "full_control" | "click_only" | "view_only" | "denied";

export interface AppPermission {
  appName: string;
  bundleId?: string;
  accessLevel: AppAccessLevel;
  grantedAt: number;
  sessionId: string;
}

export interface AppPermissionRequest {
  appName: string;
  bundleId?: string;
  requestedLevel: AppAccessLevel;
  reason: string;
}

/**
 * Tools that are allowed under each access level.
 * "view_only" apps may only be screenshotted and hovered — no input actions.
 */
const VIEW_ONLY_ALLOWED_TOOLS = new Set(["computer_screenshot", "computer_move_mouse"]);

const CLICK_ONLY_ALLOWED_TOOLS = new Set([
  "computer_screenshot",
  "computer_move_mouse",
  "computer_click",
]);

const FULL_CONTROL_TOOLS = new Set([
  "computer_screenshot",
  "computer_move_mouse",
  "computer_click",
  "computer_type",
  "computer_key",
]);

function levelRank(level: AppAccessLevel): number {
  switch (level) {
    case "denied":
      return 0;
    case "view_only":
      return 1;
    case "click_only":
      return 2;
    case "full_control":
      return 3;
    default:
      return 0;
  }
}

/** True if `granted` satisfies at least `needed` privilege. */
export function accessLevelSatisfies(granted: AppAccessLevel, needed: AppAccessLevel): boolean {
  if (needed === "denied") return true;
  if (granted === "denied") return false;
  return levelRank(granted) >= levelRank(needed);
}

export class AppPermissionManager extends EventEmitter {
  private permissions = new Map<string, AppPermission>();
  private sessionId: string;

  /**
   * Callback that is set by the IPC layer to show the permission dialog
   * in the renderer and await the user's response.
   */
  public onPermissionRequest: ((request: AppPermissionRequest) => Promise<AppAccessLevel>) | null =
    null;

  constructor(sessionId?: string) {
    super();
    this.sessionId = sessionId ?? `cua-${Date.now()}`;
  }

  /** Get or generate the current session ID. */
  getSessionId(): string {
    return this.sessionId;
  }

  private permissionKey(appName: string, bundleId?: string): string {
    const normalizedBundleId = bundleId?.trim().toLowerCase();
    if (normalizedBundleId) return normalizedBundleId;
    return appName.trim().toLowerCase();
  }

  /**
   * Check whether a specific tool is allowed for the given app.
   */
  isToolAllowed(appName: string, toolName: string, bundleId?: string): boolean {
    const key = this.permissionKey(appName, bundleId);
    const perm = this.permissions.get(key);

    if (!perm || perm.accessLevel === "denied") {
      return false;
    }

    if (perm.accessLevel === "view_only") {
      return VIEW_ONLY_ALLOWED_TOOLS.has(toolName);
    }

    if (perm.accessLevel === "click_only") {
      return CLICK_ONLY_ALLOWED_TOOLS.has(toolName);
    }

    // full_control
    return FULL_CONTROL_TOOLS.has(toolName);
  }

  /**
   * Request permission for the CUA to interact with an app.
   * If a callback (`onPermissionRequest`) is registered, the user
   * will be prompted via the UI. Otherwise, defaults to denied.
   */
  async requestPermission(
    appName: string,
    bundleId: string | undefined,
    requestedLevel: AppAccessLevel,
    reason: string,
  ): Promise<AppAccessLevel> {
    const key = this.permissionKey(appName, bundleId);

    const existing = this.permissions.get(key);
    if (existing && existing.accessLevel !== "denied") {
      if (accessLevelSatisfies(existing.accessLevel, requestedLevel)) {
        return existing.accessLevel;
      }
      // Need upgrade (e.g. view_only -> full_control)
    }

    let granted: AppAccessLevel = "denied";
    if (this.onPermissionRequest) {
      granted = await this.onPermissionRequest({
        appName,
        bundleId,
        requestedLevel,
        reason,
      });
    }

    const permission: AppPermission = {
      appName,
      bundleId,
      accessLevel: granted,
      grantedAt: Date.now(),
      sessionId: this.sessionId,
    };

    this.permissions.set(key, permission);
    this.emit("permission-changed", permission);
    return granted;
  }

  /**
   * Check current permission for an app without prompting.
   */
  getPermission(appName: string, bundleId?: string): AppPermission | undefined {
    return this.permissions.get(this.permissionKey(appName, bundleId));
  }

  /**
   * Get all active permissions.
   */
  getActivePermissions(): AppPermission[] {
    return Array.from(this.permissions.values()).filter((p) => p.accessLevel !== "denied");
  }

  /**
   * Revoke permission for a specific app.
   */
  revoke(appName: string, bundleId?: string): void {
    const key = this.permissionKey(appName, bundleId);
    const perm = this.permissions.get(key);
    if (perm) {
      perm.accessLevel = "denied";
      this.emit("permission-changed", perm);
      this.permissions.delete(key);
    }
  }

  /**
   * Revoke all permissions — called when a CUA session ends.
   */
  revokeAll(): void {
    for (const [, perm] of this.permissions) {
      perm.accessLevel = "denied";
      this.emit("permission-changed", perm);
    }
    this.permissions.clear();
    this.emit("session-ended", this.sessionId);
  }

  /**
   * Start a new CUA session, revoking any previous permissions.
   */
  startSession(sessionId?: string): string {
    this.revokeAll();
    this.sessionId = sessionId ?? `cua-${Date.now()}`;
    this.emit("session-started", this.sessionId);
    return this.sessionId;
  }
}
