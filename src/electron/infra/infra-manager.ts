/**
 * Infrastructure Manager
 *
 * Orchestrator singleton for all native infrastructure capabilities:
 * cloud sandboxes (E2B), domains (Namecheap), wallet, x402 payments.
 *
 * All functionality is built-in as native agent tools, no MCP subprocess.
 */

import { InfraStatus, InfraSettings, WalletInfo, DEFAULT_INFRA_SETTINGS } from "../../shared/types";
import { InfraSettingsManager } from "./infra-settings";
import { E2BSandboxProvider } from "./providers/e2b-sandbox";
import { NamecheapDomainsProvider } from "./providers/namecheap-domains";
import { LocalWalletProvider } from "./providers/local-wallet-provider";
import { CoinbaseAgenticWalletProvider } from "./providers/coinbase-agentic-wallet-provider";
import { WalletProvider, WalletProviderKind } from "./providers/wallet-provider";

export class InfraManager {
  private static instance: InfraManager | null = null;

  private sandboxProvider = new E2BSandboxProvider();
  private domainsProvider = new NamecheapDomainsProvider();
  private walletProvider: WalletProvider = new LocalWalletProvider();
  private walletProviderKind: WalletProviderKind = "local";
  private initialized = false;
  private cachedBalance: string = "0.00";
  private cachedWalletAddress: string | null = null;
  private cachedWalletNetwork: string = "base";
  private walletProviderConnected = false;
  private walletProviderError: string | null = null;
  private balancePollInterval: ReturnType<typeof setInterval> | null = null;

  private constructor() {}

  static getInstance(): InfraManager {
    if (!this.instance) {
      this.instance = new InfraManager();
    }
    return this.instance;
  }

  /**
   * Initialize on app startup
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    console.log("[InfraManager] Initializing...");

    // Initialize settings manager
    InfraSettingsManager.initialize();
    const settings = InfraSettingsManager.loadSettings();

    // Configure providers from settings
    await this.applySettings(settings);

    // Start balance polling if wallet exists
    if (this.walletProviderConnected && settings.enabled) {
      this.startBalancePolling();
    }

    console.log("[InfraManager] Initialized");
  }

  /**
   * Apply settings to providers
   */
  async applySettings(settings: InfraSettings): Promise<void> {
    // E2B
    if (settings.e2b.apiKey) {
      this.sandboxProvider.setApiKey(settings.e2b.apiKey);
    }

    // Namecheap
    if (settings.domains.apiKey && settings.domains.username && settings.domains.clientIp) {
      this.domainsProvider.setConfig({
        apiKey: settings.domains.apiKey,
        username: settings.domains.username,
        clientIp: settings.domains.clientIp,
      });
    }

    await this.configureWalletProvider(settings);

    if (!settings.enabled || !this.walletProviderConnected) {
      this.stopBalancePolling();
      return;
    }

    this.startBalancePolling();
  }

  // === Status ===

  getStatus(): InfraStatus {
    const settings = InfraSettingsManager.loadSettings();
    const walletStatus = this.getWalletProviderStatus(settings);

    return {
      enabled: settings.enabled,
      wallet: this.walletProviderConnected && this.cachedWalletAddress
        ? {
            address: this.cachedWalletAddress,
            network: this.cachedWalletNetwork,
            balanceUsdc: this.cachedBalance,
          }
        : undefined,
      walletFileExists: undefined, // We no longer write wallet files
      providers: {
        e2b: this.sandboxProvider.hasApiKey() ? "connected" : "not_configured",
        domains: this.domainsProvider.isConfigured() ? "connected" : "not_configured",
        wallet: walletStatus,
      },
      activeSandboxes: this.sandboxProvider.list().length,
      ...(this.walletProviderError ? { error: this.walletProviderError } : {}),
    };
  }

  // === Setup ===

