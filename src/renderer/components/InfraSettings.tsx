import { useState, useEffect, useCallback } from "react";
import type { InfraSettings as InfraSettingsType, InfraStatus } from "../../shared/types";

type SetupStep = "idle" | "setting_up" | "done" | "error";

const ipcAPI = window.electronAPI;

export function InfraSettings() {
  const [status, setStatus] = useState<InfraStatus | null>(null);
  const [settings, setSettings] = useState<InfraSettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupStep, setSetupStep] = useState<SetupStep>("idle");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [showE2bKey, setShowE2bKey] = useState(false);
  const [showDomainKey, setShowDomainKey] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, settingsRes] = await Promise.all([
        ipcAPI.infraGetStatus(),
        ipcAPI.infraGetSettings(),
      ]);
      setStatus(statusRes);
      setSettings(settingsRes);
    } catch (error) {
      console.error("Failed to load infrastructure data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const unsubscribe = ipcAPI.onInfraStatusChange?.((newStatus: InfraStatus) => {
      setStatus(newStatus);
    });
    return () => unsubscribe?.();
  }, [loadData]);

  const handleSetup = async () => {
    setSetupStep("setting_up");
    setSetupError(null);
    try {
      const result = await ipcAPI.infraSetup();
      if (result?.error) {
        setSetupStep("error");
        setSetupError(result.error);
      } else {
        setSetupStep("done");
        await loadData();
      }
    } catch (error: Any) {
      setSetupStep("error");
      setSetupError(error.message || String(error));
    }
  };

  const handleReset = async () => {
    if (
      !confirm(
        "This will clear all infrastructure settings and provider configurations.\n\n" +
          "Your wallet private key remains safely encrypted in CoWork OS's secure database.\n\n" +
          "You can re-enable Infrastructure at any time and your wallet will be restored.\n\n" +
          "Continue?",
      )
    )
      return;
    try {
      await ipcAPI.infraReset();
      setSetupStep("idle");
      await loadData();
    } catch (error: Any) {
      console.error("Reset failed:", error);
    }
  };

  const handleSettingChange = async <K extends keyof InfraSettingsType>(
    key: K,
    value: InfraSettingsType[K],
  ) => {
    if (!settings) return;
    const updated: InfraSettingsType = { ...settings, [key]: value };
    setSettings(updated);
    try {
      await ipcAPI.infraSaveSettings(updated);
    } catch (error) {
      console.error("Failed to save infrastructure settings:", error);
    }
  };

  const handleNestedChange = async (
    section: "e2b" | "domains" | "wallet" | "payments" | "enabledCategories",
    key: string,
    value: Any,
  ) => {
    if (!settings) return;
    const updated: InfraSettingsType = {
      ...settings,
      [section]: {
        ...(settings[section] as Any),
        [key]: value,
      },
    };
    setSettings(updated);
    try {
      await ipcAPI.infraSaveSettings(updated);
    } catch (error) {
      console.error("Failed to save infrastructure settings:", error);
    }
  };

  const copyAddress = () => {
    if (status?.wallet?.address) {
      navigator.clipboard.writeText(status.wallet.address);
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    }
  };

  const truncateAddress = (addr: string) => {
    if (addr.length <= 14) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
  };

  const getProviderDot = (providerStatus?: string) => {
    switch (providerStatus) {
      case "connected":
        return "infra-status-dot connected";
      case "error":
        return "infra-status-dot error";
      case "not_configured":
        return "infra-status-dot disconnected";
      default:
        return "infra-status-dot disconnected";
    }
  };

  if (loading) {
    return (
      <div className="infra-settings-panel">
        <div className="settings-loading">Loading Infrastructure...</div>
      </div>
    );
  }

  const isEnabled = status?.enabled || false;

  return (
    <div className="infra-settings-panel">
      <div className="infra-header">
        <h2>Infrastructure</h2>
        <p className="settings-description">
          Native cloud compute, domains, and payments for AI agents. Sandboxes via E2B, domains via
          Namecheap, payments via x402 protocol (USDC on Base).
        </p>
      </div>

      {/* Setup Section */}
      {!isEnabled && setupStep !== "done" && (
        <div className="infra-setup-section">
          <div className="infra-setup-info">
            <h3>Get Started</h3>
            <p>Infrastructure gives your agents access to:</p>
            <ul className="infra-feature-list">
              <li>
                <strong>Cloud Sandboxes</strong> — Spin up Linux VMs, run code, expose services (via
                E2B)
              </li>
              <li>
                <strong>Domain Registration</strong> — Search, register, and manage domains with DNS
                (via Namecheap)
              </li>
              <li>
                <strong>Crypto Wallet</strong> — Auto-generated USDC wallet on Base network
              </li>
              <li>
                <strong>x402 Payments</strong> — Machine-to-machine HTTP payments
              </li>
            </ul>
          </div>

          {setupStep === "idle" && (
            <button className="button-primary" onClick={handleSetup}>
              Enable Infrastructure
            </button>
          )}

          {setupStep === "setting_up" && (
            <div className="infra-setup-progress">
              <div className="infra-setup-step active">
                <span className="step-indicator">...</span>
                Setting up wallet and providers
              </div>
            </div>
          )}

          {setupStep === "error" && (
            <div className="infra-error">
              <p>{setupError}</p>
              <button className="button-secondary" onClick={handleSetup}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main content when enabled */}
      {isEnabled && (
        <>
          {/* Provider Status */}
          <div className="infra-status-section">
            <h3>Provider Status</h3>
            <div className="infra-provider-grid">
              {[
                { key: "e2b", label: "E2B Sandboxes", status: status?.providers?.e2b },
                { key: "domains", label: "Namecheap Domains", status: status?.providers?.domains },
                { key: "wallet", label: "Wallet", status: status?.providers?.wallet },
              ].map((p) => (
                <div key={p.key} className="infra-provider-row">
                  <span className={getProviderDot(p.status)} />
                  <span className="infra-provider-label">{p.label}</span>
                  <span className="infra-provider-status">
                    {p.status === "connected"
                      ? "Connected"
                      : p.status === "not_configured"
                        ? "Not configured"
                        : p.status || "Unknown"}
                  </span>
                </div>
              ))}
            </div>
            {(status?.activeSandboxes ?? 0) > 0 && (
              <p className="infra-active-sandboxes">
                {status!.activeSandboxes} active sandbox{status!.activeSandboxes !== 1 ? "es" : ""}
              </p>
            )}
          </div>

          {/* Wallet Section */}
          <div className="infra-wallet-card">
            <h3>Wallet</h3>
            {status?.wallet ? (
              <div className="infra-wallet-info">
                <div className="infra-wallet-address-row">
                  <code className="infra-wallet-address">
                    {truncateAddress(status.wallet.address)}
                  </code>
                  <button
                    type="button"
                    className="infra-copy-btn"
                    onClick={copyAddress}
                    title="Copy address"
                    aria-label="Copy wallet address to clipboard"
                  >
                    {copiedAddress ? "Copied" : "Copy"}
                  </button>
                  <span className="infra-network-badge">{status.wallet.network}</span>
                </div>
                <div className="infra-balance-row">
                  <span className="infra-balance-display">
                    {status.wallet.balanceUsdc || "0.00"}
                  </span>
                  <span className="infra-balance-currency">USDC</span>
                </div>
                <p className="infra-wallet-hint">
                  Send USDC (Base network) to this address to fund your agents.
                </p>
                <div className="infra-wallet-safety">
                  <strong>Wallet Security</strong>
                  <p>
                    Your private key is encrypted and stored in CoWork OS's secure database (backed
                    by your OS keychain). CoWork OS never transmits your private key.
                  </p>
                </div>
              </div>
            ) : (
              <p className="infra-wallet-hint">
                Wallet will be generated when you enable infrastructure.
              </p>
            )}
          </div>

          {/* E2B Configuration */}
          <div className="infra-config-section">
            <h3>E2B Cloud Sandboxes</h3>
            <p className="settings-description">
              Cloud Linux VMs for running code and deploying services. Get a free API key at{" "}
              <a href="https://e2b.dev" target="_blank" rel="noopener noreferrer">
                e2b.dev
              </a>{" "}
              ($100 free credits, no credit card needed).
            </p>
            <div className="infra-setting-row">
              <label>API Key</label>
              <div className="infra-key-input">
                <input
                  type={showE2bKey ? "text" : "password"}
                  value={settings?.e2b?.apiKey || ""}
                  onChange={(e) => handleNestedChange("e2b", "apiKey", e.target.value)}
                  placeholder="e2b_..."
                  className="settings-input"
                />
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => setShowE2bKey(!showE2bKey)}
                >
                  {showE2bKey ? "Hide" : "Show"}
                </button>
              </div>
            </div>
          </div>

          {/* Domain Configuration */}
          <div className="infra-config-section">
            <h3>Domain Registration (Namecheap)</h3>
            <p className="settings-description">
              Register domains and manage DNS records. Requires a Namecheap account with API access.
            </p>
            <div className="infra-setting-row">
              <label>API Key</label>
              <div className="infra-key-input">
                <input
                  type={showDomainKey ? "text" : "password"}
                  value={settings?.domains?.apiKey || ""}
                  onChange={(e) => handleNestedChange("domains", "apiKey", e.target.value)}
                  placeholder="Namecheap API key"
                  className="settings-input"
                />
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => setShowDomainKey(!showDomainKey)}
                >
                  {showDomainKey ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <div className="infra-setting-row">
              <label>Username</label>
              <input
                type="text"
                value={settings?.domains?.username || ""}
                onChange={(e) => handleNestedChange("domains", "username", e.target.value)}
                placeholder="Namecheap username"
                className="settings-input"
              />
            </div>
            <div className="infra-setting-row">
              <label>Client IP</label>
              <input
                type="text"
                value={settings?.domains?.clientIp || ""}
                onChange={(e) => handleNestedChange("domains", "clientIp", e.target.value)}
                placeholder="Your whitelisted IP address"
                className="settings-input"
              />
            </div>
          </div>

          {/* Payment Configuration */}
          <div className="infra-config-section">
            <h3>Payments</h3>
            <p className="settings-description">
              x402 machine-to-machine payment protocol. USDC on Base network.
            </p>
            <div className="infra-setting-row">
              <label>
                <input
                  type="checkbox"
                  checked={settings?.payments?.requireApproval ?? true}
                  onChange={(e) =>
                    handleNestedChange("payments", "requireApproval", e.target.checked)
                  }
                />
                Require approval before payments
              </label>
            </div>
          </div>

          {/* General Settings */}
          <div className="infra-config-section">
            <h3>General</h3>
            <div className="infra-setting-row">
              <label>
                <input
                  type="checkbox"
                  checked={settings?.showWalletInSidebar ?? true}
                  onChange={(e) => handleSettingChange("showWalletInSidebar", e.target.checked)}
                />
                Show wallet balance in sidebar
              </label>
            </div>
          </div>

          {/* Tool Categories */}
          <div className="infra-config-section">
            <h3>Tool Categories</h3>
            <p className="settings-description">
              Control which infrastructure capabilities your agents can use.
            </p>
            <div className="infra-tool-categories">
              {[
                {
                  key: "sandbox" as const,
                  label: "Cloud Sandboxes",
                  desc: "Create and manage cloud Linux VMs via E2B",
                },
                {
                  key: "domains" as const,
                  label: "Domain Management",
                  desc: "Search, register, and manage domains with DNS records",
                },
                {
                  key: "payments" as const,
                  label: "Payments & Wallet",
                  desc: "x402 payments, wallet balance, USDC transfers",
                },
              ].map((cat) => (
                <div key={cat.key} className="infra-setting-row infra-category-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={settings?.enabledCategories?.[cat.key] ?? true}
                      onChange={(e) =>
                        handleNestedChange("enabledCategories", cat.key, e.target.checked)
                      }
                    />
                    <span className="infra-category-label">
                      <span className="infra-category-name">{cat.label}</span>
                      <span className="infra-category-desc">{cat.desc}</span>
                    </span>
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* How It Works */}
          <div className="infra-how-it-works">
            <h3>How It Works</h3>
            <div className="infra-info-grid">
              <div className="infra-info-item">
                <strong>E2B Sandboxes</strong>
                <p>
                  Cloud Linux VMs powered by E2B. Get $100 free credits at e2b.dev. Agents can spin
                  up sandboxes, run commands, write files, and expose ports. Sandboxes auto-expire
                  after their timeout.
                </p>
              </div>
              <div className="infra-info-item">
                <strong>Crypto Wallet</strong>
                <p>
                  A crypto wallet is generated locally during setup. Your private key is encrypted
                  using your OS keychain and never leaves your machine. Fund it with USDC on Base
                  from Coinbase, MetaMask, or bridge at bridge.base.org.
                </p>
              </div>
              <div className="infra-info-item">
                <strong>x402 Payments</strong>
                <p>
                  The x402 protocol enables HTTP-native machine-to-machine payments. When agents
                  encounter a 402 Payment Required response, they sign a payment intent and retry.
                  All payments require your approval.
                </p>
              </div>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="infra-danger-section">
            <h3>Reset</h3>
            <p className="settings-description">
              Clears all infrastructure settings and provider configurations. Your wallet private
              key stays encrypted in CoWork OS's secure database and can be restored.
            </p>
            <button className="button-danger" onClick={handleReset}>
              Reset Infrastructure
            </button>
          </div>
        </>
      )}
    </div>
  );
}
