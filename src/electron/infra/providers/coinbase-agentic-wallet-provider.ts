import { InfraSettings } from "../../../shared/types";
import {
  WalletProvider,
  WalletProviderKind,
  WalletProviderStatus,
  X402CheckResult,
  X402FetchRequest,
  X402FetchResult,
} from "./wallet-provider";

interface CoinbaseWalletStatusResponse {
  connected?: boolean;
  address?: string;
  network?: string;
  balanceUsdc?: string;
}

/**
 * Coinbase Agentic Wallet adapter.
 *
 * This provider intentionally delegates signing/payment execution to a backend
 * signer endpoint instead of storing private keys in the desktop app.
 */
export class CoinbaseAgenticWalletProvider implements WalletProvider {
  readonly kind: WalletProviderKind = "coinbase_agentic";

  private signerEndpoint = "";
  private network: "base-mainnet" | "base-sepolia" = "base-mainnet";
  private accountId = "";
  private enabled = false;

  async initialize(): Promise<void> {
    // No-op: runtime config comes from settings via applySettings().
  }

  async applySettings(settings: InfraSettings): Promise<void> {
    this.enabled = settings.wallet.coinbase.enabled;
    this.signerEndpoint = this.normalizeEndpoint(settings.wallet.coinbase.signerEndpoint);
    this.network = settings.wallet.coinbase.network;
    this.accountId = settings.wallet.coinbase.accountId;
  }

  async hasWallet(): Promise<boolean> {
    const status = await this.getStatus();
    return status.connected && !!status.address;
  }

  async getAddress(): Promise<string | null> {
    const status = await this.fetchRemoteStatus();
    return status.address || null;
  }

  async getNetwork(): Promise<string> {
    const status = await this.fetchRemoteStatus();
    return status.network || this.network;
  }

  async getBalanceUsdc(): Promise<string> {
    const status = await this.fetchRemoteStatus();
    return status.balanceUsdc || "0.00";
  }

  async getStatus(): Promise<WalletProviderStatus> {
    if (!this.enabled || !this.signerEndpoint) {
      return {
        kind: this.kind,
        connected: false,
        network: this.network,
      };
    }

    const status = await this.fetchRemoteStatus();
    return {
      kind: this.kind,
      connected: !!status.connected,
      address: status.address,
      network: status.network || this.network,
      balanceUsdc: status.balanceUsdc,
    };
  }

  async ensureWallet(): Promise<void> {
    this.ensureConfigured();
    await this.callJson("/wallet/ensure", {
      method: "POST",
      body: { accountId: this.accountId, network: this.network },
    });
  }

  async x402Check(url: string): Promise<X402CheckResult> {
    this.ensureConfigured();
    return this.callJson<X402CheckResult>("/x402/check", {
      method: "POST",
      body: { url, accountId: this.accountId, network: this.network },
    });
  }

  async x402Fetch(req: X402FetchRequest): Promise<X402FetchResult> {
    this.ensureConfigured();
    return this.callJson<X402FetchResult>("/x402/fetch", {
      method: "POST",
      body: {
        url: req.url,
        method: req.method,
        body: req.body,
        headers: req.headers,
        accountId: this.accountId,
        network: this.network,
      },
    });
  }

  private async fetchRemoteStatus(): Promise<CoinbaseWalletStatusResponse> {
    if (!this.enabled || !this.signerEndpoint) {
      return {};
    }
    try {
      return await this.callJson<CoinbaseWalletStatusResponse>("/wallet/status", {
        method: "POST",
        body: { accountId: this.accountId, network: this.network },
      });
    } catch (error) {
      console.warn("[CoinbaseAgenticWalletProvider] Status fetch failed:", error);
      return {};
    }
  }

  private ensureConfigured(): void {
    if (!this.enabled) {
      throw new Error("Coinbase Agentic Wallet provider is disabled in settings");
    }
    if (!this.signerEndpoint) {
      throw new Error("Coinbase signer endpoint is not configured");
    }
  }

  private normalizeEndpoint(value: string): string {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  private async callJson<T>(
    path: string,
    opts: { method: "GET" | "POST"; body?: Record<string, unknown> },
  ): Promise<T> {
    if (!this.signerEndpoint) {
      throw new Error("Coinbase signer endpoint is not configured");
    }
    const response = await fetch(`${this.signerEndpoint}${path}`, {
      method: opts.method,
      headers: {
        "content-type": "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Coinbase signer request failed (${response.status}): ${text || "unknown"}`);
    }

    return (await response.json()) as T;
  }
}