  /**
   * Initial setup — generate wallet if needed
   */
  async setup(): Promise<InfraStatus> {
    // Enable infra
    const settings = InfraSettingsManager.loadSettings();
    if (!settings.enabled) {
      settings.enabled = true;
      InfraSettingsManager.saveSettings(settings);
    }

    await this.applySettings(settings);
    if (this.canProvisionWalletOnSetup(settings)) {
      await this.walletProvider.ensureWallet();
    }
    await this.refreshWalletSnapshot({ fetchBalance: true });

    if (settings.enabled && this.walletProviderConnected) {
      this.startBalancePolling();
    } else {
      this.stopBalancePolling();
    }

    return this.getStatus();
  }

  /**
   * Reset infrastructure — clear settings, disconnect providers
   */
  async reset(): Promise<void> {
    this.stopBalancePolling();
    await this.sandboxProvider.cleanup();

    // Reset settings to defaults
    const resetSettings: InfraSettings = {
      ...DEFAULT_INFRA_SETTINGS,
      e2b: { ...DEFAULT_INFRA_SETTINGS.e2b },
      domains: { ...DEFAULT_INFRA_SETTINGS.domains },
      wallet: {
        ...DEFAULT_INFRA_SETTINGS.wallet,
        coinbase: { ...DEFAULT_INFRA_SETTINGS.wallet.coinbase },
      },
      payments: {
        ...DEFAULT_INFRA_SETTINGS.payments,
        allowedHosts: [...DEFAULT_INFRA_SETTINGS.payments.allowedHosts],
      },
      enabledCategories: { ...DEFAULT_INFRA_SETTINGS.enabledCategories },
    };
    InfraSettingsManager.saveSettings(resetSettings);
    InfraSettingsManager.clearCache();

    // Re-configure providers (will be empty)
    this.sandboxProvider = new E2BSandboxProvider();
    this.domainsProvider = new NamecheapDomainsProvider();
    this.walletProvider = new LocalWalletProvider();
    this.walletProviderKind = "local";
    await this.walletProvider.initialize();
    await this.walletProvider.applySettings(resetSettings);
    await this.refreshWalletSnapshot({ fetchBalance: false });

    console.log("[InfraManager] Reset complete");
  }

  // === Wallet ===

  getWalletInfo(): WalletInfo | null {
    if (!this.walletProviderConnected || !this.cachedWalletAddress) return null;
    return {
      address: this.cachedWalletAddress,
      network: this.cachedWalletNetwork,
      balanceUsdc: this.cachedBalance,
    };
  }

  async getWalletInfoWithBalance(): Promise<WalletInfo | null> {
    if (!this.walletProviderConnected || !this.cachedWalletAddress) return null;
    const balance = await this.getWalletBalance();
    return {
      address: this.cachedWalletAddress,
      network: this.cachedWalletNetwork,
      balanceUsdc: balance,
    };
  }

  async getWalletBalance(): Promise<string> {
    try {
      if (!(await this.walletProvider.hasWallet())) {
        this.walletProviderError = null;
        this.walletProviderConnected = false;
        this.cachedWalletAddress = null;
        this.cachedBalance = "0.00";
        return "0.00";
      }
      this.cachedBalance = await this.walletProvider.getBalanceUsdc();
      this.walletProviderError = null;
      this.walletProviderConnected = true;
      return this.cachedBalance;
    } catch (error) {
      console.warn("[InfraManager] Balance fetch failed:", error);
      return this.cachedBalance;
    }
  }

  // === Sandbox operations ===

  async sandboxCreate(opts?: { name?: string; timeoutMs?: number; envs?: Record<string, string> }) {
    return this.sandboxProvider.create(opts);
  }

  async sandboxExec(sandboxId: string, command: string, opts?: { background?: boolean }) {
    return this.sandboxProvider.exec(sandboxId, command, opts);
  }

  async sandboxWriteFile(sandboxId: string, filePath: string, content: string) {
    return this.sandboxProvider.writeFile(sandboxId, filePath, content);
  }

  async sandboxReadFile(sandboxId: string, filePath: string) {
    return this.sandboxProvider.readFile(sandboxId, filePath);
  }

  sandboxList() {
    return this.sandboxProvider.list();
  }

  async sandboxDelete(sandboxId: string) {
    return this.sandboxProvider.delete(sandboxId);
  }

  sandboxGetUrl(sandboxId: string, port: number) {
    return this.sandboxProvider.getUrl(sandboxId, port);
  }

  // === Domain operations ===

