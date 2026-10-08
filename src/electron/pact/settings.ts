/**
 * PACT settings (plan §12): a versioned envelope in the `pact` secure-settings category.
 *
 * Explicit values survive upgrades. Only an unset preference adopts the qualified default, once,
 * recorded by `defaultPreferenceApplied` (the same one-time pattern as the memory repo's
 * default-on migration). Full access and remembered approvals are never translated into grants.
 */
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import {
  DEFAULT_PACT_SETTINGS,
  PACT_QUALIFIED_DEFAULT_PREFERENCE,
  type BusinessAgentProtocolPreference,
  type PactIdentityDeployment,
  type PactProviderConfig,
  type PactSettings,
} from "../../shared/pact";
import { checkPactUrl } from "./protocol-adapter";
import { isPactDevelopmentEnabled } from "./development-signer";

const PREFERENCES: readonly BusinessAgentProtocolPreference[] = [
  "prefer-pact",
  "require-pact",
  "disabled",
];
const DEPLOYMENTS: readonly PactIdentityDeployment[] = [
  "managed",
  "self_hosted",
  "development",
  "none",
];
const MAX_PROVIDERS = 100;

function originOf(value: unknown, allowLoopbackHttp: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = checkPactUrl(value.trim(), { allowLoopbackHttp });
  if (!url) return undefined;
  return url.origin;
}

function normalizeProviders(value: unknown, allowLoopbackHttp: boolean): PactProviderConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const providers: PactProviderConfig[] = [];
  for (const entry of value.slice(0, MAX_PROVIDERS)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const origin = originOf(record.origin, allowLoopbackHttp);
    const audience = typeof record.audience === "string" ? record.audience.trim() : "";
    if (!origin || !audience || audience.length > 512 || seen.has(origin)) continue;
    seen.add(origin);
    providers.push({
      origin,
      audience,
      ...(typeof record.label === "string" && record.label.trim()
        ? { label: record.label.trim().slice(0, 120) }
        : {}),
    });
  }
  return providers;
}

export function normalizePactSettings(
  stored: Partial<PactSettings> | undefined,
  options: { developmentAllowed?: boolean } = {},
): PactSettings {
  const developmentAllowed = options.developmentAllowed ?? isPactDevelopmentEnabled();
  const raw = (stored ?? {}) as Partial<PactSettings> & Record<string, unknown>;
  const identityRaw = (raw.identity ?? {}) as Record<string, unknown>;
  let deployment = DEPLOYMENTS.includes(identityRaw.deployment as PactIdentityDeployment)
    ? (identityRaw.deployment as PactIdentityDeployment)
    : "none";
  // The development signer is never a fallback; outside development runs it reads as unset.
  if (deployment === "development" && !developmentAllowed) deployment = "none";
  const allowLoopbackHttp = deployment === "development";
  const issuer = originOf(identityRaw.issuer, allowLoopbackHttp);
  const signerUrlParsed =
    typeof identityRaw.signerUrl === "string"
      ? checkPactUrl(identityRaw.signerUrl.trim(), { allowLoopbackHttp })
      : undefined;
  const signerUrl = signerUrlParsed ? signerUrlParsed.toString().replace(/\/+$/, "") : undefined;

  const explicitPreference = PREFERENCES.includes(raw.preference as BusinessAgentProtocolPreference)
    ? (raw.preference as BusinessAgentProtocolPreference)
    : undefined;
  let preference = explicitPreference;
  let defaultPreferenceApplied = raw.defaultPreferenceApplied === true;
  if (!defaultPreferenceApplied && PACT_QUALIFIED_DEFAULT_PREFERENCE !== null) {
    preference ??= PACT_QUALIFIED_DEFAULT_PREFERENCE;
    defaultPreferenceApplied = true;
  }

  return {
    version: 1,
    enabled: raw.enabled === true,
    ...(preference ? { preference } : {}),
    ...(defaultPreferenceApplied ? { defaultPreferenceApplied } : {}),
    identity: {
      deployment,
      ...(issuer ? { issuer } : {}),
      ...(signerUrl ? { signerUrl } : {}),
      ...(identityRaw.authMode === "device_key" || identityRaw.authMode === "credential"
        ? { authMode: identityRaw.authMode }
        : {}),
    },
    providers: normalizeProviders(raw.providers, allowLoopbackHttp),
  };
}

/** The preference the router uses: explicit value, else "disabled" until qualified. */
export function effectivePactPreference(settings: PactSettings): BusinessAgentProtocolPreference {
  return settings.preference ?? "disabled";
}

type Listener = (settings: PactSettings) => void;

export class PactSettingsManager {
  private static cache: { revision: number | null; settings: PactSettings } | null = null;
  private static listeners = new Set<Listener>();
  private static repositoryOverride: (() => SecureSettingsRepository | null) | null = null;

  /** Tests inject a repository (or null for defaults only). */
  static setRepositoryForTesting(factory: (() => SecureSettingsRepository | null) | null): void {
    this.repositoryOverride = factory;
    this.cache = null;
  }

  private static repository(): SecureSettingsRepository | null {
    if (this.repositoryOverride) return this.repositoryOverride();
    return SecureSettingsRepository.isInitialized() ? SecureSettingsRepository.getInstance() : null;
  }

  static loadSettings(): PactSettings {
    const repository = this.repository();
    if (!repository) return normalizePactSettings(DEFAULT_PACT_SETTINGS);
    const revision = repository.getRevision("pact");
    if (this.cache && this.cache.revision === revision) return this.cache.settings;
    const stored = repository.load<PactSettings>("pact");
    const settings = normalizePactSettings(stored ?? DEFAULT_PACT_SETTINGS);
    this.cache = { revision, settings };
    return settings;
  }

  static saveSettings(next: Partial<PactSettings>): PactSettings {
    const repository = this.repository();
    if (!repository) throw new Error("Secure settings are not initialized");
    const result = repository.update<PactSettings>("pact", (current) =>
      normalizePactSettings({ ...normalizePactSettings(current), ...next, version: 1 }),
    );
    this.cache = null;
    const settings = normalizePactSettings(result.value);
    for (const listener of this.listeners) {
      try {
        listener(settings);
      } catch {
        // A listener failure must not undo a saved setting.
      }
    }
    return settings;
  }

  static onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  static clearCache(): void {
    this.cache = null;
  }
}
