/**
 * x402 Payment Protocol Client
 *
 * Implements the x402 HTTP payment protocol (USDC on Base).
 * Flow: request → 402 + PAYMENT-REQUIRED header → sign with EIP-712 → retry with PAYMENT-SIGNATURE → 200 OK
 *
 * No external dependencies — uses ethers.js for EIP-712 signing.
 */

import * as crypto from "crypto";
import { ethers } from "ethers";
import type {
  X402FetchResult,
  X402PaymentApprovalHandler,
  X402PaymentDetails,
  X402PaymentPayload,
  X402PaymentRequired,
  X402PaymentRequirement,
  X402ResourceInfo,
  X402CheckResult,
} from "./wallet-provider";
import { BASE_MAINNET_USDC, BASE_SEPOLIA_USDC, isResourceForRequest } from "./x402-policy";

interface X402FetchWithPaymentOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  approvePayment?: X402PaymentApprovalHandler;
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const SUPPORTED_BASE_CHAIN_IDS = new Set([8453, 84532]);

const EIP3009_EXTRA_KEYS = ["name", "version"] as const;

type Eip3009Extra = Record<(typeof EIP3009_EXTRA_KEYS)[number], string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);

const isAtomicAmount = (value: unknown): value is string =>
  typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);

const getChainId = (network: string): number | null => {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) return null;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) && SUPPORTED_BASE_CHAIN_IDS.has(chainId) ? chainId : null;
};

const getEip3009Extra = (requirement: X402PaymentRequirement): Eip3009Extra | null => {
  if (!isRecord(requirement.extra)) return null;
  if (
    requirement.extra.assetTransferMethod !== undefined &&
    requirement.extra.assetTransferMethod !== "eip3009"
  ) {
    return null;
  }
  const name = requirement.extra.name;
  const version = requirement.extra.version;
  return typeof name === "string" && name.length > 0 && typeof version === "string"
    ? { name, version }
    : null;
};

const isSupportedRequirement = (requirement: unknown): requirement is X402PaymentRequirement => {
  if (!isRecord(requirement)) return false;
  if (requirement.scheme !== "exact") return false;
  if (typeof requirement.network !== "string" || getChainId(requirement.network) === null) {
    return false;
  }
  if (!isAtomicAmount(requirement.amount) || !isAddress(requirement.asset)) return false;
  const chainId = getChainId(requirement.network);
  const expectedAsset = chainId === 8453 ? BASE_MAINNET_USDC : BASE_SEPOLIA_USDC;
  if (requirement.asset.toLowerCase() !== expectedAsset) return false;
  if (!isAddress(requirement.payTo)) return false;
  if (
    typeof requirement.maxTimeoutSeconds !== "number" ||
    !Number.isSafeInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds <= 0
  ) {
    return false;
  }
  return getEip3009Extra(requirement as unknown as X402PaymentRequirement) !== null;
};

const copyRequirement = (requirement: X402PaymentRequirement): X402PaymentRequirement => ({
  ...requirement,
  ...(requirement.extra ? { extra: { ...requirement.extra } } : {}),
});

const isResourceInfo = (value: unknown): value is X402ResourceInfo =>
  isRecord(value) && typeof value.url === "string" && value.url.length > 0;

const isPaymentRequired = (value: unknown): value is X402PaymentRequired =>
  isRecord(value) &&
  value.x402Version === 2 &&
  isResourceInfo(value.resource) &&
  Array.isArray(value.accepts) &&
  value.accepts.filter(isSupportedRequirement).length === 1;

const toPaymentDetails = (required: X402PaymentRequired): X402PaymentDetails | undefined => {
  const selected = required.accepts.find(isSupportedRequirement);
  if (!selected) return undefined;
  const selectedRequirement = copyRequirement(selected);
  const resourceInfo: X402ResourceInfo = { ...required.resource };
  return {
    ...required,
    resource: resourceInfo,
    resourceInfo,
    resourceUrl: resourceInfo.url,
    accepts: required.accepts.map(copyRequirement),
    selectedRequirement,
    scheme: selectedRequirement.scheme,
    payTo: selectedRequirement.payTo,
    amount: selectedRequirement.amount,
    asset: selectedRequirement.asset,
    network: selectedRequirement.network,
  };
};

const parseHeaderJson = (header: string): unknown => {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // Fall through to the plain JSON form used by a few development servers.
  }
  try {
    return JSON.parse(header) as unknown;
  } catch {
    return undefined;
  }
};

export class X402Client {
  private privateKey: string | null = null;
  private address: string | null = null;

  setWallet(privateKey: string, address: string): void {
    this.privateKey = privateKey;
    this.address = address;
  }

  hasWallet(): boolean {
    return !!this.privateKey && !!this.address;
  }

