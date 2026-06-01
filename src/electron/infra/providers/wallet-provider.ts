import { InfraSettings } from "../../../shared/types";

export type WalletProviderKind = "local" | "coinbase_agentic";

export interface X402PaymentDetails {
  scheme?: string;
  payTo: string;
  amount?: string;
  maxAmountRequired?: string;
  currency?: string;
  asset?: string;
  network: string;
  resource: string;
  description?: string;
  mimeType?: string;
  expires?: number;
  [key: string]: unknown;
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
  paymentPolicy?: X402PaymentPolicyEnvelope;
  approvePayment?: X402PaymentApprovalHandler;
}

export interface X402FetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  paymentMade: boolean;
  amountPaid?: string;
  paymentDetails?: X402PaymentDetails;
  paymentPolicyEnforced?: boolean;
}

export interface X402PaymentPolicyEnvelope {
  policyVersion: 1;
  effectiveHardLimitUsd: number;
  maxAutoApproveUsd: number;
  requireApproval: boolean;
  allowedHosts: string[];
  preflight?: X402CheckResult;
  approvedPaymentDetails?: X402PaymentDetails;
  approvedAt?: string;
}

export interface X402PaymentChallenge {
  url: string;
  method: string;
  paymentDetails: X402PaymentDetails;
}

export type X402PaymentApprovalHandler = (
  challenge: X402PaymentChallenge,
) => Promise<boolean> | boolean;

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
