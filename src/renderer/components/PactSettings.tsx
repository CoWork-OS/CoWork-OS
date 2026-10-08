import { useCallback, useEffect, useState } from "react";
import type {
  BusinessAgentProtocolPreference,
  PactBusinessView,
  PactGrantView,
  PactIdentityDeployment,
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

  useEffect(() => {
    void load().catch((error) => setMessage({ ok: false, text: String(error?.message || error) }));
  }, [load]);

  const run = async (label: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    setMessage(null);
    try {
      await action();
      await load();
      if (success) setMessage({ ok: true, text: success });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  if (!settings || !status) {
    return <div className="settings-loading">Loading PACT settings...</div>;
  }

  const providers: PactProviderConfig[] = settings.providers;
  const activeGrants = grants.filter((grant) => grant.state === "active");

  return (
    <div className="googlechat-settings">
      <div className="settings-section">
        <h3>PACT business agents</h3>
        <p className="settings-description">
          Lets CoWork talk to a business&apos;s own agent for you, with your identity and, when the
          business offers it, only the account permissions you approve on the business&apos;s own
          sign-in page. CoWork never sees your password and asks before sending anything that
          changes your account.
        </p>
        <div className="settings-status-row">
          <span
            className={`settings-badge status-${status.available ? "connected" : "disconnected"}`}
          >
            {status.available
              ? "Available"
              : (UNAVAILABLE_LABELS[status.unavailableReason ?? ""] ?? "Unavailable")}
          </span>
          <span className="settings-muted">
            {status.activeGrants} connected permission(s) · {status.pendingAuthorizations} pending
            sign-in(s)
          </span>
        </div>

        <div className="settings-field">
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy !== null}
              onChange={(event) =>
                void run("enabled", () =>
                  window.electronAPI.updatePactSettings({ enabled: event.target.checked }),
                )
              }
            />{" "}
            Use PACT for business interactions
          </label>
        </div>
        <div className="settings-field">
          <label>Preference</label>
          <select
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
          <div className="settings-hint">
            A preference never grants permission: every request is still checked, approved and
            consented to.
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h4>Identity</h4>
        <div className="settings-status-row">
          <span
            className={`settings-badge status-${status.identity.ready ? "connected" : "error"}`}
          >
            {status.identity.ready ? "Ready" : "Not ready"}
          </span>
          <span className="settings-muted">
            {DEPLOYMENT_LABELS[status.identity.deployment]}
            {status.identity.reason && !status.identity.ready ? ` · ${status.identity.reason}` : ""}
          </span>
        </div>
        <div className="settings-field">
          <label>Signer</label>
          <select
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
            <div className="settings-field">
              <label>Issuer URL</label>
              <input
                className="settings-input"
                value={issuer}
                placeholder="https://pa.example.com"
                onChange={(event) => setIssuer(event.target.value)}
              />
              <div className="settings-hint">
                The issuer must serve its public keys at /.well-known/jwks.json.
              </div>
            </div>
            {deployment !== "development" && (
              <>
                <div className="settings-field">
                  <label>Signer URL</label>
                  <input
                    className="settings-input"
                    value={signerUrl}
                    placeholder="https://signer.example.com"
                    onChange={(event) => setSignerUrl(event.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label>Signer credential</label>
                  <input
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
        <div className="settings-actions">
          <button
            className="settings-button settings-button-primary"
            disabled={busy !== null}
            onClick={() =>
              void run(
                "identity",
                async () => {
                  await window.electronAPI.updatePactSettings({
                    identity: {
                      deployment,
                      ...(issuer.trim() ? { issuer: issuer.trim() } : {}),
                      ...(signerUrl.trim() ? { signerUrl: signerUrl.trim() } : {}),
                      authMode: "credential",
                    },
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
      </div>

      <div className="settings-section">
        <h4>Providers</h4>
        <p className="settings-description">
          A provider assigns CoWork an audience when it registers CoWork&apos;s issuer. Add the
          audience it gave you; a business card can never supply it.
        </p>
        {status.providers.length === 0 && <div className="settings-hint">No providers yet.</div>}
        {status.providers.map((provider) => (
          <div key={provider.origin} className="settings-status-row">
            <span className={`settings-badge status-${provider.ready ? "connected" : "error"}`}>
              {provider.ready ? "Ready" : "Not ready"}
            </span>
            <span className="settings-muted">
              {provider.origin}
              {provider.reason && !provider.ready ? ` · ${provider.reason}` : ""}
            </span>
            {providers.some((entry) => entry.origin === provider.origin) && (
              <button
                className="settings-button"
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
          </div>
        ))}
        <div className="settings-field">
          <label>Provider origin</label>
          <input
            className="settings-input"
            value={providerOrigin}
            placeholder="https://provider.example.com"
            onChange={(event) => setProviderOrigin(event.target.value)}
          />
        </div>
        <div className="settings-field">
          <label>Assigned audience</label>
          <input
            className="settings-input"
            value={providerAudience}
            onChange={(event) => setProviderAudience(event.target.value)}
          />
        </div>
        <button
          className="settings-button"
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

      <div className="settings-section">
        <h4>Connected businesses</h4>
        {activeGrants.length === 0 && (
          <div className="settings-hint">
            No business permissions yet. CoWork asks you to sign in with a business the first time a
            request needs access to your account there.
          </div>
        )}
        {activeGrants.map((grant) => (
          <div key={grant.id} className="settings-field">
            <div className="settings-status-row">
              <strong>{grant.businessName}</strong>
              <span className="settings-muted">
                connected {formatDate(grant.createdAt)}
                {grant.grantExpiresAt ? ` · expires ${formatDate(grant.grantExpiresAt)}` : ""}
              </span>
            </div>
            <ul className="pact-authorization-scopes">
              {grant.scopes.map((scope) => (
                <li key={scope.id}>
                  <span className="pact-authorization-scope-description">{scope.description}</span>
                  <span className="pact-authorization-scope-id">{scope.id}</span>
                </li>
              ))}
            </ul>
            <button
              className="settings-button settings-button-danger"
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
          </div>
        ))}
        {businesses.length > 0 && (
          <div className="settings-hint">
            Known businesses:{" "}
            {businesses
              .map((business) => `${business.displayName} (${new URL(business.cardUrl).hostname})`)
              .join(", ")}
          </div>
        )}
      </div>

      {message && (
        <div className={`settings-status ${message.ok ? "success" : "error"}`}>{message.text}</div>
      )}
    </div>
  );
}
