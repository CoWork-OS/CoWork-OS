import { PasswordManagerVault } from "../../browser/credentials/password-managers";
import {
  SECRET_REFERENCE_SOURCE_LABELS,
  parseSecretReference,
  type SecretReference,
  type SecretReferenceSource,
  type SecretReferenceTestResult,
  type SecretSourcesStatus,
} from "../../../shared/secret-references";
import { rememberResolvedSecret } from "./known-secret-values";
import {
  runSecretCli,
  secretCliEnv,
  type SecretCliResult,
  type SecretCliRunner,
} from "./secret-cli";
import {
  secureSecretSourceSettings,
  type SecretSourceSettings,
  type SecretSourceSettingsStore,
} from "./secret-source-settings";

export type SecretReferenceErrorKind =
  | "invalid_reference"
  | "not_installed"
  | "not_configured"
  | "locked"
  | "auth_failed"
  | "not_found"
  | "empty_value"
  | "timeout"
  | "unavailable";

/** A reference that could not be read. The message names the reference and the fix, never a value. */
export class SecretReferenceError extends Error {
  constructor(
    message: string,
    readonly kind: SecretReferenceErrorKind,
    readonly source: SecretReferenceSource,
  ) {
    super(message);
    this.name = "SecretReferenceError";
  }
}

const SETTINGS_PLACE = "Settings > System & Security > Password Managers";
/** Bitwarden sessions for vault references, separate from the in-app browser's. */
const SECRETS_SCOPE = "vault-references";
const DEFAULT_TTL_MS = 10 * 60_000;
const OP_ENV_PASSTHROUGH = [
  "OP_CONFIG_DIR",
  "OP_ACCOUNT",
  "OP_CONNECT_HOST",
  "OP_CONNECT_TOKEN",
  "OP_SERVICE_ACCOUNT_TOKEN",
  "OP_BIOMETRIC_UNLOCK_ENABLED",
];

const FIXES: Record<SecretReferenceSource, Partial<Record<SecretReferenceErrorKind, string>>> = {
  onepassword: {
    not_installed: `Install the 1Password CLI (op) and turn on its 1Password app integration, or add a service account token in ${SETTINGS_PLACE}.`,
    auth_failed: `Unlock the 1Password app, or check the service account token in ${SETTINGS_PLACE}.`,
    not_found: "Check the vault, item and field names, and that this account can read them.",
    timeout:
      "op did not answer within 30 seconds. If 1Password asked you to approve access, approve it and retry.",
  },
  "bitwarden-secrets-manager": {
    not_installed: "Install the Bitwarden Secrets Manager CLI (bws).",
    not_configured: `Add a Bitwarden Secrets Manager access token in ${SETTINGS_PLACE}.`,
    auth_failed: `Check the Bitwarden Secrets Manager access token in ${SETTINGS_PLACE}.`,
    not_found: "Check the secret id, and that the machine account can read its project.",
    timeout: "bws did not answer within 30 seconds. Check the network and retry.",
  },
  bitwarden: {
    not_installed: "Install the Bitwarden CLI (bw) and sign in with bw login.",
    locked: `Unlock Bitwarden in ${SETTINGS_PLACE} and retry. For cowork run, set BW_SESSION from bw unlock --raw.`,
    not_found: "Check the item id or name and the field name.",
    unavailable:
      "Check that the item exists, that its name matches only one item, and that Bitwarden is still unlocked.",
  },
};

const REASONS: Record<SecretReferenceErrorKind, string> = {
  invalid_reference: "the reference is not valid",
  not_installed: "its command-line tool is not installed",
  not_configured: "no access token is set up",
  locked: "the vault is locked",
  auth_failed: "sign-in failed",
  not_found: "the item was not found",
  empty_value: "the field is empty",
  timeout: "the vault did not answer in time",
  unavailable: "the vault could not be reached",
};

function referenceError(
  reference: Pick<SecretReference, "source" | "raw">,
  kind: SecretReferenceErrorKind,
): SecretReferenceError {
  const label = SECRET_REFERENCE_SOURCE_LABELS[reference.source];
  const fix = FIXES[reference.source][kind];
  return new SecretReferenceError(
    `${label} could not read ${reference.raw}: ${REASONS[kind]}.${fix ? ` ${fix}` : ""}`,
    kind,
    reference.source,
  );
}

