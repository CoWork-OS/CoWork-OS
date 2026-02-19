/**
 * Conway Terminal Manager
 *
 * Orchestrates Conway Terminal setup, MCP server lifecycle, wallet queries,
 * and balance polling. The Conway MCP server entry lives in MCPSettings;
 * this manager provides the higher-level Conway-specific operations.
 */

import { EventEmitter } from "events";
import { BrowserWindow } from "electron";
import { MCPSettingsManager } from "../mcp/settings";
import { MCPClientManager } from "../mcp/client/MCPClientManager";
import { ConwaySettingsManager } from "./conway-settings";
import { ConwayWalletManager } from "./conway-wallet";
import {
  ConwaySetupStatus,
  ConwaySetupState,
  ConwayWalletInfo,
  ConwayCreditsBalance,
  ConwayCreditHistoryEntry,
  IPC_CHANNELS,
} from "../../shared/types";

const CONWAY_SERVER_NAME = "Conway Terminal";
const CONWAY_COMMAND = "npx";
const CONWAY_ARGS = ["-y", "conway-terminal"];

export class ConwayManager extends EventEmitter {
  private static instance: ConwayManager | null = null;
  private setupState: ConwaySetupState = "not_installed";
  private balancePollingTimer: NodeJS.Timeout | null = null;
  private cachedBalance: ConwayCreditsBalance | null = null;
  private cachedWallet: ConwayWalletInfo | null = null;
  private inFlightOperation = Promise.resolve<void>(undefined);

  private constructor() {
    super();
  }

  static getInstance(): ConwayManager {
    if (!ConwayManager.instance) {
      ConwayManager.instance = new ConwayManager();
    }
    return ConwayManager.instance;
  }

  /**
   * Initialize — verify wallet integrity, detect MCP server, restore state
   */
  async initialize(): Promise<void> {
    await this.withExclusiveOperation(async () => {
      const settings = ConwaySettingsManager.loadSettings();

      // Wallet integrity check — import, restore, or verify as needed
      const walletCheck = ConwayWalletManager.startupCheck();
      if (walletCheck.status !== "no_wallet") {
        console.log(
          `[Conway] Wallet check: ${walletCheck.status}, address: ${walletCheck.address}`,
        );
      }

      const server = this.findConwayServer();

      if (server) {
        this.setupState = "ready";

        // Ensure API key env is set on the server config
        const serverEnv = this.buildServerEnv();
        if (Object.keys(serverEnv).length > 0 && (!server.env || !server.env.CONWAY_API_KEY)) {
          MCPSettingsManager.updateServer(server.id, {
            env: { ...(server.env || {}), ...serverEnv },
          });
        }

        if (settings.enabled && settings.autoConnect) {
          try {
            const mcpManager = MCPClientManager.getInstance();
            const status = mcpManager.getServerStatus(server.id);
            if (!status || status.status === "disconnected" || status.status === "error") {
              await mcpManager.connectServer(server.id);
            }
            this.refreshCachedData().catch(() => {});
            this.startBalancePolling();
          } catch (error) {
            console.warn("[Conway] Auto-connect failed:", error);
          }
        }
      } else if (settings.enabled) {
        // Settings say enabled but server is missing — mark as installed but not connected
        this.setupState = "installed";
      }

      console.log(`[Conway] Initialized, state: ${this.setupState}`);
    });
  }

