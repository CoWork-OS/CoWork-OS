export interface RoutineHookStatus {
  enabled: boolean;
  serverRunning: boolean;
  serverAddress?: { host: string; port: number };
}

export interface RoutineHookSettings {
  path: string;
  host?: string;
  port?: number;
}

export async function loadRoutineHookMetadata<TStatus, TSettings>(
  hasMethods: (...methods: string[]) => boolean,
  getStatus: () => Promise<TStatus>,
  getSettings: () => Promise<TSettings>,
): Promise<{ status: TStatus | null; settings: TSettings | null }> {
  if (!hasMethods("getHooksStatus", "getHooksSettings")) {
    return { status: null, settings: null };
  }

  const [status, settings] = await Promise.all([getStatus(), getSettings()]);
  return { status, settings };
}

export function getRoutineApiBaseUrl(input: {
  isBrowserHost: boolean;
  hookMetadataAvailable: boolean;
  status: RoutineHookStatus | null;
  settings: RoutineHookSettings | null;
}): string | null {
  const { isBrowserHost, hookMetadataAvailable, status, settings } = input;
  if (isBrowserHost && (!hookMetadataAvailable || !status || !settings)) return null;
  if (isBrowserHost && !status?.serverAddress?.host && !settings?.host) return null;
  if (isBrowserHost && !status?.serverAddress?.port && !settings?.port) return null;
  if (isBrowserHost && !settings?.path) return null;

  const host = status?.serverAddress?.host || settings?.host || "127.0.0.1";
  const port = status?.serverAddress?.port || settings?.port || 9877;
  const path = settings?.path || "/hooks";
  return `http://${host}:${port}${path}`;
}
