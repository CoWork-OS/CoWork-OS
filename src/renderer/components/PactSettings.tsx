import { useCallback, useEffect, useState } from "react";
import type {
  BusinessAgentProtocolPreference,
  PactBusinessView,
  PactGrantView,
  PactIdentityDeployment,
  PactIdentitySettings,
  PactProviderConfig,
  PactSettings as PactSettingsValue,
  PactStatusView,
} from "../../shared/pact";

const PREFERENCE_LABELS: Record<BusinessAgentProtocolPreference, string> = {
  "prefer-pact": "Prefer PACT when a business supports it",
  "require-pact": "Only use PACT for business interactions",
  disabled: "Do not use PACT",
};

const DEPLOYMENT_LABELS: Record<PactIdentityDeployment, string> = {
  none: "Not set up",
  managed: "CoWork-managed signer",
  self_hosted: "Self-hosted signer",
  development: "Development signer (local testing only)",
};

const UNAVAILABLE_LABELS: Record<string, string> = {
  disabled_by_admin: "Turned off by your administrator",
  disabled_by_env: "Turned off for support (COWORK_PACT_DISABLED)",
  disabled_in_settings: "Turned off",
  identity_not_configured: "Identity is not set up",
  identity_unavailable: "Identity is unavailable",
};

function formatDate(value?: number): string {
  return value ? new Date(value).toLocaleString() : "unknown";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A grant counts as connected only while it is active and its lifetime has not run out. */
export function isPactGrantConnected(grant: PactGrantView, now: number = Date.now()): boolean {
  return grant.state === "active" && (!grant.grantExpiresAt || grant.grantExpiresAt > now);
}

/**
 * The identity update for "Save identity". The form has no auth-mode control, so the saved
 * mode is kept; settings replace `identity` as a whole, and dropping it would reset the signer.
 */
export function buildPactIdentityUpdate(input: {
  deployment: PactIdentityDeployment;
  issuer: string;
  signerUrl: string;
  current: PactIdentitySettings;
}): PactIdentitySettings {
  return {
    deployment: input.deployment,
    ...(input.issuer.trim() ? { issuer: input.issuer.trim() } : {}),
    ...(input.signerUrl.trim() ? { signerUrl: input.signerUrl.trim() } : {}),
    authMode: input.current.authMode ?? "credential",
  };
}

function PactStatus({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`pact-settings-status ${ok ? "is-ok" : "is-off"}`}>
      <span className="pact-settings-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function PactSettingsLoadFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="pact-settings pact-settings-failure" role="alert">
      <p className="settings-error">Could not load PACT settings: {message}</p>
      <button type="button" className="pact-settings-button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * Settings for PACT business agents: the protocol preference, the personal-agent identity
 * (signer), the providers CoWork is registered with, and the businesses the user connected,
 * with local Disconnect. PACT 1.0 has no revocation endpoint, so Disconnect is local only.
 */
export function PactSettings() {
  const [settings, setSettings] = useState<PactSettingsValue | null>(null);
  const [status, setStatus] = useState<PactStatusView | null>(null);
  const [grants, setGrants] = useState<PactGrantView[]>([]);
  const [businesses, setBusinesses] = useState<PactBusinessView[]>([]);
  const [issuer, setIssuer] = useState("");
  const [signerUrl, setSignerUrl] = useState("");
  const [deployment, setDeployment] = useState<PactIdentityDeployment>("none");
  const [credential, setCredential] = useState("");
  const [providerOrigin, setProviderOrigin] = useState("");
  const [providerAudience, setProviderAudience] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextSettings, nextStatus, nextGrants, nextBusinesses] = await Promise.all([
      window.electronAPI.getPactSettings(),
      window.electronAPI.getPactStatus(),
      window.electronAPI.listPactGrants(),
      window.electronAPI.listPactBusinesses(),
    ]);
    setSettings(nextSettings);
    setStatus(nextStatus);
    setGrants(nextGrants);
    setBusinesses(nextBusinesses);
    setDeployment(nextSettings.identity.deployment);
    setIssuer(nextSettings.identity.issuer ?? "");
    setSignerUrl(nextSettings.identity.signerUrl ?? "");
  }, []);

  const initialLoad = useCallback(() => {
    setLoadError(null);
    load().catch((error) => setLoadError(errorText(error)));
  }, [load]);

  useEffect(() => {
    initialLoad();
  }, [initialLoad]);

  const run = async (label: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    setMessage(null);
    try {
      await action();
      await load();
      if (success) setMessage({ ok: true, text: success });
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  if (!settings || !status) {
    if (loadError) return <PactSettingsLoadFailure message={loadError} onRetry={initialLoad} />;
    return <div className="pact-settings pact-settings-loading">Loading PACT settings...</div>;
  }

  const providers: PactProviderConfig[] = settings.providers;
  const now = Date.now();
  const activeGrants = grants.filter((grant) => isPactGrantConnected(grant, now));

  const statusLabel = status.available
    ? "Available"
    : (UNAVAILABLE_LABELS[status.unavailableReason ?? ""] ?? "Unavailable");

  return (
    <div className="pact-settings">
      <p className="pact-settings-intro">
        Lets CoWork talk to a business&apos;s own agent for you, with your identity and, when the
        business offers it, only the account permissions you approve on the business&apos;s own
        sign-in page. CoWork never sees your password and asks before sending anything that changes
        your account.
      </p>
      <div className="pact-settings-summary">
        <PactStatus ok={status.available} label={statusLabel} />
        <span className="pact-settings-muted">
          {status.activeGrants} connected permission(s) · {status.pendingAuthorizations} pending
          sign-in(s)
        </span>
      </div>

      <section className="pact-settings-section">
        <div className="pact-settings-row">
          <div className="pact-settings-row-text">
            <div className="pact-settings-row-title">Use PACT for business interactions</div>
            <div className="pact-settings-hint">
              Talk to a business&apos;s agent when the business offers one.
            </div>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              aria-label="Use PACT for business interactions"
              checked={settings.enabled}
              disabled={busy !== null}
              onChange={(event) =>
                void run("enabled", () =>
                  window.electronAPI.updatePactSettings({ enabled: event.target.checked }),
                )
              }
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="pact-settings-field">
          <label htmlFor="pact-preference">Preference</label>
          <select
            id="pact-preference"
            className="settings-input"
            value={settings.preference ?? "disabled"}
            disabled={busy !== null || !settings.enabled}
            onChange={(event) =>
              void run("preference", () =>
                window.electronAPI.updatePactSettings({
                  preference: event.target.value as BusinessAgentProtocolPreference,
                }),
              )
            }
          >
            {(Object.keys(PREFERENCE_LABELS) as BusinessAgentProtocolPreference[]).map((value) => (
              <option key={value} value={value}>
                {PREFERENCE_LABELS[value]}
              </option>
            ))}
          </select>
          <div className="pact-settings-hint">
            A preference never grants permission: every request is still checked, approved and
            consented to.
          </div>
        </div>
      </section>

      <section className="pact-settings-section">
        <div className="pact-settings-section-header">
          <h4>Identity</h4>
          <PactStatus
            ok={status.identity.ready}
            label={status.identity.ready ? "Ready" : "Not ready"}
          />
        </div>
        <div className="pact-settings-hint pact-settings-section-note">
          {DEPLOYMENT_LABELS[status.identity.deployment]}
          {status.identity.reason && !status.identity.ready ? ` · ${status.identity.reason}` : ""}
        </div>
        <div className="pact-settings-field">
          <label htmlFor="pact-signer">Signer</label>
          <select
            id="pact-signer"
            className="settings-input"
            value={deployment}
            onChange={(event) => setDeployment(event.target.value as PactIdentityDeployment)}
          >
            {(["none", "managed", "self_hosted", "development"] as PactIdentityDeployment[]).map(
              (value) => (
                <option key={value} value={value}>
                  {DEPLOYMENT_LABELS[value]}
                </option>
              ),
            )}
          </select>
        </div>
        {deployment !== "none" && (
          <>
            <div className="pact-settings-field">
              <label htmlFor="pact-issuer">Issuer URL</label>
              <input
                id="pact-issuer"
                className="settings-input"
                value={issuer}
                placeholder="https://pa.example.com"
                onChange={(event) => setIssuer(event.target.value)}
              />
              <div className="pact-settings-hint">
                The issuer must serve its public keys at /.well-known/jwks.json.
              </div>
            </div>
            {deployment !== "development" && (
              <>
                <div className="pact-settings-field">
                  <label htmlFor="pact-signer-url">Signer URL</label>
                  <input
                    id="pact-signer-url"
                    className="settings-input"
                    value={signerUrl}
                    placeholder="https://signer.example.com"
                    onChange={(event) => setSignerUrl(event.target.value)}
                  />
                </div>
                <div className="pact-settings-field">
                  <label htmlFor="pact-signer-credential">Signer credential</label>
                  <input
                    id="pact-signer-credential"
                    className="settings-input"
                    type="password"
                    value={credential}
                    placeholder="Stored encrypted; leave empty to keep the current one"
                    onChange={(event) => setCredential(event.target.value)}
                  />
                </div>
              </>
            )}
          </>
        )}
        <div className="pact-settings-actions">
          <button
            type="button"
            className="pact-settings-button pact-settings-button-primary"
            disabled={busy !== null}
            onClick={() =>
              void run(
                "identity",
                async () => {
                  await window.electronAPI.updatePactSettings({
                    identity: buildPactIdentityUpdate({
                      deployment,
                      issuer,
                      signerUrl,
                      current: settings.identity,
                    }),
                  });
                  if (credential.trim()) {
                    await window.electronAPI.setPactSignerCredential({
                      credential: credential.trim(),
                    });
                    setCredential("");
                  }
                },
                "Identity settings saved.",
              )
            }
          >
            Save identity
          </button>
        </div>
      </section>

      <section className="pact-settings-section">
        <div className="pact-settings-section-header">
          <h4>Providers</h4>
        </div>
        <div className="pact-settings-hint pact-settings-section-note">
          A provider assigns CoWork an audience when it registers CoWork&apos;s issuer. Add the
          audience it gave you; a business card can never supply it.
        </div>
        {status.providers.length === 0 ? (
          <div className="pact-settings-empty">No providers yet.</div>
        ) : (
          <ul className="pact-settings-list">
            {status.providers.map((provider) => (
              <li key={provider.origin} className="pact-settings-list-row">
                <div className="pact-settings-row-text">
                  <div className="pact-settings-mono">{provider.origin}</div>
                  {provider.reason && !provider.ready && (
                    <div className="pact-settings-hint">{provider.reason}</div>
                  )}
                </div>
                <PactStatus ok={provider.ready} label={provider.ready ? "Ready" : "Not ready"} />
                {providers.some((entry) => entry.origin === provider.origin) && (
                  <button
                    type="button"
                    className="pact-settings-button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run("provider-remove", () =>
                        window.electronAPI.updatePactSettings({
                          providers: providers.filter((entry) => entry.origin !== provider.origin),
                        }),
                      )
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="pact-settings-inline-form">
          <div className="pact-settings-field">
            <label htmlFor="pact-provider-origin">Provider origin</label>
            <input
              id="pact-provider-origin"
              className="settings-input"
              value={providerOrigin}
              placeholder="https://provider.example.com"
              onChange={(event) => setProviderOrigin(event.target.value)}
            />
          </div>
          <div className="pact-settings-field">
            <label htmlFor="pact-provider-audience">Assigned audience</label>
            <input
              id="pact-provider-audience"
              className="settings-input"
              value={providerAudience}
              onChange={(event) => setProviderAudience(event.target.value)}
            />
          </div>
        </div>
        <div className="pact-settings-actions">
          <button
            type="button"
            className="pact-settings-button"
            disabled={busy !== null || !providerOrigin.trim() || !providerAudience.trim()}
            onClick={() =>
              void run(
                "provider-add",
                async () => {
                  await window.electronAPI.updatePactSettings({
                    providers: [
                      ...providers.filter((entry) => entry.origin !== providerOrigin.trim()),
                      { origin: providerOrigin.trim(), audience: providerAudience.trim() },
                    ],
                  });
                  setProviderOrigin("");
                  setProviderAudience("");
                },
                "Provider saved.",
              )
            }
          >
            Add provider
          </button>
        </div>
      </section>

      <section className="pact-settings-section">
        <div className="pact-settings-section-header">
          <h4>Connected businesses</h4>
        </div>
        {activeGrants.length === 0 ? (
          <div className="pact-settings-empty">
            No business permissions yet. CoWork asks you to sign in with a business the first time a
            request needs access to your account there.
          </div>
        ) : (
          <ul className="pact-settings-list">
            {activeGrants.map((grant) => (
              <li key={grant.id} className="pact-settings-list-row pact-settings-grant">
                <div className="pact-settings-row-text">
                  <div className="pact-settings-row-title">{grant.businessName}</div>
                  <div className="pact-settings-hint">
                    Connected {formatDate(grant.createdAt)}
                    {grant.grantExpiresAt ? ` · expires ${formatDate(grant.grantExpiresAt)}` : ""}
                  </div>
                  <ul className="pact-authorization-scopes">
                    {grant.scopes.map((scope) => (
                      <li key={scope.id}>
                        <span className="pact-authorization-scope-description">
                          {scope.description}
                        </span>
                        <span className="pact-authorization-scope-id">{scope.id}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <button
                  type="button"
                  className="pact-settings-button pact-settings-button-danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (
                      !confirm(
                        `Disconnect ${grant.businessName}? CoWork deletes its stored permission now. The business is not notified; to revoke it there, use the business's own account settings.`,
                      )
                    )
                      return;
                    void run(
                      `disconnect-${grant.id}`,
                      () => window.electronAPI.disconnectPactGrant({ id: grant.id }),
                      "Disconnected locally.",
                    );
                  }}
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
        {businesses.length > 0 && (
          <div className="pact-settings-hint pact-settings-known">
            Known businesses:{" "}
            {businesses
              .map((business) => `${business.displayName} (${new URL(business.cardUrl).hostname})`)
              .join(", ")}
          </div>
        )}
      </section>

      {message && (
        <div
          className={`pact-settings-message ${message.ok ? "is-success" : "is-error"}`}
          role="status"
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
