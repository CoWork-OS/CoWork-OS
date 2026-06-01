import { InfraSettings } from "../../../shared/types";
import {
  WalletProvider,
  WalletProviderKind,
  WalletProviderStatus,
  X402CheckResult,
  X402FetchRequest,
  X402FetchResult,
  X402PaymentDetails,
  X402PaymentPolicyEnvelope,
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
    if (!req.paymentPolicy) {
      throw new Error("Coinbase x402 fetch requires a payment policy envelope");
    }

    const result = await this.callJson<X402FetchResult>("/x402/fetch", {
      method: "POST",
      body: {
        url: req.url,
        method: req.method,
        body: req.body,
        headers: req.headers,
        accountId: this.accountId,
        network: this.network,
        paymentPolicy: req.paymentPolicy,
      },
    });
    this.validateSignerPaymentResult(result, req.paymentPolicy);
    return result;
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

  private validateSignerPaymentResult(
    result: X402FetchResult,
    policy: X402PaymentPolicyEnvelope,
  ): void {
    if (!result.paymentMade) return;

    if (result.paymentPolicyEnforced !== true) {
      throw new Error("Coinbase signer did not confirm x402 payment policy enforcement");
    }
    if (!result.paymentDetails) {
      throw new Error("Coinbase signer did not return signed x402 payment details");
    }

    const amount = this.extractPaymentAmount(result.paymentDetails);
    if (amount === null) {
      throw new Error("Coinbase signer returned invalid x402 payment amount");
    }
    if (amount > policy.effectiveHardLimitUsd) {
      throw new Error(
        `Coinbase signer payment amount (${amount} USDC) exceeds policy hard limit (${policy.effectiveHardLimitUsd} USDC)`,
      );
    }
    if (!this.isAllowedPaymentNetwork(String(result.paymentDetails.network || ""))) {
      throw new Error(`Coinbase signer returned unsupported x402 network: ${result.paymentDetails.network}`);
    }
    if (!this.isAllowedPaymentAsset(result.paymentDetails)) {
      throw new Error(`Coinbase signer returned unsupported x402 asset: ${result.paymentDetails.asset || "unknown"}`);
    }
    if (policy.requireApproval && !policy.approvedPaymentDetails) {
      throw new Error("Coinbase signer made an x402 payment without exact approved payment details");
    }

    const expected = policy.approvedPaymentDetails || policy.preflight?.paymentDetails;
    if (expected) {
      const mismatch = this.getPaymentDetailsMismatch(expected, result.paymentDetails);
      if (mismatch) {
        throw new Error(`Coinbase signer payment details do not match approved policy (${mismatch})`);
      }
    }
  }

  private extractPaymentAmount(details: X402PaymentDetails): number | null {
    const amount =
      details.amount !== undefined
        ? Number(details.amount)
        : typeof details.maxAmountRequired === "string" && /^\d+$/.test(details.maxAmountRequired)
          ? Number(details.maxAmountRequired) / 1_000_000
          : Number.NaN;
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }

  private isAllowedPaymentNetwork(network: string): boolean {
    const normalized = network.trim().toLowerCase();
    return (
      normalized === "base" ||
      normalized === this.network ||
      (this.network === "base-mainnet" && normalized === "eip155:8453") ||
      (this.network === "base-sepolia" && normalized === "eip155:84532")
    );
  }

  private isAllowedPaymentAsset(details: X402PaymentDetails): boolean {
    const currency = String(details.currency || "").toUpperCase();
    if (currency && currency !== "USDC") return false;
    if (!currency && !details.asset) return false;
    if (!details.asset) return true;

    const normalized = String(details.asset).trim().toLowerCase();
    const mainnetUsdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const sepoliaUsdc = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
    return this.network === "base-sepolia" ? normalized === sepoliaUsdc : normalized === mainnetUsdc;
  }

  private getPaymentDetailsMismatch(
    expected: X402PaymentDetails,
    actual: X402PaymentDetails,
  ): string | null {
    const fields: Array<keyof X402PaymentDetails> = [
      "scheme",
      "payTo",
      "amount",
      "maxAmountRequired",
      "currency",
      "asset",
      "network",
      "resource",
      "expires",
    ];
    for (const field of fields) {
      if (String(expected[field] ?? "") !== String(actual[field] ?? "")) {
        return `${field} mismatch`;
      }
    }
    return null;
  }
}
