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
import { WalletManager } from "./wallet/wallet-manager";
import { E2BSandboxProvider } from "./providers/e2b-sandbox";
import { NamecheapDomainsProvider } from "./providers/namecheap-domains";
import { X402Client } from "./providers/x402-client";

export class InfraManager {
  private static instance: InfraManager | null = null;

  private sandboxProvider = new E2BSandboxProvider();
  private domainsProvider = new NamecheapDomainsProvider();
  private x402Client = new X402Client();
  private initialized = false;
  private cachedBalance: string = "0.00";
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

    // Wallet startup check — migrate from legacy store if needed
    const walletCheck = WalletManager.startupCheck();
    console.log(
      `[InfraManager] Wallet status: ${walletCheck.status}, address: ${walletCheck.address || "none"}`,
    );

    // Configure providers from settings
    this.applySettings(settings);

    // Set up wallet for x402 client
    if (WalletManager.hasWallet()) {
      const pk = WalletManager.getPrivateKey();
      const addr = WalletManager.getAddress();
      if (pk && addr) {
        this.x402Client.setWallet(pk, addr);
      }
    }

    // Start balance polling if wallet exists
    if (WalletManager.hasWallet() && settings.enabled) {
      this.startBalancePolling();
    }

    console.log("[InfraManager] Initialized");
  }

  /**
   * Apply settings to providers
   */
  applySettings(settings: InfraSettings): void {
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
  }

  // === Status ===

  getStatus(): InfraStatus {
    const settings = InfraSettingsManager.loadSettings();

    return {
      enabled: settings.enabled,
      wallet: WalletManager.hasWallet()
        ? {
            address: WalletManager.getAddress()!,
            network: WalletManager.getNetwork(),
            balanceUsdc: this.cachedBalance,
          }
        : undefined,
      walletFileExists: undefined, // We no longer write wallet files
      providers: {
        e2b: this.sandboxProvider.hasApiKey() ? "connected" : "not_configured",
        domains: this.domainsProvider.isConfigured() ? "connected" : "not_configured",
        wallet: WalletManager.hasWallet() ? "connected" : "not_configured",
      },
      activeSandboxes: this.sandboxProvider.list().length,
    };
  }

  // === Setup ===

  /**
   * Initial setup — generate wallet if needed
   */
  async setup(): Promise<InfraStatus> {
    if (!WalletManager.hasWallet()) {
      WalletManager.generate();
      console.log("[InfraManager] Generated new wallet during setup");
    }

    // Set up x402 client with wallet
    const pk = WalletManager.getPrivateKey();
    const addr = WalletManager.getAddress();
    if (pk && addr) {
      this.x402Client.setWallet(pk, addr);
    }

    // Enable infra
    const settings = InfraSettingsManager.loadSettings();
    if (!settings.enabled) {
      settings.enabled = true;
      InfraSettingsManager.saveSettings(settings);
    }

    this.startBalancePolling();

    return this.getStatus();
  }

  /**
   * Reset infrastructure — clear settings, disconnect providers
   */
  async reset(): Promise<void> {
    this.stopBalancePolling();
    await this.sandboxProvider.cleanup();

    // Reset settings to defaults
    InfraSettingsManager.saveSettings({ ...DEFAULT_INFRA_SETTINGS });
    InfraSettingsManager.clearCache();

    // Re-configure providers (will be empty)
    this.sandboxProvider = new E2BSandboxProvider();
    this.domainsProvider = new NamecheapDomainsProvider();
    this.x402Client = new X402Client();

    console.log("[InfraManager] Reset complete");
  }

  // === Wallet ===

  getWalletInfo(): WalletInfo | null {
    if (!WalletManager.hasWallet()) return null;
    return {
      address: WalletManager.getAddress()!,
      network: WalletManager.getNetwork(),
      balanceUsdc: this.cachedBalance,
    };
  }

  async getWalletInfoWithBalance(): Promise<WalletInfo | null> {
    if (!WalletManager.hasWallet()) return null;
    const balance = await this.getWalletBalance();
    return {
      address: WalletManager.getAddress()!,
      network: WalletManager.getNetwork(),
      balanceUsdc: balance,
    };
  }

  async getWalletBalance(): Promise<string> {
    try {
      this.cachedBalance = await WalletManager.getBalance();
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
    return this.x402Client.check(url);
  }

  async x402Fetch(url: string, opts?: { method?: string; body?: string }) {
    return this.x402Client.fetchWithPayment(url, opts);
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
}
