import { InfraSettings } from "../../../shared/types";

export type WalletProviderKind = "local" | "coinbase_agentic";

export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The x402 v2 PAYMENT-REQUIRED envelope. */
export interface X402PaymentRequired {
  x402Version: 2;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirement[];
  extensions?: Record<string, unknown>;
}

export interface X402EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface X402PaymentPayload {
  x402Version: 2;
  resource: X402ResourceInfo;
  accepted: X402PaymentRequirement;
  payload: {
    signature: string;
    authorization: X402EvmAuthorization;
  };
  extensions?: Record<string, unknown>;
}

/**
 * Validated v2 details plus projections kept for existing policy callers.
 * `amount` is the atomic token amount exactly as supplied by the server.
 */
export interface X402PaymentDetails extends X402PaymentRequired {
  selectedRequirement: X402PaymentRequirement;
  resourceInfo: X402ResourceInfo;
  resourceUrl: string;
  scheme: string;
  payTo: string;
  amount: string;
  asset: string;
  network: string;
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
