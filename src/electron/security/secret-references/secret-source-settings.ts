import {
  SecureSettingsRepository,
  type SettingsCategory,
} from "../../database/SecureSettingsRepository";
import type { SecretSourcesSettingsUpdate } from "../../../shared/secret-references";

const CATEGORY: SettingsCategory = "secret-sources";
const MAX_TOKEN_LENGTH = 4096;
const TOKEN = /^[\x21-\x7e]+$/;
const ACCOUNT = /^[A-Za-z0-9._@:-]{1,200}$/;

/** The tokens CoWork uses to reach a vault. Stored encrypted; never sent to the renderer. */
export interface SecretSourceSettings {
  version: 1;
  onepassword?: { serviceAccountToken?: string; account?: string };
  bitwardenSecretsManager?: { accessToken?: string; serverUrl?: string };
}

export interface SecretSourceSettingsStore {
  load(): SecretSourceSettings;
  update(change: SecretSourcesSettingsUpdate): SecretSourceSettings;
}

function cleanToken(value: string, label: string): string | undefined {
  const token = value.trim();
  if (!token) return undefined;
  if (token.length > MAX_TOKEN_LENGTH || !TOKEN.test(token)) {
    throw new Error(`${label} must be a single line of printable characters.`);
  }
  return token;
}

function cleanServerUrl(value: string): string | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The Bitwarden server URL is not a valid URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The Bitwarden server URL must use https.");
  }
  if (url.username || url.password) {
    throw new Error("The Bitwarden server URL must not contain a user name or password.");
  }
  return url.toString().replace(/\/$/, "");
}

function normalize(stored: unknown): SecretSourceSettings {
  const value = stored && typeof stored === "object" ? (stored as SecretSourceSettings) : null;
  const text = (field: unknown) => (typeof field === "string" && field ? field : undefined);
  return {
    version: 1,
    onepassword: {
      serviceAccountToken: text(value?.onepassword?.serviceAccountToken),
      account: text(value?.onepassword?.account),
    },
    bitwardenSecretsManager: {
      accessToken: text(value?.bitwardenSecretsManager?.accessToken),
      serverUrl: text(value?.bitwardenSecretsManager?.serverUrl),
    },
  };
}

/** Apply a Settings form change: a blank field clears its value, a missing one keeps it. */
export function applySecretSourceSettingsUpdate(
  current: SecretSourceSettings,
  change: SecretSourcesSettingsUpdate,
): SecretSourceSettings {
  const next = normalize(current);
  if (change.onepasswordServiceAccountToken !== undefined) {
    next.onepassword!.serviceAccountToken = cleanToken(
      change.onepasswordServiceAccountToken,
      "The 1Password service account token",
    );
  }
  if (change.onepasswordAccount !== undefined) {
    const account = change.onepasswordAccount.trim();
    if (account && !ACCOUNT.test(account)) {
      throw new Error("The 1Password account must be an account shorthand, sign-in address or ID.");
    }
    next.onepassword!.account = account || undefined;
  }
  if (change.bitwardenSecretsManagerAccessToken !== undefined) {
    next.bitwardenSecretsManager!.accessToken = cleanToken(
      change.bitwardenSecretsManagerAccessToken,
      "The Bitwarden Secrets Manager access token",
    );
  }
  if (change.bitwardenSecretsManagerServerUrl !== undefined) {
    next.bitwardenSecretsManager!.serverUrl = cleanServerUrl(
      change.bitwardenSecretsManagerServerUrl,
    );
  }
  return next;
}

/** The encrypted settings row. Before the database is open (early startup) it reads as empty. */
export const secureSecretSourceSettings: SecretSourceSettingsStore = {
  load() {
    if (!SecureSettingsRepository.isInitialized()) return normalize(undefined);
    return normalize(SecureSettingsRepository.getInstance().load<SecretSourceSettings>(CATEGORY));
  },
  update(change) {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("Settings are not available yet. Try again in a moment.");
    }
    const result = SecureSettingsRepository.getInstance().update<SecretSourceSettings>(
      CATEGORY,
      (current) => applySecretSourceSettingsUpdate(normalize(current), change),
    );
    return normalize(result.value);
  },
};
