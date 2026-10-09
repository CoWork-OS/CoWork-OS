/**
 * Site permissions for the in-app browser partitions.
 *
 * Electron grants every permission request when a session has no handler, so
 * without this a page in the workbench could read the camera, microphone or
 * location silently. Each request is classified: a few harmless ones are
 * allowed, the device and privacy ones are put to the user as a prompt in the
 * owning tab, and the rest are denied. Decisions the user makes with "Always"
 * persist per (browser partition, origin, permission); "Allow once" lasts for
 * the life of the tab's page process.
 */

import { randomUUID } from "crypto";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

export type BrowserPermissionClass = "allow" | "prompt" | "deny";
/** "dismiss" denies this request without remembering anything. */
export type BrowserPermissionResponse = "allow-once" | "allow-always" | "block" | "dismiss";
export type BrowserStoredPermission = "allow" | "block";

export interface BrowserPermissionOwner {
  taskId: string;
  sessionId: string;
  tabId: string;
}

export interface BrowserPermissionPrompt extends BrowserPermissionOwner {
  requestId: string;
  origin: string;
  /** Permission keys asked for together, e.g. ["camera", "microphone"]. */
  permissions: string[];
  /** External URL for an openExternal request (scheme links such as mailto:). */
  externalUrl?: string;
  at: number;
}

interface StoredPermissions {
  version: 1;
  /** partition -> origin -> permission key -> decision */
  partitions: Record<string, Record<string, Record<string, BrowserStoredPermission>>>;
}

export interface BrowserPermissionStore {
  load(): StoredPermissions | undefined;
  save(value: StoredPermissions): void;
}

export interface BrowserPermissionManagerOptions {
  /** Map a guest webContents id to the workbench tab that owns it. */
  resolveOwner: (webContentsId: number) => BrowserPermissionOwner | null;
  /** Show the prompt in the owning tab. Returns false when no window can show it. */
  sendPrompt: (prompt: BrowserPermissionPrompt) => boolean;
  store?: BrowserPermissionStore;
  /** Admin override: true denies the permission key regardless of user decisions. */
  isForcedDeny?: (permission: string) => boolean;
  promptTimeoutMs?: number;
}

const SETTINGS_CATEGORY = "browser-site-permissions" as const;
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60_000;

/** Harmless requests a normal browser grants without asking. */
const ALLOWED_PERMISSIONS = new Set([
  "fullscreen",
  "clipboard-sanitized-write",
  // Encrypted media (DRM) playback; Chrome grants it by default.
  "mediaKeySystem",
]);

/** Device and privacy permissions the user decides per site. */
const PROMPTED_PERMISSIONS = new Set([
  "media",
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "clipboard-read",
  "midi",
  "midiSysex",
  "hid",
  "serial",
  "usb",
  "pointerLock",
  "keyboardLock",
  "openExternal",
  "fileSystem",
]);

// Everything else is denied: idle-detection, background-sync, window-management,
// storage-access, top-level-storage-access, speaker-selection, display-capture
// (no source picker exists yet) and "unknown".

export function classifyBrowserPermission(permission: string): BrowserPermissionClass {
  if (ALLOWED_PERMISSIONS.has(permission)) return "allow";
  if (PROMPTED_PERMISSIONS.has(permission)) return "prompt";
  return "deny";
}

/** Split Electron's "media" permission into the camera/microphone keys users recognize. */
export function permissionKeysFor(permission: string, details?: Record<string, unknown>): string[] {
  if (permission !== "media") return [permission];
  const keys = new Set<string>();
  const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
  for (const mediaType of mediaTypes) {
    if (mediaType === "video") keys.add("camera");
    if (mediaType === "audio") keys.add("microphone");
  }
  const single = typeof details?.mediaType === "string" ? details.mediaType : "";
  if (single === "video") keys.add("camera");
  if (single === "audio") keys.add("microphone");
  return keys.size > 0 ? Array.from(keys) : ["camera", "microphone"];
}

