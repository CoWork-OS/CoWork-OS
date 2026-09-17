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
import {
  formatAtomicUsdc,
  getCanonicalPaymentMismatch,
  getExpectedBaseAsset,
  getExpectedBaseNetwork,
  getSupportedRequirement,
  isCanonicalPaymentDetails,
  isResourceForRequest,
  normalizePaymentDetails,
  parseAtomicAmount,
  usdToAtomic,
} from "./x402-policy";

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
    const result = await this.callJson<X402CheckResult>("/x402/check", {
      method: "POST",
      body: { url, accountId: this.accountId, network: this.network },
    });
    if (!result.paymentDetails) return result;

    const details = normalizePaymentDetails(
      result.paymentDetails,
      getExpectedBaseNetwork(this.network),
      getExpectedBaseAsset(this.network),
    );
    if (!details || !isResourceForRequest(details.resource, url)) {
      throw new Error("Coinbase signer returned an invalid x402 v2 preflight challenge");
    }
    return { ...result, paymentDetails: details };
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
    this.validateSignerPaymentResult(result, req.paymentPolicy, req.url);
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
    return String(value || "")
      .trim()
      .replace(/\/+$/, "");
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
    requestUrl: string,
  ): void {
    if (!result.paymentMade) return;

    if (result.paymentPolicyEnforced !== true) {
      throw new Error("Coinbase signer did not confirm x402 payment policy enforcement");
    }
    if (!result.paymentDetails) {
      throw new Error("Coinbase signer did not return signed x402 payment details");
    }

    const rawDetails = result.paymentDetails;
    if (!isCanonicalPaymentDetails(rawDetails)) {
      throw new Error("Coinbase signer returned non-canonical x402 v2 payment details");
    }
    const expectedNetwork = getExpectedBaseNetwork(this.network);
    const expectedAsset = getExpectedBaseAsset(this.network);
    const details = normalizePaymentDetails(rawDetails, expectedNetwork, expectedAsset);
    const requirement = details
      ? getSupportedRequirement(details, expectedNetwork, expectedAsset)
      : null;
    const atomicAmount = requirement ? parseAtomicAmount(requirement.amount) : null;
    const hardLimitAtomic = usdToAtomic(policy.effectiveHardLimitUsd);
    if (!details || !requirement || atomicAmount === null) {
      throw new Error("Coinbase signer returned invalid x402 payment amount");
    }
    if (!isResourceForRequest(details.resource, requestUrl)) {
      throw new Error("Coinbase signer returned an x402 resource that does not match the request");
    }
    if (hardLimitAtomic !== null && atomicAmount > hardLimitAtomic) {
      throw new Error(
        `Coinbase signer payment amount (${formatAtomicUsdc(atomicAmount)} USDC) exceeds policy hard limit (${policy.effectiveHardLimitUsd} USDC)`,
      );
    }
    if (details.network.toLowerCase() !== expectedNetwork.toLowerCase()) {
      throw new Error(`Coinbase signer returned unsupported x402 network: ${details.network}`);
    }
    if (details.asset.toLowerCase() !== expectedAsset.toLowerCase()) {
      throw new Error(
        `Coinbase signer returned unsupported x402 asset: ${details.asset || "unknown"}`,
      );
    }
    if (policy.requireApproval && !policy.approvedPaymentDetails) {
      throw new Error(
        "Coinbase signer made an x402 payment without exact approved payment details",
      );
    }

    const expected = policy.approvedPaymentDetails || policy.preflight?.paymentDetails;
    if (expected) {
      const mismatch = this.getPaymentDetailsMismatch(expected, details);
      if (mismatch) {
        throw new Error(
          `Coinbase signer payment details do not match approved policy (${mismatch})`,
        );
      }
    }
  }

  private getPaymentDetailsMismatch(
    expected: X402PaymentDetails,
    actual: X402PaymentDetails,
  ): string | null {
    return getCanonicalPaymentMismatch(expected, actual);
  }
}