/** Map a failed CLI run onto an error kind, from its exit state and (privately) its stderr. */
function classify(
  source: "onepassword" | "bitwarden-secrets-manager",
  result: SecretCliResult,
): SecretReferenceErrorKind {
  if (result.spawnError === "ENOENT") return "not_installed";
  if (result.timedOut) return "timeout";
  const text = result.stderr.toLowerCase();
  const has = (...needles: string[]) => needles.some((needle) => text.includes(needle));
  if (source === "onepassword") {
    if (
      has(
        "isn't an item",
        "isn't a vault",
        "isn't a field",
        "no item",
        "could not find",
        "not found",
      )
    )
      return "not_found";
    if (has("signed in", "sign in", "unauthorized", "authorization", "invalid token", "session"))
      return "auth_failed";
    return "unavailable";
  }
  if (has("404", "not found", "resource not found")) return "not_found";
  if (has("401", "403", "unauthorized", "invalid_client", "invalid_grant", "access token"))
    return "auth_failed";
  return "unavailable";
}

export interface SecretReferenceResolverOptions {
  run?: SecretCliRunner;
  settings?: SecretSourceSettingsStore;
  managers?: PasswordManagerVault;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  ttlMs?: number;
}

type CacheEntry = { value: string; fetchedAt: number; source: SecretReferenceSource };

/**
 * Reads vault references for provider keys and connector secrets. Values live only in this
 * process's memory for a short time and are re-read after that; nothing is written to disk.
 * A reference that can't be read fails with an error that says what to fix; there is no
 * fallback to an older value.
 */
