import { useState, useEffect, useCallback } from "react";
import type {
  ConwaySetupStatus,
  ConwaySettings as ConwaySettingsType,
  ConwayCreditHistoryEntry,
} from "../../shared/types";

type SetupStep = "idle" | "installing" | "initializing" | "connecting" | "done" | "error";

const ipcAPI = window.electronAPI;

export function ConwaySettings() {
  const [status, setStatus] = useState<ConwaySetupStatus | null>(null);
  const [settings, setSettings] = useState<ConwaySettingsType | null>(null);
  const [creditHistory, setCreditHistory] = useState<ConwayCreditHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupStep, setSetupStep] = useState<SetupStep>("idle");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, settingsRes] = await Promise.all([
        ipcAPI.conwayGetStatus(),
        ipcAPI.conwayGetSettings(),
      ]);
      setStatus(statusRes);
      setSettings(settingsRes);

      if (statusRes?.state === "ready" && statusRes?.mcpConnectionStatus === "connected") {
        const history = await ipcAPI.conwayGetCreditHistory();
        setCreditHistory(history || []);
      }
    } catch (error) {
      console.error("Failed to load Conway data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const unsubscribe = ipcAPI.onConwayStatusChange?.((newStatus: ConwaySetupStatus) => {
      // Only accept push updates when not mid-setup (setup manages its own state)
      if (newStatus?.state === "ready") {
        setStatus(newStatus);
      }
    });
    return () => unsubscribe?.();
  }, [loadData]);

  const handleSetup = async () => {
    setSetupStep("installing");
    setSetupError(null);
    try {
      const result = await ipcAPI.conwaySetup();
      if (result?.state === "error") {
        setSetupStep("error");
        setSetupError(result.error || "Setup failed");
      } else {
        setSetupStep("done");
        // Reload full data so status, wallet, and history are all fresh
        await loadData();
      }
    } catch (error: any) {
      setSetupStep("error");
      setSetupError(error.message || String(error));
    }
  };

  const handleConnect = async () => {
    try {
      await ipcAPI.conwayConnect();
      await loadData();
    } catch (error: any) {
      console.error("Connect failed:", error);
    }
  };

  const handleDisconnect = async () => {
    try {
      await ipcAPI.conwayDisconnect();
      await loadData();
    } catch (error: any) {
      console.error("Disconnect failed:", error);
    }
  };

  const handleReset = async () => {
    if (
      !confirm(
        "This will disconnect the Conway MCP server and clear app settings.\n\n" +
          "Your wallet private key remains safely encrypted in CoWork OS's database " +
          "and the file at ~/.conway/wallet.json will not be deleted.\n\n" +
          "You can re-enable Conway Terminal at any time and your wallet will be restored.\n\n" +
          "Continue?",
      )
    )
      return;
    try {
      await ipcAPI.conwayReset();
      setSetupStep("idle");
      setCreditHistory([]);
      await loadData();
    } catch (error: any) {
      console.error("Reset failed:", error);
    }
  };

  const handleSettingChange = async <K extends keyof ConwaySettingsType>(
    key: K,
    value: ConwaySettingsType[K],
  ) => {
    if (!settings) return;
    const updated: ConwaySettingsType = { ...settings, [key]: value };
    setSettings(updated);
    try {
      await ipcAPI.conwaySaveSettings(updated);
    } catch (error) {
      console.error("Failed to save Conway settings:", error);
    }
  };

  const handleToolCategoryChange = async (
    category: keyof ConwaySettingsType["enabledToolCategories"],
    enabled: boolean,
  ) => {
    if (!settings) return;
    const updated: ConwaySettingsType = {
      ...settings,
      enabledToolCategories: {
        ...settings.enabledToolCategories,
        [category]: enabled,
      },
    };
    setSettings(updated);
    try {
      await ipcAPI.conwaySaveSettings(updated);
    } catch (error) {
      console.error("Failed to save Conway settings:", error);
    }
  };

  const copyAddress = () => {
    if (status?.walletInfo?.address) {
      navigator.clipboard.writeText(String(status.walletInfo.address));
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    }
  };

  const truncateAddress = (addr: string) => {
    if (addr.length <= 14) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
  };

  const getStatusDot = (connStatus?: string) => {
    switch (connStatus) {
      case "connected":
        return "conway-status-dot connected";
      case "connecting":
        return "conway-status-dot connecting";
      case "error":
        return "conway-status-dot error";
      default:
        return "conway-status-dot disconnected";
    }
  };

  if (loading) {
    return (
      <div className="conway-settings-panel">
        <div className="settings-loading">Loading Conway Terminal...</div>
      </div>
    );
  }

  const isReady = status?.state === "ready";
  const isConnected = status?.mcpConnectionStatus === "connected";

  return (
    <div className="conway-settings-panel">
      <div className="conway-header">
        <h2>Conway Terminal</h2>
        <p className="settings-description">
          Permissionless cloud compute, domains, and payments for AI agents. No API keys, no logins
          — agents get crypto wallets automatically.
        </p>
      </div>

      {/* Setup Section */}
      {!isReady && setupStep !== "done" && (
        <div className="conway-setup-section">
          <div className="conway-setup-info">
            <h3>Get Started</h3>
            <p>Conway Terminal gives your agents access to:</p>
            <ul className="conway-feature-list">
              <li>
                <strong>Cloud Sandboxes</strong> — Spin up Linux VMs, run code, expose services
              </li>
              <li>
                <strong>Domain Registration</strong> — Search, register, and manage domains with DNS
              </li>
              <li>
                <strong>AI Inference</strong> — Route to Claude, GPT, Gemini, Kimi, Qwen
              </li>
              <li>
                <strong>Crypto Wallet</strong> — Autonomous payments via USDC (x402 protocol)
              </li>
            </ul>
          </div>

          {setupStep === "idle" && (
            <button className="button-primary" onClick={handleSetup}>
              Enable Conway Terminal
            </button>
          )}

          {(setupStep === "installing" ||
            setupStep === "initializing" ||
            setupStep === "connecting") && (
            <div className="conway-setup-progress">
              <div
                className={`conway-setup-step ${setupStep === "installing" ? "active" : "completed"}`}
              >
                <span className="step-indicator">{setupStep === "installing" ? "..." : "✓"}</span>
                Installing conway-terminal
              </div>
              <div
                className={`conway-setup-step ${setupStep === "initializing" ? "active" : setupStep === "connecting" ? "completed" : "pending"}`}
              >
                <span className="step-indicator">
                  {setupStep === "initializing" ? "..." : setupStep === "connecting" ? "✓" : "○"}
                </span>
                Generating wallet
              </div>
              <div
                className={`conway-setup-step ${setupStep === "connecting" ? "active" : "pending"}`}
              >
                <span className="step-indicator">{setupStep === "connecting" ? "..." : "○"}</span>
                Connecting MCP server
              </div>
            </div>
          )}

          {setupStep === "error" && (
            <div className="conway-error">
              <p>{setupError}</p>
              <button className="button-secondary" onClick={handleSetup}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {/* Status & Connection */}
      {isReady && (
        <>
          <div className="conway-status-section">
            <div className="conway-status-row">
              <span className={getStatusDot(status?.mcpConnectionStatus)} />
              <span className="conway-status-label">
                {isConnected ? "Connected" : status?.mcpConnectionStatus || "Disconnected"}
              </span>
              {isConnected && status?.toolCount ? (
                <span className="conway-tool-count">{status.toolCount} tools</span>
              ) : null}
              <div className="conway-status-actions">
                {isConnected ? (
                  <button className="button-secondary button-small" onClick={handleDisconnect}>
                    Disconnect
                  </button>
                ) : (
                  <button className="button-primary button-small" onClick={handleConnect}>
                    Connect
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Wallet Section */}
          <div className="conway-wallet-card">
            <h3>Wallet</h3>
            {status?.walletInfo ? (
              <div className="conway-wallet-info">
                <div className="conway-wallet-address-row">
                  <code className="conway-wallet-address">
                    {truncateAddress(String(status.walletInfo.address || ""))}
                  </code>
                  <button
                    type="button"
                    className="conway-copy-btn"
                    onClick={copyAddress}
                    title="Copy address"
                    aria-label="Copy wallet address to clipboard"
                  >
                    {copiedAddress ? "Copied" : "Copy"}
                  </button>
                  <span className="conway-network-badge">
                    {String(status.walletInfo.network || "")}
                  </span>
                </div>
                <div className="conway-balance-row">
                  <span className="conway-balance-display">
                    {String(status.balance?.balance || "0.00")}
                  </span>
                  <span className="conway-balance-currency">USDC</span>
                </div>
                <p className="conway-wallet-hint">
                  Send USDC (Base network) to this address to fund your agents.
                </p>
                {status?.walletFileExists === false && (
                  <div className="conway-wallet-warning">
                    <p>
                      Wallet file (<code>~/.conway/wallet.json</code>) not found on disk. Your
                      private key is safely stored in CoWork OS's encrypted database and can be
                      restored.
                    </p>
                    <button
                      type="button"
                      className="button-primary button-small"
                      onClick={async () => {
                        const result = await ipcAPI.conwayWalletRestore();
                        if (result?.success) {
                          await loadData();
                        }
                      }}
                    >
                      Restore Wallet File
                    </button>
                  </div>
                )}
                <div className="conway-wallet-safety">
                  <strong>Wallet Security</strong>
                  <p>
                    Your private key is encrypted and stored in CoWork OS's secure database (backed
                    by your OS keychain). The plaintext file at <code>~/.conway/wallet.json</code>{" "}
                    is written for Conway's MCP server and can be restored automatically if deleted.
                    CoWork OS never transmits your private key.
                  </p>
                </div>
              </div>
            ) : (
              <p className="conway-wallet-hint">
                {isConnected ? "Loading wallet info..." : "Connect to view wallet details."}
              </p>
            )}
          </div>

          {/* How It Works */}
          <div className="conway-how-it-works">
            <h3>How It Works</h3>
            <div className="conway-info-grid">
              <div className="conway-info-item">
                <strong>No API keys needed</strong>
                <p>
                  Conway Terminal is permissionless. A crypto wallet is generated locally on your
                  machine during setup — no accounts, logins, or API keys required. Your private key
                  is encrypted and stored securely using your OS keychain.
                </p>
              </div>
              <div className="conway-info-item">
                <strong>Pay-per-use with USDC</strong>
                <p>
                  Services are paid with USDC stablecoin on the Base network via the x402 protocol.
                  Fund your wallet by sending USDC (Base) to the address above. You can get USDC
                  from Coinbase, MetaMask, or bridge from Ethereum at bridge.base.org.
                </p>
              </div>
              <div className="conway-info-item">
                <strong>Agents spend autonomously</strong>
                <p>
                  Once funded, agents can autonomously use Conway tools — spin up sandboxes,
                  register domains, call AI models — and pay directly from the wallet. You control
                  which tool categories are enabled below.
                </p>
              </div>
            </div>
          </div>

          {/* Credit History */}
          {creditHistory.length > 0 && (
            <div className="conway-history-section">
              <h3>Recent Transactions</h3>
              <div className="conway-credit-history">
                <table className="conway-history-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Amount</th>
                      <th>Service</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditHistory.slice(0, 20).map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <span className={`conway-tx-type ${entry.type}`}>
                            {entry.type === "credit" ? "+" : "-"}
                          </span>
                        </td>
                        <td className={`conway-tx-amount ${entry.type}`}>
                          {entry.type === "credit" ? "+" : "-"}
                          {String(entry.amount)} USDC
                        </td>
                        <td>{String(entry.service || "")}</td>
                        <td className="conway-tx-desc">{String(entry.description || "")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Settings */}
          <div className="conway-config-section">
            <h3>Configuration</h3>
            <div className="conway-setting-row">
              <label>
                <input
                  type="checkbox"
                  checked={settings?.autoConnect ?? true}
                  onChange={(e) => handleSettingChange("autoConnect", e.target.checked)}
                />
                Auto-connect on app startup
              </label>
            </div>
            <div className="conway-setting-row">
              <label>
                <input
                  type="checkbox"
                  checked={settings?.showWalletInSidebar ?? true}
                  onChange={(e) => handleSettingChange("showWalletInSidebar", e.target.checked)}
                />
                Show wallet balance in sidebar
              </label>
            </div>

            <h4>Tool Categories</h4>
            <p className="settings-description">
              Control which Conway capabilities your agents can use.
            </p>
            <div className="conway-tool-categories">
              {[
                {
                  key: "sandbox" as const,
                  label: "Cloud Sandboxes",
                  desc: "Spin up Linux VMs, run code, expose ports, deploy services",
                },
                {
                  key: "inference" as const,
                  label: "AI Inference",
                  desc: "Route to Claude, GPT, Gemini, Kimi, Qwen and other models",
                },
                {
                  key: "domains" as const,
                  label: "Domain Management",
                  desc: "Search, register, and manage domains with DNS records",
                },
                {
                  key: "payments" as const,
                  label: "Payments & Wallet",
                  desc: "USDC transfers, x402 machine-to-machine payments",
                },
              ].map((cat) => (
                <div key={cat.key} className="conway-setting-row conway-category-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={settings?.enabledToolCategories?.[cat.key] ?? true}
                      onChange={(e) => handleToolCategoryChange(cat.key, e.target.checked)}
                    />
                    <span className="conway-category-label">
                      <span className="conway-category-name">{cat.label}</span>
                      <span className="conway-category-desc">{cat.desc}</span>
                    </span>
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Danger Zone */}
          <div className="conway-danger-section">
            <h3>Reset</h3>
            <p className="settings-description">
              Disconnects the Conway MCP server and clears app settings. Your wallet private key
              stays encrypted in CoWork OS's secure database and can be restored.
            </p>
            <button className="button-danger" onClick={handleReset}>
              Reset Conway Terminal
            </button>
          </div>
        </>
      )}
    </div>
  );
}
