/**
 * Cua Space backend for Computer Use: the renderer-facing shapes. The bearer token
 * stays in the main process; the renderer only learns whether one is stored.
 */

export interface CuaSpaceDisplaySettings {
  /** When true, Computer Use tools drive the Space instead of this computer. */
  enabled: boolean;
  /** cua-spacesd base URL, e.g. http://127.0.0.1:3211 */
  url: string;
  tokenConfigured: boolean;
}

/** `token` omitted keeps the stored token; `null` clears it. */
export interface CuaSpaceSettingsUpdate {
  enabled?: boolean;
  url?: string;
  token?: string | null;
}

export interface CuaSpaceConnectionResult {
  reachable: boolean;
  error?: string;
}
