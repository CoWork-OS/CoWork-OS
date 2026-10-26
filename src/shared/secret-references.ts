/**
 * Vault references: a provider key or connector secret field may hold a pointer to an item in
 * a password manager instead of the key itself. The main process reads the value when it is
 * needed; settings only ever store the pointer.
 *
 * - `op://<vault>/<item>/[<section>/]<field>` is a 1Password secret reference, read with `op read`.
 * - `bws://<secret-id>` is a Bitwarden Secrets Manager secret, read with `bws secret get`.
 * - `bw://<item>/<field>` is a field of a Bitwarden password manager item (`<item>` is its id or
 *   exact name; `<field>` is password, username, notes, totp or a custom field name), read with
 *   `bw` through an unlocked session.
 */

export type SecretReferenceSource = "onepassword" | "bitwarden-secrets-manager" | "bitwarden";

export type SecretReference =
  | { source: "onepassword"; raw: string }
  | { source: "bitwarden-secrets-manager"; raw: string; secretId: string }
  | { source: "bitwarden"; raw: string; item: string; field: string };

export type SecretReferenceParse =
  | { ok: true; reference: SecretReference }
  | { ok: false; source: SecretReferenceSource; error: string };

export const SECRET_REFERENCE_SOURCE_LABELS: Record<SecretReferenceSource, string> = {
  onepassword: "1Password",
  "bitwarden-secrets-manager": "Bitwarden Secrets Manager",
  bitwarden: "Bitwarden",
};

/** Settings fields that may hold a reference are limited to this length. */
export const MAX_SECRET_REFERENCE_LENGTH = 500;

const PREFIXES: ReadonlyArray<[string, SecretReferenceSource]> = [
  ["op://", "onepassword"],
  ["bws://", "bitwarden-secrets-manager"],
  ["bw://", "bitwarden"],
];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BITWARDEN_BUILTIN_FIELDS = new Set(["password", "username", "notes", "totp"]);

function sourceOf(value: string): SecretReferenceSource | null {
  const lower = value.slice(0, 6).toLowerCase();
  for (const [prefix, source] of PREFIXES) if (lower.startsWith(prefix)) return source;
  return null;
}

/** True when the value is written as a vault reference, valid or not. */
export function looksLikeSecretReference(value: unknown): value is string {
  return typeof value === "string" && sourceOf(value.trim()) !== null;
}

/**
 * Parse a settings value. Returns null for a value that is not written as a reference (a plain
 * key), so callers use it unchanged; a value with a reference prefix but a bad shape is an error
 * rather than a key, so it is never sent to a provider.
 */
export function parseSecretReference(value: unknown): SecretReferenceParse | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const source = sourceOf(raw);
  if (!source) return null;
  const fail = (error: string): SecretReferenceParse => ({ ok: false, source, error });
  if (raw.length > MAX_SECRET_REFERENCE_LENGTH) {
    return fail(`The reference is longer than ${MAX_SECRET_REFERENCE_LENGTH} characters.`);
  }
  if (CONTROL_CHARACTERS.test(raw)) return fail("The reference contains control characters.");

  if (source === "onepassword") {
    const [path] = raw.slice("op://".length).split("?", 1);
    const segments = path.split("/");
    if (segments.length < 3 || segments.length > 4 || segments.some((segment) => !segment.trim())) {
      return fail("Use op://<vault>/<item>/<field> or op://<vault>/<item>/<section>/<field>.");
    }
    return { ok: true, reference: { source, raw } };
  }

  if (source === "bitwarden-secrets-manager") {
    const secretId = raw.slice("bws://".length);
    if (!UUID.test(secretId)) return fail("Use bws://<secret-id>, where the id is a UUID.");
    return { ok: true, reference: { source, raw, secretId: secretId.toLowerCase() } };
  }

  const body = raw.slice("bw://".length);
  const slash = body.indexOf("/");
  const item = (slash === -1 ? body : body.slice(0, slash)).trim();
  const field = (slash === -1 ? "password" : body.slice(slash + 1)).trim();
  if (!item || item.startsWith("-") || !field || field.startsWith("-")) {
    return fail("Use bw://<item id or name>/<field>, for example bw://OpenAI/password.");
  }
  return { ok: true, reference: { source, raw, item, field } };
}

/** True for a Bitwarden field read with `bw get <field>` rather than from the item's custom fields. */
export function isBitwardenBuiltinField(field: string): boolean {
  return BITWARDEN_BUILTIN_FIELDS.has(field);
}

/** "1Password", "Bitwarden" or "Bitwarden Secrets Manager" for a reference value, else null. */
export function secretReferenceSourceLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = sourceOf(value.trim());
  return source ? SECRET_REFERENCE_SOURCE_LABELS[source] : null;
}

export interface SecretSourcesStatus {
  onepassword: { installed: boolean; serviceAccountConfigured: boolean; account: string };
  bitwardenSecretsManager: {
    installed: boolean;
    accessTokenConfigured: boolean;
    serverUrl: string;
  };
  bitwarden: { installed: boolean; unlocked: boolean };
}

/** Vault tokens from the Settings form. A blank string clears a token; an absent one keeps it. */
export interface SecretSourcesSettingsUpdate {
  onepasswordServiceAccountToken?: string;
  onepasswordAccount?: string;
  bitwardenSecretsManagerAccessToken?: string;
  bitwardenSecretsManagerServerUrl?: string;
}

export type SecretReferenceTestResult =
  | { ok: true; source: SecretReferenceSource; length: number }
  | { ok: false; error: string };

export const SECRET_SOURCES_IPC = {
  status: "secretSources:status",
  save: "secretSources:save",
  unlockBitwarden: "secretSources:unlockBitwarden",
  lockBitwarden: "secretSources:lockBitwarden",
  test: "secretSources:test",
} as const;