  /**
   * Full setup flow: generate wallet, create MCP server, connect
   */
  async setup(): Promise<ConwaySetupStatus> {
    return this.withExclusiveOperation(async () => {
      try {
        // Step 1: Generate wallet (or verify existing one)
        this.setupState = "installing";
        this.emitStatusChange();

        if (!ConwayWalletManager.hasWallet()) {
          console.log("[Conway] Generating new wallet...");
          const { address } = ConwayWalletManager.generate();
          console.log(`[Conway] Wallet generated: ${address}`);
        } else {
          // Wallet already exists — just ensure the file is present
          console.log("[Conway] Wallet already exists in encrypted store");
          const integrity = ConwayWalletManager.verifyIntegrity();
          if (integrity !== "ok") {
            console.log(`[Conway] Wallet file status: ${integrity} — restoring`);
            ConwayWalletManager.restoreWalletFile();
          }
        }

        this.setupState = "installed";
        this.emitStatusChange();

        // Step 2: Provision API key if not already done
        if (!ConwayWalletManager.hasApiKey()) {
          console.log("[Conway] Provisioning API key...");
          const apiKey = await ConwayWalletManager.provision();
          if (apiKey) {
            console.log("[Conway] API key provisioned successfully");
          } else {
            console.warn("[Conway] Provisioning failed — sandbox operations may not work");
          }
        }

        // Step 3: Create or find MCP server entry (with API key in env)
        this.setupState = "initializing";
        this.emitStatusChange();

        const serverEnv = this.buildServerEnv();

        let server = this.findConwayServer();
        if (!server) {
          server = MCPSettingsManager.addServer({
            name: CONWAY_SERVER_NAME,
            enabled: true,
            transport: "stdio" as const,
            command: CONWAY_COMMAND,
            args: [...CONWAY_ARGS],
            env: serverEnv,
          });
          console.log("[Conway] Created MCP server entry:", server.id);
        } else {
          // Update env with API key if server already exists
          MCPSettingsManager.updateServer(server.id, {
            enabled: true,
            env: serverEnv,
          });
        }

        // Step 3: Connect the MCP server (skip if already connected)
        const mcpManager = MCPClientManager.getInstance();
        const existingStatus = mcpManager.getServerStatus(server.id);
        if (!existingStatus || existingStatus.status !== "connected") {
          await mcpManager.connectServer(server.id);
        }

        // Step 4: Update Conway settings with wallet address backup
        const conwaySettings = ConwaySettingsManager.loadSettings();
        const walletInfo = ConwayWalletManager.getWalletInfo();
        ConwaySettingsManager.saveSettings({
          ...conwaySettings,
          enabled: true,
          walletAddressBackup: walletInfo?.address || conwaySettings.walletAddressBackup,
          walletNetworkBackup: walletInfo?.network || conwaySettings.walletNetworkBackup,
          walletBackupTimestamp: walletInfo ? Date.now() : conwaySettings.walletBackupTimestamp,
        });

        this.setupState = "ready";
        this.emitStatusChange();

        // Step 5: Fetch initial data in background
        this.refreshCachedData().catch(() => {});
        this.startBalancePolling();

        return this.getStatus();
      } catch (error: any) {
        this.setupState = "error";
        this.emitStatusChange();
        const status = this.getStatus();
        status.error = error instanceof Error ? error.message : String(error);
        return status;
      }
    });
  }

  /**
   * Find existing Conway MCP server config
   */
  findConwayServer() {
    const settings = MCPSettingsManager.loadSettings();
    return settings.servers.find(
      (s) =>
        s.name === CONWAY_SERVER_NAME || (s.args || []).some((a) => a.includes("conway-terminal")),
    );
  }