/** Only http(s) pages can hold site permissions; opaque and file origins are denied. */
export function permissionOrigin(rawUrl: unknown): string | null {
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function secureSettingsStore(): BrowserPermissionStore {
  return {
    load: () =>
      SecureSettingsRepository.isInitialized()
        ? SecureSettingsRepository.getInstance().load<StoredPermissions>(SETTINGS_CATEGORY)
        : undefined,
    save: (value) => {
      if (!SecureSettingsRepository.isInitialized()) return;
      SecureSettingsRepository.getInstance().save(SETTINGS_CATEGORY, value);
    },
  };
}

interface PendingPrompt {
  prompt: BrowserPermissionPrompt;
  partition: string;
  webContentsId: number;
  resolve: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserPermissionManager {
  private stored: StoredPermissions | null = null;
  private readonly store: BrowserPermissionStore;
  private readonly attachedSessions = new WeakSet<object>();
  /** webContentsId -> "origin|permission" granted with "Allow once". */
  private readonly onceGrants = new Map<number, Set<string>>();
  private readonly pending = new Map<string, PendingPrompt>();

  constructor(private readonly options: BrowserPermissionManagerOptions) {
    this.store = options.store || secureSettingsStore();
  }

  /** Install the permission handlers on a browser partition's session once. */
  attach(electronSession: Any, partition: string): void {
    if (!electronSession || this.attachedSessions.has(electronSession)) return;
    this.attachedSessions.add(electronSession);

    electronSession.setPermissionRequestHandler?.(
      (contents: Any, permission: string, callback: (granted: boolean) => void, details: Any) => {
        void this.handleRequest(partition, contents, permission, details || {}).then(callback, () =>
          callback(false),
        );
      },
    );
    electronSession.setPermissionCheckHandler?.(
      (contents: Any, permission: string, requestingOrigin: string, details: Any) =>
        this.handleCheck(partition, contents, permission, requestingOrigin, details || {}),
    );
    electronSession.setDevicePermissionHandler?.((details: Any) => {
      const origin = permissionOrigin(details?.origin);
      const deviceType = String(details?.deviceType || "");
      if (!origin || !deviceType) return false;
      return this.isStoredAllow(partition, origin, deviceType);
    });
  }

  /** Synchronous permission state queries (navigator.permissions, Notification.permission). */
  handleCheck(
    partition: string,
    contents: Any,
    permission: string,
    requestingOrigin: string,
    details: Record<string, unknown>,
  ): boolean {
    const classification = classifyBrowserPermission(permission);
    if (classification === "allow") return true;
    if (classification === "deny") return false;
    const origin = permissionOrigin(requestingOrigin || details.requestingUrl);
    if (!origin) return false;
    const keys = permissionKeysFor(permission, details);
    const webContentsId = typeof contents?.id === "number" ? contents.id : -1;
    return keys.every(
      (key) =>
        !this.options.isForcedDeny?.(key) &&
        (this.isStoredAllow(partition, origin, key) ||
          this.hasOnceGrant(webContentsId, origin, key)),
    );
  }

  async handleRequest(
    partition: string,
    contents: Any,
    permission: string,
    details: Record<string, unknown>,
  ): Promise<boolean> {
    const classification = classifyBrowserPermission(permission);
    if (classification === "allow") return true;
    if (classification === "deny") return false;

    const origin = permissionOrigin(details.requestingUrl || contents?.getURL?.());
    const webContentsId = typeof contents?.id === "number" ? contents.id : -1;
    if (!origin || webContentsId < 0) return false;

    const keys = permissionKeysFor(permission, details);
    if (keys.some((key) => this.options.isForcedDeny?.(key))) return false;
    if (keys.some((key) => this.getStored(partition, origin, key) === "block")) return false;
    if (
      keys.every(
        (key) =>
          this.isStoredAllow(partition, origin, key) ||
          this.hasOnceGrant(webContentsId, origin, key),
      )
    ) {
      return true;
    }

    // Only a page in a registered workbench tab can ask; anything else fails closed.
    const owner = this.options.resolveOwner(webContentsId);
    if (!owner) return false;

    const prompt: BrowserPermissionPrompt = {
      ...owner,
      requestId: randomUUID(),
      origin,
      permissions: keys,
      externalUrl:
        permission === "openExternal" && typeof details.externalURL === "string"
          ? details.externalURL.slice(0, 500)
          : undefined,
      at: Date.now(),
    };
    this.watchContents(contents);
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => this.settle(prompt.requestId, false),
        this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      );
      timer.unref?.();
      this.pending.set(prompt.requestId, { prompt, partition, webContentsId, resolve, timer });
      if (!this.options.sendPrompt(prompt)) this.settle(prompt.requestId, false);
    });
  }

  /** Apply the user's answer to a prompt. Returns false for an unknown or settled request. */
  respond(requestId: string, response: BrowserPermissionResponse): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    const { prompt, partition, webContentsId } = entry;
    // Opening an external app is decided per link: no answer for one link may
    // let the site launch other URL schemes later without asking.
    const perRequest = prompt.permissions.includes("openExternal");
    if (!perRequest && (response === "allow-always" || response === "block")) {
      for (const key of prompt.permissions) {
        this.setStored(partition, prompt.origin, key, response === "block" ? "block" : "allow");
      }
    } else if (!perRequest && response === "allow-once") {
      const grants = this.onceGrants.get(webContentsId) || new Set<string>();
      for (const key of prompt.permissions) grants.add(`${prompt.origin}|${key}`);
      this.onceGrants.set(webContentsId, grants);
    }
    this.settle(requestId, response === "allow-once" || response === "allow-always");
    return true;
  }

  /** Pending prompts for a tab, so a remounted workbench can show them again. */
  listPending(owner: { taskId: string; sessionId: string }): BrowserPermissionPrompt[] {
    return Array.from(this.pending.values())
      .map((entry) => entry.prompt)
      .filter((prompt) => prompt.taskId === owner.taskId && prompt.sessionId === owner.sessionId);
  }

  /** Remembered decisions for one browser profile (Settings > Browser). */
  listStored(
    partition: string,
  ): Array<{ origin: string; permission: string; decision: BrowserStoredPermission }> {
    const entries: Array<{
      origin: string;
      permission: string;
      decision: BrowserStoredPermission;
    }> = [];
    for (const [origin, permissions] of Object.entries(this.load().partitions[partition] || {})) {
      for (const [permission, decision] of Object.entries(permissions)) {
        entries.push({ origin, permission, decision });
      }
    }
    return entries.sort((a, b) => a.origin.localeCompare(b.origin));
  }

  /** Forget remembered decisions: one permission, one site, or the whole profile. */
  resetStored(partition: string, origin?: string, permission?: string): void {
    const stored = this.load();
    const partitionEntry = stored.partitions[partition];
    if (!partitionEntry) return;
    if (!origin) delete stored.partitions[partition];
    else if (!permission) delete partitionEntry[origin];
    else if (partitionEntry[origin]) {
      delete partitionEntry[origin][permission];
      if (Object.keys(partitionEntry[origin]).length === 0) delete partitionEntry[origin];
    }
    try {
      this.store.save(stored);
    } catch (error) {
      console.warn("[BrowserPermissions] Failed to persist site permission reset:", error);
    }
  }

  getStored(partition: string, origin: string, permission: string): BrowserStoredPermission | null {
    return this.load().partitions[partition]?.[origin]?.[permission] || null;
  }

  private isStoredAllow(partition: string, origin: string, permission: string): boolean {
    if (this.options.isForcedDeny?.(permission)) return false;
    return this.getStored(partition, origin, permission) === "allow";
  }

  private hasOnceGrant(webContentsId: number, origin: string, permission: string): boolean {
    return this.onceGrants.get(webContentsId)?.has(`${origin}|${permission}`) === true;
  }

  private setStored(
    partition: string,
    origin: string,
    permission: string,
    decision: BrowserStoredPermission,
  ): void {
    const stored = this.load();
    const partitionEntry = (stored.partitions[partition] ||= {});
    const originEntry = (partitionEntry[origin] ||= {});
    originEntry[permission] = decision;
    try {
      this.store.save(stored);
    } catch (error) {
      console.warn("[BrowserPermissions] Failed to persist site permission:", error);
    }
  }

  private load(): StoredPermissions {
    if (this.stored) return this.stored;
    let loaded: StoredPermissions | undefined;
    try {
      loaded = this.store.load();
    } catch {
      loaded = undefined;
    }
    this.stored =
      loaded && loaded.version === 1 && loaded.partitions && typeof loaded.partitions === "object"
        ? loaded
        : { version: 1, partitions: {} };
    return this.stored;
  }

  private settle(requestId: string, granted: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(granted);
  }

  private watchContents(contents: Any): void {
    const webContentsId = contents?.id;
    if (typeof webContentsId !== "number" || this.onceGrants.has(webContentsId)) return;
    this.onceGrants.set(webContentsId, new Set());
    contents.once?.("destroyed", () => {
      this.onceGrants.delete(webContentsId);
      for (const [requestId, entry] of this.pending) {
        if (entry.webContentsId === webContentsId) this.settle(requestId, false);
      }
    });
  }
}
