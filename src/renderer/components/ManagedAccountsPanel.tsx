import { useCallback, useEffect, useState } from "react";
import { hasHostMethods } from "../host/browser-capabilities";
import "./managed-accounts.css";

type ManagedAccountStatus =
  | "draft"
  | "pending_signup"
  | "pending_verification"
  | "active"
  | "blocked"
  | "disabled"
  | "error";

type ManagedAccountView = {
  id: string;
  provider: string;
  label: string;
  status: ManagedAccountStatus;
  signupUrl?: string;
  dashboardUrl?: string;
  docsUrl?: string;
  secretKeys?: string[];
  secretCount?: number;
  createdAt: number;
  updatedAt: number;
};

type ManagedAccountUpsert = {
  id?: string;
  provider: string;
  label?: string;
  status: ManagedAccountStatus;
  signupUrl?: string;
  dashboardUrl?: string;
  docsUrl?: string;
  secrets?: Record<string, string>;
  clearSecrets?: boolean;
};

type ManagedAccountApi = {
  listManagedAccounts?: () => Promise<{ accounts: ManagedAccountView[] }>;
  getManagedAccount?: (id: string) => Promise<{ account: ManagedAccountView | null }>;
  upsertManagedAccount?: (input: ManagedAccountUpsert) => Promise<{ account: ManagedAccountView }>;
  removeManagedAccount?: (id: string) => Promise<{ removed: boolean }>;
};

type SecretDraft = { key: string; value: string };

const EMPTY_DRAFT: ManagedAccountUpsert = {
  provider: "",
  label: "",
  status: "draft",
};

const STATUSES: ManagedAccountStatus[] = [
  "draft",
  "pending_signup",
  "pending_verification",
  "active",
  "blocked",
  "disabled",
  "error",
];

const accountApi = () => window.electronAPI as typeof window.electronAPI & ManagedAccountApi;

