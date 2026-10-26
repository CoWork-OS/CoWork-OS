import { z } from "zod";
import {
  MAX_SECRET_REFERENCE_LENGTH,
  SECRET_SOURCES_IPC,
  type SecretSourcesSettingsUpdate,
} from "../../../shared/secret-references";
import { getSecretReferenceResolver, type SecretReferenceResolver } from "./resolver";
import {
  secureSecretSourceSettings,
  type SecretSourceSettingsStore,
} from "./secret-source-settings";

const SettingsUpdateSchema = z
  .object({
    onepasswordServiceAccountToken: z.string().max(4096).optional(),
    onepasswordAccount: z.string().max(200).optional(),
    bitwardenSecretsManagerAccessToken: z.string().max(4096).optional(),
    bitwardenSecretsManagerServerUrl: z.string().max(500).optional(),
  })
  .strict();
const UnlockSchema = z.object({ password: z.string().min(1).max(1024) }).strict();
const TestSchema = z
  .object({ reference: z.string().min(1).max(MAX_SECRET_REFERENCE_LENGTH) })
  .strict();

/** At most `limit` calls per minute, so a compromised page can't guess a master password quickly. */
function perMinute(limit: number, now: () => number) {
  let windowStart = 0;
  let count = 0;
  return () => {
    const current = now();
    if (current - windowStart >= 60_000) {
      windowStart = current;
      count = 0;
    }
    count += 1;
    return count <= limit;
  };
}

type Handler = (event: unknown, data?: unknown) => unknown;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settings > System & Security > Password Managers. Only the app's own window may call these;
 * tokens and master passwords go in, but no token or vault value ever comes back out.
 */
export function registerSecretSourcesIpc(
  ipcMain: { handle(channel: string, handler: Handler): void },
  isOwner: (event: unknown) => boolean,
  options: {
    resolver?: SecretReferenceResolver;
    settings?: SecretSourceSettingsStore;
    now?: () => number;
  } = {},
): void {
  const resolver = options.resolver || getSecretReferenceResolver();
  const settings = options.settings || secureSecretSourceSettings;
  const now = options.now || Date.now;
  const unlockAllowed = perMinute(5, now);
  const testAllowed = perMinute(20, now);
  const guarded =
    (handler: (data: unknown) => Promise<unknown> | unknown): Handler =>
    async (event, data) => {
      if (!isOwner(event)) return { success: false, error: "denied" };
      try {
        return await handler(data);
      } catch (error) {
        return { success: false, error: message(error) };
      }
    };

  ipcMain.handle(
    SECRET_SOURCES_IPC.status,
    guarded(async () => ({ success: true, status: await resolver.status() })),
  );

  ipcMain.handle(
    SECRET_SOURCES_IPC.save,
    guarded(async (data) => {
      const parsed = SettingsUpdateSchema.safeParse(data ?? {});
      if (!parsed.success) return { success: false, error: "Invalid settings." };
      const change: SecretSourcesSettingsUpdate = parsed.data;
      settings.update(change);
      if (
        change.onepasswordServiceAccountToken !== undefined ||
        change.onepasswordAccount !== undefined
      ) {
        resolver.clear("onepassword");
      }
      if (
        change.bitwardenSecretsManagerAccessToken !== undefined ||
        change.bitwardenSecretsManagerServerUrl !== undefined
      ) {
        resolver.clear("bitwarden-secrets-manager");
      }
      return { success: true, status: await resolver.status() };
    }),
  );

  ipcMain.handle(
    SECRET_SOURCES_IPC.unlockBitwarden,
    guarded(async (data) => {
      if (!unlockAllowed()) {
        return { success: false, error: "Too many unlock attempts. Wait a minute and retry." };
      }
      const parsed = UnlockSchema.safeParse(data);
      if (!parsed.success) return { success: false, error: "Enter the master password." };
      await resolver.unlockBitwarden(parsed.data.password);
      return { success: true };
    }),
  );

  ipcMain.handle(
    SECRET_SOURCES_IPC.lockBitwarden,
    guarded(() => {
      resolver.lockBitwarden();
      return { success: true };
    }),
  );

  ipcMain.handle(
    SECRET_SOURCES_IPC.test,
    guarded(async (data) => {
      if (!testAllowed()) return { success: false, error: "Too many tests. Wait a minute." };
      const parsed = TestSchema.safeParse(data);
      if (!parsed.success) return { success: false, error: "Enter a vault reference." };
      return { success: true, result: await resolver.test(parsed.data.reference) };
    }),
  );
}
