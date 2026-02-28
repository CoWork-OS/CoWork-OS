import { InfraSettings } from "../../../shared/types";
import { WalletManager } from "../wallet/wallet-manager";
import { X402Client } from "./x402-client";
import {
  WalletProvider,
  WalletProviderKind,
  WalletProviderStatus,
  X402CheckResult,
  X402FetchRequest,
  X402FetchResult,
} from "./wallet-provider";

export class LocalWalletProvider implements WalletProvider {
  readonly kind: WalletProviderKind = "local";
  private x402Client = new X402Client();

  async initialize(): Promise<void> {
    WalletManager.startupCheck();
    this.configureX402Client();
  }

  async applySettings(_settings: InfraSettings): Promise<void> {
    this.configureX402Client();
  }

  async hasWallet(): Promise<boolean> {
    return WalletManager.hasWallet();
  }

  async getAddress(): Promise<string | null> {
    return WalletManager.getAddress();
  }

  async getNetwork(): Promise<string> {
    return WalletManager.getNetwork();
  }

  async getBalanceUsdc(): Promise<string> {
    return WalletManager.getBalance();
  }

  async getStatus(): Promise<WalletProviderStatus> {
    const hasWallet = WalletManager.hasWallet();
    if (!hasWallet) {
      return {
        kind: this.kind,
        connected: false,
      };
    }

    let balance = "0.00";
    try {
      balance = await WalletManager.getBalance();
    } catch {
      // Keep status available even if balance endpoint is down.
    }

    return {
      kind: this.kind,
      connected: true,
      address: WalletManager.getAddress() || undefined,
      network: WalletManager.getNetwork(),
      balanceUsdc: balance,
    };
  }

  async ensureWallet(): Promise<void> {
    if (!WalletManager.hasWallet()) {
      WalletManager.generate();
    }
    this.configureX402Client();
  }

  async x402Check(url: string): Promise<X402CheckResult> {
    return this.x402Client.check(url);
  }

  async x402Fetch(req: X402FetchRequest): Promise<X402FetchResult> {
    return this.x402Client.fetchWithPayment(req.url, {
      method: req.method,
      body: req.body,
      headers: req.headers,
    });
  }

  private configureX402Client(): void {
    if (!WalletManager.hasWallet()) {
      return;
    }
    const pk = WalletManager.getPrivateKey();
    const addr = WalletManager.getAddress();
    if (pk && addr) {
      this.x402Client.setWallet(pk, addr);
    }
  }
}
