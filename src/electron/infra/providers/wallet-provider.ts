import { InfraSettings } from "../../../shared/types";

export type WalletProviderKind = "local" | "coinbase_agentic";

export interface X402PaymentDetails {
  payTo: string;
  amount: string;
  currency: string;
  network: string;
  resource: string;
  description?: string;
  expires?: number;
}

export interface X402CheckResult {
  requires402: boolean;
  paymentDetails?: X402PaymentDetails;
  url: string;
}

export interface X402FetchRequest {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface X402FetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  paymentMade: boolean;
  amountPaid?: string;
}

export interface WalletProviderStatus {
  kind: WalletProviderKind;
  connected: boolean;
  address?: string;
  network?: string;
  balanceUsdc?: string;
}

export interface WalletProvider {
  readonly kind: WalletProviderKind;
  initialize(): Promise<void>;
  applySettings(settings: InfraSettings): Promise<void>;
  hasWallet(): Promise<boolean>;
  getAddress(): Promise<string | null>;
  getNetwork(): Promise<string>;
  getBalanceUsdc(): Promise<string>;
  getStatus(): Promise<WalletProviderStatus>;
  ensureWallet(): Promise<void>;
  x402Check(url: string): Promise<X402CheckResult>;
  x402Fetch(req: X402FetchRequest): Promise<X402FetchResult>;
}
