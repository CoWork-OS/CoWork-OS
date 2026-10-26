import { useCallback, useEffect, useState } from "react";
import type {
  SecretReferenceTestResult,
  SecretSourcesSettingsUpdate,
  SecretSourcesStatus,
} from "../../shared/secret-references";
import { SECRET_REFERENCE_SOURCE_LABELS } from "../../shared/secret-references";
import { hasHostMethods } from "../host/browser-capabilities";

const PASSWORD_MANAGER_METHODS = [
  "getSecretSourcesStatus",
  "saveSecretSources",
  "unlockBitwardenForKeys",
  "lockBitwardenForKeys",
  "testSecretReference",
] as const;

type Result = { success: boolean; status?: SecretSourcesStatus; error?: string };

function cliState(installed: boolean | undefined, name: string): string {
  return installed ? `${name} is installed.` : `${name} was not found on this computer.`;
}

/**
 * Keys from 1Password and Bitwarden. A provider key or connector secret field can hold a vault
 * reference instead of the key; the main process reads it when it is needed. Token fields are
 * write-only: the main process reports only whether one is saved.
 */
export function PasswordManagersSettings() {
  const [status, setStatus] = useState<SecretSourcesStatus>();
  const [opToken, setOpToken] = useState("");
  const [opAccount, setOpAccount] = useState("");
  const [bwsToken, setBwsToken] = useState("");
  const [bwsServerUrl, setBwsServerUrl] = useState("");
  const [masterPassword, setMasterPassword] = useState("");
  const [reference, setReference] = useState("");
  const [test, setTest] = useState<SecretReferenceTestResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const available = hasHostMethods(...PASSWORD_MANAGER_METHODS);

  const apply = useCallback((result: Result) => {
    if (!result.success || !result.status) throw new Error(result.error || "Request failed.");
    setStatus(result.status);
    setOpAccount(result.status.onepassword.account);
    setBwsServerUrl(result.status.bitwardenSecretsManager.serverUrl);
  }, []);

  const refresh = useCallback(
    () => window.electronAPI.getSecretSourcesStatus().then(apply),
    [apply],
  );

  useEffect(() => {
    if (!available) return;
    refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [available, refresh]);

  if (!available) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (update: SecretSourcesSettingsUpdate, done: string) =>
    run(async () => {
      apply(await window.electronAPI.saveSecretSources(update));
      setOpToken("");
      setBwsToken("");
      setNotice(done);
    });

  const unlock = () =>
    run(async () => {
      const password = masterPassword;
      setMasterPassword("");
      const result = await window.electronAPI.unlockBitwardenForKeys(password);
      if (!result.success) throw new Error(result.error || "Bitwarden did not unlock.");
      await refresh();
      setNotice("Bitwarden is unlocked for keys until you lock it or it is idle for 30 minutes.");
    });

  const lock = () =>
    run(async () => {
      await window.electronAPI.lockBitwardenForKeys();
      await refresh();
      setNotice(
        "Bitwarden is locked. Keys stored as bw:// references stop working until you unlock it.",
      );
    });

  const testReference = () =>
    run(async () => {
      setTest(undefined);
      const response = await window.electronAPI.testSecretReference(reference.trim());
      if (!response.success || !response.result) throw new Error(response.error || "Test failed.");
      setTest(response.result);
    });

  const op = status?.onepassword;
  const bws = status?.bitwardenSecretsManager;
  const bw = status?.bitwarden;
  const opDirty = opToken.trim().length > 0 || opAccount.trim() !== (op?.account ?? "");
  const bwsDirty = bwsToken.trim().length > 0 || bwsServerUrl.trim() !== (bws?.serverUrl ?? "");

  return (
    <div className="password-managers-settings">
      <p className="settings-description">
        Keep provider keys and connector secrets in your password manager. In any API key field, or
        in an MCP server&apos;s environment variables and headers, paste a reference instead of the
        key: <code>op://Vault/Item/field</code> for 1Password, <code>bws://secret-id</code> for
        Bitwarden Secrets Manager, or <code>bw://Item/field</code> for a Bitwarden item. CoWork
        reads the value when it is needed and keeps it in memory for up to 10 minutes; it is never
        saved.
      </p>
      {error ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <p className="settings-description" role="status">
          {notice}
        </p>
      ) : null}

      <section className="settings-section" aria-label="1Password">
        <h3>1Password</h3>
        <p className="settings-description">
          {cliState(op?.installed, "The 1Password CLI (op)")} With the 1Password app&apos;s CLI
          integration turned on, CoWork asks the app for each key and you approve it there. For runs
          nobody watches, such as <code>cowork run</code> or scheduled tasks, add a service account
          token.
        </p>
        <div className="settings-field">
          <label htmlFor="op-service-account-token">Service account token (optional)</label>
          <input
            id="op-service-account-token"
            type="password"
            className="settings-input"
            autoComplete="off"
            placeholder={
              op?.serviceAccountConfigured ? "Saved — enter a new token to replace it" : "ops_..."
            }
            value={opToken}
            disabled={busy || !status}
            onChange={(e) => setOpToken(e.target.value)}
          />
        </div>
        <div className="settings-field">
          <label htmlFor="op-account">Account (optional)</label>
          <input
            id="op-account"
            type="text"
            className="settings-input"
            autoComplete="off"
            placeholder="my.1password.com"
            value={opAccount}
            disabled={busy || !status}
            onChange={(e) => setOpAccount(e.target.value)}
          />
        </div>
        <div className="password-managers-actions">
          <button
            type="button"
            className="button-secondary"
            disabled={busy || !status || !opDirty}
            onClick={() =>
              void save(
                {
                  ...(opToken.trim() ? { onepasswordServiceAccountToken: opToken.trim() } : {}),
                  onepasswordAccount: opAccount.trim(),
                },
                "1Password settings saved.",
              )
            }
          >
            Save
          </button>
          {op?.serviceAccountConfigured ? (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() =>
                void save({ onepasswordServiceAccountToken: "" }, "Service account token removed.")
              }
            >
              Remove token
            </button>
          ) : null}
        </div>
      </section>

      <section className="settings-section" aria-label="Bitwarden Secrets Manager">
        <h3>Bitwarden Secrets Manager</h3>
        <p className="settings-description">
          {cliState(bws?.installed, "The Secrets Manager CLI (bws)")} References use a machine
          account&apos;s access token, so they also work for unattended runs.
        </p>
        <div className="settings-field">
          <label htmlFor="bws-access-token">Access token</label>
          <input
            id="bws-access-token"
            type="password"
            className="settings-input"
            autoComplete="off"
            placeholder={
              bws?.accessTokenConfigured ? "Saved — enter a new token to replace it" : "0...."
            }
            value={bwsToken}
            disabled={busy || !status}
            onChange={(e) => setBwsToken(e.target.value)}
          />
        </div>
        <div className="settings-field">
          <label htmlFor="bws-server-url">Server URL (optional)</label>
          <input
            id="bws-server-url"
            type="url"
            className="settings-input"
            autoComplete="off"
            placeholder="https://vault.bitwarden.eu"
            value={bwsServerUrl}
            disabled={busy || !status}
            onChange={(e) => setBwsServerUrl(e.target.value)}
          />
        </div>
        <div className="password-managers-actions">
          <button
            type="button"
            className="button-secondary"
            disabled={busy || !status || !bwsDirty}
            onClick={() =>
              void save(
                {
                  ...(bwsToken.trim()
                    ? { bitwardenSecretsManagerAccessToken: bwsToken.trim() }
                    : {}),
                  bitwardenSecretsManagerServerUrl: bwsServerUrl.trim(),
                },
                "Bitwarden Secrets Manager settings saved.",
              )
            }
          >
            Save
          </button>
          {bws?.accessTokenConfigured ? (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() =>
                void save({ bitwardenSecretsManagerAccessToken: "" }, "Access token removed.")
              }
            >
              Remove token
            </button>
          ) : null}
        </div>
      </section>

      <section className="settings-section" aria-label="Bitwarden">
        <h3>Bitwarden</h3>
        <p className="settings-description">
          {cliState(bw?.installed, "The Bitwarden CLI (bw)")} Sign in once with{" "}
          <code>bw login</code> in a terminal, then unlock here. The session stays in memory and
          ends when you lock it, quit CoWork, or after 30 idle minutes. For <code>cowork run</code>,
          set <code>BW_SESSION</code> from <code>bw unlock --raw</code>.
        </p>
        {bw?.unlocked ? (
          <div className="password-managers-actions">
            <span className="settings-description">Unlocked for keys.</span>
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => void lock()}
            >
              Lock
            </button>
          </div>
        ) : (
          <>
            <div className="settings-field">
              <label htmlFor="bw-master-password">Master password</label>
              <input
                id="bw-master-password"
                type="password"
                className="settings-input"
                autoComplete="off"
                value={masterPassword}
                disabled={busy || !status}
                onChange={(e) => setMasterPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && masterPassword) void unlock();
                }}
              />
            </div>
            <div className="password-managers-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={busy || !status || !masterPassword}
                onClick={() => void unlock()}
              >
                Unlock
              </button>
            </div>
          </>
        )}
      </section>

      <section className="settings-section" aria-label="Test a reference">
        <h3>Test a reference</h3>
        <p className="settings-description">
          Checks that CoWork can read a reference. The value itself is not shown.
        </p>
        <div className="settings-field">
          <label htmlFor="secret-reference-test">Reference</label>
          <input
            id="secret-reference-test"
            type="text"
            className="settings-input"
            autoComplete="off"
            placeholder="op://Private/OpenAI/credential"
            value={reference}
            disabled={busy}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <div className="password-managers-actions">
          <button
            type="button"
            className="button-secondary"
            disabled={busy || !reference.trim()}
            onClick={() => void testReference()}
          >
            {busy ? "Testing…" : "Test"}
          </button>
        </div>
        {test ? (
          test.ok ? (
            <p className="settings-description" role="status">
              Read a value of {test.length} characters from{" "}
              {SECRET_REFERENCE_SOURCE_LABELS[test.source]}.
            </p>
          ) : (
            <div className="settings-error" role="alert">
              {test.error}
            </div>
          )
        ) : null}
      </section>
    </div>
  );
}