  /**
   * Check if a URL requires x402 payment (HEAD request)
   */
  async check(url: string): Promise<X402CheckResult> {
    try {
      const response = await fetch(url, { method: "HEAD" });

      if (response.status === 402) {
        const paymentHeader = response.headers.get("payment-required");
        if (paymentHeader) {
          const paymentDetails = this.parsePaymentHeader(paymentHeader);
          if (!paymentDetails) {
            throw new Error("Failed to parse PAYMENT-REQUIRED header");
          }
          if (!isResourceForRequest(paymentDetails.resource, url)) {
            throw new Error("x402 payment resource does not match the requested URL");
          }
          return { requires402: true, paymentDetails, url };
        }
        return { requires402: true, url };
      }

      return { requires402: false, url };
    } catch (error) {
      throw new Error(`x402 check failed for ${url}: ${error}`);
    }
  }

  /**
   * Fetch a URL with automatic x402 payment flow
   */
  async fetchWithPayment(
    url: string,
    opts?: X402FetchWithPaymentOptions,
  ): Promise<X402FetchResult> {
    if (!this.privateKey || !this.address) {
      throw new Error("Wallet not configured for x402 payments");
    }

    const method = opts?.method || "GET";
    const headers: Record<string, string> = this.sanitizeRequestHeaders(opts?.headers);

    // First request
    const initialResponse = await fetch(url, { method, headers, body: opts?.body });

    if (initialResponse.status !== 402) {
      // No payment needed
      const body = await initialResponse.text();
      return {
        status: initialResponse.status,
        body,
        headers: this.responseHeadersToRecord(initialResponse.headers),
        paymentMade: false,
      };
    }

    // Parse payment requirement
    const paymentHeader = initialResponse.headers.get("payment-required");
    if (!paymentHeader) {
      throw new Error("402 response missing PAYMENT-REQUIRED header");
    }

    const paymentDetails = this.parsePaymentHeader(paymentHeader);
    if (!paymentDetails) {
      throw new Error("Failed to parse PAYMENT-REQUIRED header");
    }
    if (!isResourceForRequest(paymentDetails.resource, url)) {
      throw new Error("x402 payment resource does not match the requested URL");
    }

    if (!opts?.approvePayment) {
      throw new Error("x402 payment policy approval handler is required before signing.");
    }
    const approved = await opts.approvePayment({ url, method, paymentDetails });
    if (!approved) {
      throw new Error("x402 payment was not approved by policy.");
    }

    // Sign the canonical exact EVM payment payload
    const signature = await this.signPayment(paymentDetails);

    // Retry with payment signature
    headers["payment-signature"] = signature;

    const paidResponse = await fetch(url, { method, headers, body: opts?.body });
    const body = await paidResponse.text();

    return {
      status: paidResponse.status,
      body,
      headers: this.responseHeadersToRecord(paidResponse.headers),
      paymentMade: true,
      amountPaid: paymentDetails.amount,
      paymentDetails,
      paymentPolicyEnforced: true,
    };
  }

  /**
   * Discover x402 endpoints for a domain
   */
  async discover(baseUrl: string): Promise<{ endpoints: string[] }> {
    try {
      const url = new URL("/.well-known/x402", baseUrl);
      const response = await fetch(url.toString());

      if (!response.ok) {
        return { endpoints: [] };
      }

      const data = (await response.json()) as Record<string, unknown>;
      return { endpoints: Array.isArray(data.endpoints) ? data.endpoints : [] };
    } catch {
      return { endpoints: [] };
    }
  }

  // --- Private helpers ---

  private parsePaymentHeader(header: string): X402PaymentDetails | undefined {
    const parsed = parseHeaderJson(header);
    return isPaymentRequired(parsed) ? toPaymentDetails(parsed) : undefined;
  }

  private async signPayment(details: X402PaymentDetails): Promise<string> {
    if (!this.privateKey) throw new Error("No private key for signing");

    const wallet = new ethers.Wallet(this.privateKey);
    const requirement = details.selectedRequirement;
    const chainId = getChainId(requirement.network);
    const extra = getEip3009Extra(requirement);
    if (chainId === null || extra === null) {
      throw new Error("Unsupported x402 exact EVM payment requirement; refusing to sign.");
    }

    const authorization = {
      from: wallet.address,
      to: requirement.payTo,
      value: requirement.amount,
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + requirement.maxTimeoutSeconds),
      nonce: ethers.hexlify(crypto.randomBytes(32)),
    };

    const signature = await wallet.signTypedData(
      {
        name: extra.name,
        version: extra.version,
        chainId,
        verifyingContract: requirement.asset,
      },
      EIP3009_TYPES,
      authorization,
    );

    const payload: X402PaymentPayload = {
      x402Version: 2,
      resource: details.resource,
      accepted: requirement,
      payload: { signature, authorization },
      ...(details.extensions ? { extensions: details.extensions } : {}),
    };
    return Buffer.from(JSON.stringify(payload)).toString("base64");
  }

  private responseHeadersToRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  private sanitizeRequestHeaders(headers?: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers || {})) {
      const normalized = key.toLowerCase();
      if (normalized === "payment-signature" || normalized === "payment-address") {
        continue;
      }
      sanitized[key] = value;
    }
    return sanitized;
  }
}