  async domainSearch(query: string, tlds?: string[]) {
    return this.domainsProvider.search(query, tlds);
  }

  async domainRegister(domain: string, years?: number) {
    return this.domainsProvider.register(domain, years);
  }

  async domainList() {
    return this.domainsProvider.listDomains();
  }

  async domainDnsList(domain: string) {
    return this.domainsProvider.getDnsRecords(domain);
  }

  async domainDnsAdd(domain: string, record: Any) {
    return this.domainsProvider.addDnsRecord(domain, record);
  }

  async domainDnsDelete(domain: string, type: string, name: string) {
    return this.domainsProvider.deleteDnsRecord(domain, type, name);
  }

  // === x402 operations ===

  async x402Check(url: string) {
    return this.walletProvider.x402Check(url);
  }

  async x402Fetch(url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }) {
    return this.walletProvider.x402Fetch({
      url,
      method: opts?.method,
      body: opts?.body,
      headers: opts?.headers,
    });
  }

  // === Cleanup ===

  async cleanup(): Promise<void> {
    this.stopBalancePolling();
    await this.sandboxProvider.cleanup();
  }

  // === Private helpers ===

  private startBalancePolling(): void {
    if (this.balancePollInterval) return;

    // Initial fetch
    this.getWalletBalance().catch(() => {});

    // Poll every 5 minutes
    this.balancePollInterval = setInterval(() => {
      this.getWalletBalance().catch(() => {});
    }, 5 * 60_000);
  }

  private stopBalancePolling(): void {
    if (this.balancePollInterval) {
      clearInterval(this.balancePollInterval);
      this.balancePollInterval = null;
    }
  }

  private async configureWalletProvider(settings: InfraSettings): Promise<void> {
    const desiredKind: WalletProviderKind =
      settings.wallet.provider === "coinbase_agentic" ? "coinbase_agentic" : "local";

    if (this.walletProviderKind !== desiredKind) {
      this.walletProvider = this.createWalletProvider(desiredKind);
      this.walletProviderKind = desiredKind;
    }

    await this.walletProvider.initialize();
    await this.walletProvider.applySettings(settings);
    await this.refreshWalletSnapshot({ fetchBalance: settings.enabled });
  }

  private createWalletProvider(kind: WalletProviderKind): WalletProvider {
    if (kind === "coinbase_agentic") {
      return new CoinbaseAgenticWalletProvider();
    }
    return new LocalWalletProvider();
  }

  private async refreshWalletSnapshot(opts?: { fetchBalance?: boolean }): Promise<void> {
    try {
      const status = await this.walletProvider.getStatus();
      this.walletProviderConnected = status.connected;
      this.cachedWalletAddress = status.address || null;
      this.cachedWalletNetwork = status.network || "base";
      this.walletProviderError = null;

      if (typeof status.balanceUsdc === "string") {
        this.cachedBalance = status.balanceUsdc;
      } else if (opts?.fetchBalance && this.walletProviderConnected) {
        this.cachedBalance = await this.walletProvider.getBalanceUsdc();
      }
    } catch (error) {
      this.walletProviderConnected = false;
      this.cachedWalletAddress = null;
      this.walletProviderError = String(error);
    }
  }

  private getWalletProviderStatus(settings: InfraSettings): "connected" | "disconnected" | "error" | "not_configured" {
    if (this.walletProviderError) return "error";
    if (this.walletProviderConnected) return "connected";
    if (!settings.wallet.enabled) return "not_configured";
    if (settings.wallet.provider === "coinbase_agentic" && !settings.wallet.coinbase.enabled) {
      return "not_configured";
    }
    if (settings.wallet.provider === "coinbase_agentic" && !settings.wallet.coinbase.signerEndpoint) {
      return "not_configured";
    }
    return "disconnected";
  }

  private canProvisionWalletOnSetup(settings: InfraSettings): boolean {
    if (!settings.wallet.enabled) return false;
    if (settings.wallet.provider !== "coinbase_agentic") return true;
    return (
      settings.wallet.coinbase.enabled &&
      String(settings.wallet.coinbase.signerEndpoint || "").trim().length > 0
    );
  }
}