export class SecretReferenceResolver {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<string>>();
  private readonly run: SecretCliRunner;
  private readonly settings: SecretSourceSettingsStore;
  readonly managers: PasswordManagerVault;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: SecretReferenceResolverOptions = {}) {
    this.run = options.run || runSecretCli;
    this.settings = options.settings || secureSecretSourceSettings;
    this.managers = options.managers || new PasswordManagerVault();
    this.env = options.env || process.env;
    this.now = options.now || Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** A plain value comes back unchanged; a reference comes back as the value it points to. */
  async resolve(value: string | undefined): Promise<string | undefined> {
    const parsed = parseSecretReference(value);
    if (!parsed) return value;
    if (!parsed.ok) {
      throw new SecretReferenceError(
        `${SECRET_REFERENCE_SOURCE_LABELS[parsed.source]} reference ${String(value).trim()} is not valid. ${parsed.error}`,
        "invalid_reference",
        parsed.source,
      );
    }
    const { reference } = parsed;
    const cached = this.cache.get(reference.raw);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached.value;
    const pending = this.inFlight.get(reference.raw);
    if (pending) return pending;
    const read = this.read(reference)
      .then((secret) => {
        if (!secret) throw referenceError(reference, "empty_value");
        this.cache.set(reference.raw, {
          value: secret,
          fetchedAt: this.now(),
          source: reference.source,
        });
        rememberResolvedSecret(secret);
        return secret;
      })
      .finally(() => this.inFlight.delete(reference.raw));
    this.inFlight.set(reference.raw, read);
    return read;
  }

  /** Resolve every value of an env or header map; plain values pass through. */
  async resolveRecord(
    record: Record<string, string> | undefined,
  ): Promise<Record<string, string> | undefined> {
    if (!record) return record;
    const entries = await Promise.all(
      Object.entries(record).map(async ([key, value]) => [key, (await this.resolve(value)) ?? ""]),
    );
    return Object.fromEntries(entries);
  }

  /** Forget cached values, for one source (after its token changes or it locks) or all. */
  clear(source?: SecretReferenceSource): void {
    for (const [raw, entry] of this.cache) {
      if (!source || entry.source === source) this.cache.delete(raw);
    }
  }

  async status(): Promise<SecretSourcesStatus> {
    const settings = this.settings.load();
    const installed = async (file: string, args: string[]) => {
      const result = await this.run(file, args, secretCliEnv(this.env));
      return result.code === 0;
    };
    const [op, bws, bw] = await Promise.all([
      installed("op", ["--version"]),
      installed("bws", ["--version"]),
      installed("bw", ["--version"]),
    ]);
    return {
      onepassword: {
        installed: op,
        serviceAccountConfigured: Boolean(settings.onepassword?.serviceAccountToken),
        account: settings.onepassword?.account || "",
      },
      bitwardenSecretsManager: {
        installed: bws,
        accessTokenConfigured: Boolean(settings.bitwardenSecretsManager?.accessToken),
        serverUrl: settings.bitwardenSecretsManager?.serverUrl || "",
      },
      bitwarden: { installed: bw, unlocked: this.bitwardenUnlocked() },
    };
  }

  async unlockBitwarden(password: string): Promise<void> {
    try {
      await this.managers.unlock(SECRETS_SCOPE, "bitwarden", password);
    } catch {
      throw new Error(
        "Bitwarden did not unlock. Check the master password, or sign in with bw login first.",
      );
    }
  }

  lockBitwarden(): void {
    this.managers.lock(SECRETS_SCOPE, "bitwarden");
    this.clear("bitwarden");
  }

  /** Read a reference without returning its value, for the Settings "Test" button. */
  async test(value: string): Promise<SecretReferenceTestResult> {
    const parsed = parseSecretReference(value);
    if (!parsed) return { ok: false, error: "That is not a vault reference." };
    try {
      const secret = await this.resolve(value);
      return {
        ok: true,
        source: parsed.ok ? parsed.reference.source : parsed.source,
        length: secret?.length ?? 0,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private bitwardenUnlocked(): boolean {
    if (this.managers.isUnlocked(SECRETS_SCOPE, "bitwarden")) return true;
    const session = this.env.BW_SESSION?.trim();
    if (!session) return false;
    this.managers.adoptSession(SECRETS_SCOPE, "bitwarden", session);
    return true;
  }

  private async read(reference: SecretReference): Promise<string> {
    const settings = this.settings.load();
    if (reference.source === "onepassword") return this.readOnePassword(reference, settings);
    if (reference.source === "bitwarden-secrets-manager") {
      return this.readSecretsManager(reference, settings);
    }
    if (!this.bitwardenUnlocked()) throw referenceError(reference, "locked");
    try {
      return await this.managers.bitwardenField(SECRETS_SCOPE, reference.item, reference.field);
    } catch (error) {
      if (!this.managers.isUnlocked(SECRETS_SCOPE, "bitwarden")) {
        throw referenceError(reference, "locked");
      }
      const message = error instanceof Error ? error.message : "";
      throw referenceError(reference, /invalid item/i.test(message) ? "not_found" : "unavailable");
    }
  }

  private async readOnePassword(
    reference: Extract<SecretReference, { source: "onepassword" }>,
    settings: SecretSourceSettings,
  ): Promise<string> {
    const token = settings.onepassword?.serviceAccountToken;
    const account = settings.onepassword?.account;
    const extra: Record<string, string | undefined> = {};
    if (token) {
      extra.OP_SERVICE_ACCOUNT_TOKEN = token;
    } else {
      for (const key of OP_ENV_PASSTHROUGH) extra[key] = this.env[key];
      for (const [key, value] of Object.entries(this.env)) {
        if (key.startsWith("OP_SESSION_")) extra[key] = value;
      }
    }
    const args = [
      "read",
      "--no-newline",
      ...(account ? ["--account", account] : []),
      "--",
      reference.raw,
    ];
    const result = await this.run("op", args, secretCliEnv(this.env, extra));
    if (result.code !== 0) throw referenceError(reference, classify("onepassword", result));
    return result.stdout.replace(/\r?\n$/, "");
  }

  private async readSecretsManager(
    reference: Extract<SecretReference, { source: "bitwarden-secrets-manager" }>,
    settings: SecretSourceSettings,
  ): Promise<string> {
    const token =
      settings.bitwardenSecretsManager?.accessToken || this.env.BWS_ACCESS_TOKEN?.trim();
    if (!token) throw referenceError(reference, "not_configured");
    const serverUrl =
      settings.bitwardenSecretsManager?.serverUrl || this.env.BWS_SERVER_URL?.trim();
    const args = [
      "secret",
      "get",
      reference.secretId,
      "--output",
      "json",
      ...(serverUrl ? ["--server-url", serverUrl] : []),
    ];
    const result = await this.run("bws", args, secretCliEnv(this.env, { BWS_ACCESS_TOKEN: token }));
    if (result.code !== 0) {
      throw referenceError(reference, classify("bitwarden-secrets-manager", result));
    }
    let secret: unknown;
    try {
      secret = (JSON.parse(result.stdout) as { value?: unknown }).value;
    } catch {
      throw referenceError(reference, "unavailable");
    }
    return typeof secret === "string" ? secret : "";
  }
}

let resolver: SecretReferenceResolver | null = null;

/** The process-wide resolver: one cache and one Bitwarden session for all callers. */
export function getSecretReferenceResolver(): SecretReferenceResolver {
  if (!resolver) resolver = new SecretReferenceResolver();
  return resolver;
}

/** Shorthand for `getSecretReferenceResolver().resolve(value)`. */
export function resolveSecretValue(value: string | undefined): Promise<string | undefined> {
  return getSecretReferenceResolver().resolve(value);
}