  /**
   * Build environment variables for the Conway MCP server process.
   * Includes CONWAY_API_KEY from encrypted store if available.
   */
  private buildServerEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const apiKey = ConwayWalletManager.getApiKey();
    if (apiKey) {
      env.CONWAY_API_KEY = apiKey;
    }
    return env;
  }

  /**
   * Get wallet info via MCP tool
   */
  async getWalletInfo(): Promise<ConwayWalletInfo | null> {
    try {
      const mcpManager = MCPClientManager.getInstance();
      if (!mcpManager.hasTool("wallet_info")) return this.cachedWallet;

      const result = await mcpManager.callTool("wallet_info", {});
      const text = this.extractText(result);
      if (!text) return this.cachedWallet;

      // Parse wallet info from the MCP response
      const wallet = this.parseWalletInfo(text);
      if (wallet) {
        this.cachedWallet = wallet;
      }
      return this.cachedWallet;
    } catch (error) {
      console.warn("[Conway] Failed to get wallet info:", error);
      return this.cachedWallet;
    }
  }

  /**
   * Get credits balance via MCP tool
   */
  async getBalance(): Promise<ConwayCreditsBalance | null> {
    try {
      const mcpManager = MCPClientManager.getInstance();
      if (!mcpManager.hasTool("credits_balance")) return this.cachedBalance;

      const result = await mcpManager.callTool("credits_balance", {});
      const text = this.extractText(result);
      if (!text) return this.cachedBalance;

      const balance = this.parseBalance(text);
      if (balance) {
        this.cachedBalance = balance;
      }
      return this.cachedBalance;
    } catch (error) {
      console.warn("[Conway] Failed to get balance:", error);
      return this.cachedBalance;
    }
  }

  /**
   * Get credit history via MCP tool
   */
  async getCreditHistory(): Promise<ConwayCreditHistoryEntry[]> {
    try {
      const mcpManager = MCPClientManager.getInstance();
      if (!mcpManager.hasTool("credits_history")) return [];

      const result = await mcpManager.callTool("credits_history", {});
      const text = this.extractText(result);
      if (!text) return [];

      return this.parseCreditHistory(text);
    } catch (error) {
      console.warn("[Conway] Failed to get credit history:", error);
      return [];
    }
  }

  /**
   * Get comprehensive status
   */
  getStatus(): ConwaySetupStatus {
    const server = this.findConwayServer();
    let mcpConnectionStatus: ConwaySetupStatus["mcpConnectionStatus"] = "disconnected";
    let toolCount = 0;

    if (server) {
      const mcpStatus = MCPClientManager.getInstance().getServerStatus(server.id);
      if (mcpStatus) {
        mcpConnectionStatus = mcpStatus.status as ConwaySetupStatus["mcpConnectionStatus"];
        toolCount = mcpStatus.tools?.length || 0;
      }
    }

    // Use cached wallet from MCP, or fall back to encrypted store
    let walletInfo = this.cachedWallet || undefined;
    if (!walletInfo) {
      const stored = ConwayWalletManager.getWalletInfo();
      if (stored) {
        walletInfo = {
          address: stored.address,
          publicKey: stored.address,
          network: stored.network,
        };
      }
    }

    return {
      state: this.setupState,
      walletInfo,
      balance: this.cachedBalance || undefined,
      mcpServerId: server?.id,
      mcpConnectionStatus,
      toolCount,
      walletFileExists: ConwayWalletManager.walletFileExists(),
    };
  }

  /**
   * Connect Conway MCP server
   */
  async connect(): Promise<void> {
    await this.withExclusiveOperation(async () => {
      const serverEnv = this.buildServerEnv();

      let server = this.findConwayServer();
      if (!server) {
        server = MCPSettingsManager.addServer({
          name: CONWAY_SERVER_NAME,
          enabled: true,
          transport: "stdio" as const,
          command: CONWAY_COMMAND,
          args: [...CONWAY_ARGS],
          env: serverEnv,
        });
      } else if (Object.keys(serverEnv).length > 0) {
        // Ensure env is up to date with API key
        MCPSettingsManager.updateServer(server.id, {
          env: { ...(server.env || {}), ...serverEnv },
        });
      }

      const mcpManager = MCPClientManager.getInstance();
      const existingStatus = mcpManager.getServerStatus(server.id);
      if (!existingStatus || existingStatus.status !== "connected") {
        await mcpManager.connectServer(server.id);
      }
      this.setupState = "ready";
      this.startBalancePolling();
      this.refreshCachedData().catch(() => {});
      this.emitStatusChange();
    });
  }

  /**
   * Disconnect Conway MCP server
   */
  async disconnect(): Promise<void> {
    await this.withExclusiveOperation(async () => {
      const server = this.findConwayServer();
      if (server) {
        await MCPClientManager.getInstance().disconnectServer(server.id);
      }
      this.stopBalancePolling();
      this.emitStatusChange();
    });
  }

  /**
   * Reset: disconnect, remove MCP server entry, clear settings
   */
  async reset(): Promise<void> {
    await this.withExclusiveOperation(async () => {
      const server = this.findConwayServer();
      if (server) {
        try {
          await MCPClientManager.getInstance().disconnectServer(server.id);
        } catch {
          // May already be disconnected
        }
        MCPSettingsManager.removeServer(server.id);
      }

      this.stopBalancePolling();
      this.cachedBalance = null;
      this.cachedWallet = null;
      this.setupState = "not_installed";

      ConwaySettingsManager.saveSettings({
        ...ConwaySettingsManager.getDefaults(),
        enabled: false,
      });

      this.emitStatusChange();
      console.log("[Conway] Reset complete — wallet file at ~/.conway/wallet.json is preserved");
    });
  }

  private async withExclusiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.inFlightOperation;
    const next = current.then(operation);
    this.inFlightOperation = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  /**
   * Start periodic balance polling
   */
  startBalancePolling(): void {
    if (this.balancePollingTimer) return;

    const settings = ConwaySettingsManager.loadSettings();
    const interval = settings.balanceRefreshIntervalMs || 300000;

    this.balancePollingTimer = setInterval(async () => {
      try {
        const balance = await this.getBalance();
        if (balance) {
          this.emitStatusChange();
        }
      } catch {
        // Polling failure is non-critical
      }
    }, interval);
  }

  /**
   * Stop balance polling
   */
  private stopBalancePolling(): void {
    if (this.balancePollingTimer) {
      clearInterval(this.balancePollingTimer);
      this.balancePollingTimer = null;
    }
  }

  /**
   * Refresh cached wallet and balance data
   */
  private async refreshCachedData(): Promise<void> {
    await Promise.all([this.getWalletInfo(), this.getBalance()]);
    this.emitStatusChange();
  }

  /**
   * Emit status change to all renderer windows
   */
  private emitStatusChange(): void {
    const status = this.getStatus();
    this.emit("statusChange", status);

    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.CONWAY_STATUS_CHANGE, status);
        }
      }
    } catch {
      // Windows may not be available during shutdown
    }
  }

  /**
   * Extract text content from MCP call result
   */
  private extractText(result: any): string | null {
    if (!result || !result.content) return null;
    for (const item of result.content) {
      if (item.type === "text" && item.text) {
        return item.text;
      }
    }
    return null;
  }

  /**
   * Parse wallet info from MCP response text
   */
  /**
   * Safely extract a string from a value that may be a string or object
   */
  private toStr(val: any, fallback: string): string {
    if (typeof val === "string") return val;
    if (val && typeof val === "object") return val.name || val.id || JSON.stringify(val);
    if (val !== undefined && val !== null) return String(val);
    return fallback;
  }

  private parseWalletInfo(text: string): ConwayWalletInfo | null {
    try {
      const data = JSON.parse(text);
      if (data.address) {
        return {
          address: this.toStr(data.address, ""),
          publicKey: this.toStr(data.publicKey || data.public_key || data.address, ""),
          network: this.toStr(data.network || data.chain, "base"),
        };
      }
    } catch {
      const addressMatch = text.match(/(?:address|wallet)[:\s]*([0-9a-fA-Fx]+)/i);
      if (addressMatch) {
        return {
          address: addressMatch[1],
          publicKey: addressMatch[1],
          network: "base",
        };
      }
    }
    return null;
  }

  /**
   * Parse balance from MCP response text
   */
  private parseBalance(text: string): ConwayCreditsBalance | null {
    try {
      const data = JSON.parse(text);
      const balance = data.balance ?? data.credits ?? data.amount;
      if (balance !== undefined) {
        const balStr = this.toStr(balance, "0");
        return {
          balance: balStr,
          balanceUsd: parseFloat(balStr) || 0,
          lastUpdated: Date.now(),
        };
      }
    } catch {
      // Try regex extraction
      const balanceMatch = text.match(/(?:balance|credits?)[:\s]*([\d.]+)/i);
      if (balanceMatch) {
        return {
          balance: balanceMatch[1],
          balanceUsd: parseFloat(balanceMatch[1]) || 0,
          lastUpdated: Date.now(),
        };
      }
    }
    return null;
  }

  /**
   * Parse credit history from MCP response text
   */
  private parseCreditHistory(text: string): ConwayCreditHistoryEntry[] {
    try {
      const data = JSON.parse(text);
      const entries = Array.isArray(data) ? data : data.history || data.transactions || [];
      return entries.map((entry: any, index: number) => ({
        id: this.toStr(entry.id, String(index)),
        type: (() => {
          const parsedAmount = this.parseCreditAmount(entry.amount ?? entry.value);
          if (
            entry.type === "debit" ||
            entry.type === "DEBIT" ||
            entry.type === "Debit" ||
            parsedAmount < 0
          ) {
            return "debit" as const;
          }
          return "credit" as const;
        })(),
        amount: this.toStr(Math.abs(this.parseCreditAmount(entry.amount ?? entry.value)), "0"),
        description: this.toStr(entry.description || entry.memo || entry.label, ""),
        service: this.toStr(entry.service || entry.category, "unknown"),
        timestamp: this.parseTimestamp(entry.timestamp || entry.created_at),
      }));
    } catch {
      return [];
    }
  }

  private parseCreditAmount(amount: unknown): number {
    if (typeof amount === "number") return Number.isFinite(amount) ? amount : 0;
    if (typeof amount === "string") {
      const parsed = Number.parseFloat(amount.trim());
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private parseTimestamp(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : Date.now();
    }
    return Date.now();
  }
}