export function ManagedAccountsPanel() {
  const available = hasHostMethods(
    "listManagedAccounts",
    "upsertManagedAccount",
    "removeManagedAccount",
  );
  const [accounts, setAccounts] = useState<ManagedAccountView[]>([]);
  const [draft, setDraft] = useState<ManagedAccountUpsert>(EMPTY_DRAFT);
  const [secretDrafts, setSecretDrafts] = useState<SecretDraft[]>([{ key: "", value: "" }]);
  const [clearSecrets, setClearSecrets] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The add/edit form is collapsed until the user asks for it.
  const [formOpen, setFormOpen] = useState(false);

  const loadAccounts = useCallback(async () => {
    if (!available) {
      setLoading(false);
      return;
    }
    try {
      const result = await accountApi().listManagedAccounts?.();
      setAccounts(Array.isArray(result?.accounts) ? result.accounts : []);
      setError(null);
    } catch {
      setError("The paired host could not load managed accounts.");
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  if (!available) return null;

  const resetForm = () => {
    setDraft(EMPTY_DRAFT);
    setSecretDrafts([{ key: "", value: "" }]);
    setClearSecrets(false);
    setFormOpen(false);
  };

  const openNewAccountForm = () => {
    resetForm();
    setError(null);
    setNotice(null);
    setFormOpen(true);
  };

  const editAccount = (account: ManagedAccountView) => {
    setDraft({
      id: account.id,
      provider: account.provider,
      label: account.label,
      status: account.status,
      signupUrl: account.signupUrl,
      dashboardUrl: account.dashboardUrl,
      docsUrl: account.docsUrl,
    });
    setSecretDrafts([{ key: "", value: "" }]);
    setClearSecrets(false);
    setError(null);
    setNotice(null);
    setFormOpen(true);
  };

  const saveAccount = async () => {
    const provider = draft.provider.trim();
    if (!provider) {
      setError("Enter a provider name.");
      return;
    }
    const secretEntries = secretDrafts
      .map(({ key, value }) => [key.trim(), value] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0);
    const duplicateSecret = secretEntries.some(
      ([key], index) => secretEntries.findIndex(([candidate]) => candidate === key) !== index,
    );
    if (duplicateSecret) {
      setError("Each credential key must be unique.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await accountApi().upsertManagedAccount?.({
        ...draft,
        provider,
        label: draft.label?.trim() || provider,
        ...(secretEntries.length ? { secrets: Object.fromEntries(secretEntries) } : {}),
        ...(clearSecrets ? { clearSecrets: true } : {}),
      });
      resetForm();
      setNotice("Managed account saved on the paired host.");
      await loadAccounts();
    } catch {
      setError("The paired host could not save this account. Credential values were not returned.");
    } finally {
      setSaving(false);
    }
  };

  const removeAccount = async (account: ManagedAccountView) => {
    if (
      !window.confirm(`Remove the managed account record for ${account.label || account.provider}?`)
    ) {
      return;
    }
    setRemovingId(account.id);
    setError(null);
    setNotice(null);
    try {
      await accountApi().removeManagedAccount?.(account.id);
      if (draft.id === account.id) resetForm();
      setNotice("Managed account removed from the paired host.");
      await loadAccounts();
    } catch {
      setError("The paired host could not remove this managed account.");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <section
      className="settings-section managed-accounts-panel"
      aria-labelledby="managed-accounts-title"
    >
      <div className="settings-section-header">
        <div>
          <h3 id="managed-accounts-title">Managed accounts</h3>
          <p className="settings-description">
            Save account references and credentials on the paired host. This form records
            credentials; it does not create provider accounts or verify them. Credential values
            cannot be read back.
          </p>
        </div>
        {!formOpen ? (
          <button
            className="button-secondary button-small"
            type="button"
            onClick={openNewAccountForm}
            aria-expanded={false}
            aria-controls="managed-accounts-form"
          >
            Add account
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="settings-alert settings-alert-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-alert" role="status">
          {notice}
        </div>
      ) : null}

      {formOpen ? (
        <div className="managed-accounts-form" id="managed-accounts-form">
          <h4 className="managed-accounts-form-title">
            {draft.id ? "Edit account record" : "New account record"}
          </h4>
        <div className="settings-field">
          <label className="settings-label" htmlFor="managed-account-provider">
            Provider
          </label>
          <input
            id="managed-account-provider"
            className="settings-input"
            value={draft.provider}
            maxLength={120}
            onChange={(event) =>
              setDraft((current) => ({ ...current, provider: event.target.value }))
            }
            placeholder="Example: Linear"
          />
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="managed-account-label">
            Label
          </label>
          <input
            id="managed-account-label"
            className="settings-input"
            value={draft.label || ""}
            maxLength={160}
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
            placeholder="Optional display name"
          />
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="managed-account-status">
            Status
          </label>
          <select
            id="managed-account-status"
            className="settings-input"
            value={draft.status}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                status: event.target.value as ManagedAccountStatus,
              }))
            }
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="managed-account-dashboard">
            Dashboard URL
          </label>
          <input
            id="managed-account-dashboard"
            className="settings-input"
            type="url"
            value={draft.dashboardUrl || ""}
            maxLength={2048}
            onChange={(event) =>
              setDraft((current) => ({ ...current, dashboardUrl: event.target.value }))
            }
            placeholder="https://..."
          />
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="managed-account-signup">
            Signup URL
          </label>
          <input
            id="managed-account-signup"
            className="settings-input"
            type="url"
            value={draft.signupUrl || ""}
            maxLength={2048}
            onChange={(event) =>
              setDraft((current) => ({ ...current, signupUrl: event.target.value }))
            }
            placeholder="https://..."
          />
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="managed-account-docs">
            Documentation URL
          </label>
          <input
            id="managed-account-docs"
            className="settings-input"
            type="url"
            value={draft.docsUrl || ""}
            maxLength={2048}
            onChange={(event) => setDraft((current) => ({ ...current, docsUrl: event.target.value }))}
            placeholder="https://..."
          />
        </div>

        <div className="settings-field">
          <span className="settings-label">Credentials</span>
          {draft.id && accounts.find((account) => account.id === draft.id)?.secretCount ? (
            <p className="settings-hint">
              {accounts.find((account) => account.id === draft.id)?.secretCount} credential value(s)
              stored on the host. Add a matching key to replace it; leave fields blank to preserve it.
            </p>
          ) : null}
          {secretDrafts.map((entry, index) => (
            <div className="managed-accounts-secret-row" key={index}>
              <input
                className="settings-input"
                aria-label={`Credential key ${index + 1}`}
                value={entry.key}
                maxLength={128}
                onChange={(event) =>
                  setSecretDrafts((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, key: event.target.value } : item,
                    ),
                  )
                }
                placeholder="Credential key"
              />
              <input
                className="settings-input"
                aria-label={`Credential value ${index + 1}`}
                type="password"
                autoComplete="new-password"
                value={entry.value}
                maxLength={4096}
                onChange={(event) =>
                  setSecretDrafts((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
                placeholder="Credential value"
              />
              {secretDrafts.length > 1 ? (
                <button
                  className="button-secondary button-small"
                  type="button"
                  aria-label={`Remove credential field ${index + 1}`}
                  onClick={() =>
                    setSecretDrafts((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          <button
            className="button-secondary button-small"
            type="button"
            onClick={() =>
              setSecretDrafts((current) =>
                current.length < 64 ? [...current, { key: "", value: "" }] : current,
              )
            }
            disabled={secretDrafts.length >= 64}
          >
            Add credential
          </button>
          {draft.id ? (
            <label className="managed-accounts-clear-row">
              <input
                type="checkbox"
                checked={clearSecrets}
                onChange={(event) => setClearSecrets(event.target.checked)}
              />
              <span>Clear all stored credentials when saving</span>
            </label>
          ) : null}
        </div>

        <div className="settings-actions">
          <button
            className="button-primary button-small"
            onClick={() => void saveAccount()}
            disabled={saving}
          >
            {saving ? "Saving on host…" : draft.id ? "Save account" : "Add account record"}
          </button>
          <button className="button-secondary button-small" onClick={resetForm} disabled={saving}>
            Cancel
          </button>
        </div>
        </div>
      ) : null}

      <div className="settings-subsection">
        <div className="settings-section-header">
          <h4>Saved account records</h4>
          <button
            className="button-secondary button-small"
            onClick={() => void loadAccounts()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {loading ? <p className="settings-description">Loading managed accounts…</p> : null}
        {!loading && accounts.length === 0 ? (
          <p className="settings-description">No managed account records are saved on this host.</p>
        ) : null}
        {accounts.map((account) => (
          <div className="managed-accounts-row" key={account.id}>
            <div>
              <strong>{account.label || account.provider}</strong>
              <p className="managed-accounts-meta">
                {account.provider} · {account.status}
                {account.secretCount ? ` · ${account.secretCount} credential value(s) stored` : ""}
              </p>
            </div>
            <div className="settings-actions">
              <button
                className="button-secondary button-small"
                onClick={() => editAccount(account)}
              >
                Edit
              </button>
              <button
                className="button-secondary button-small"
                onClick={() => void removeAccount(account)}
                disabled={removingId === account.id}
              >
                {removingId === account.id ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
