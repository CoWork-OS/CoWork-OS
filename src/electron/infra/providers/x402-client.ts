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

interface PaymentDetails {
  payTo: string;
  amount: string;
  currency: string;
  network: string;
  resource: string;
  description?: string;
  expires?: number;
}

interface X402CheckResult {
  requires402: boolean;
  paymentDetails?: PaymentDetails;
  url: string;
}

interface X402FetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  paymentMade: boolean;
  amountPaid?: string;
}

// EIP-712 domain for x402 payment signing
const EIP712_DOMAIN = {
  name: "x402",
  version: "1",
  chainId: 8453, // Base mainnet
};

const EIP712_TYPES = {
  PaymentIntent: [
    { name: "payTo", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "resource", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "expires", type: "uint256" },
  ],
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
    opts?: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<X402FetchResult> {
    if (!this.privateKey || !this.address) {
      throw new Error("Wallet not configured for x402 payments");
    }

    const method = opts?.method || "GET";
    const headers: Record<string, string> = { ...opts?.headers };

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

    // Sign the payment intent
    const signature = await this.signPaymentIntent(paymentDetails);

    // Retry with payment signature
    headers["payment-signature"] = signature;
    headers["payment-address"] = this.address;

    const paidResponse = await fetch(url, { method, headers, body: opts?.body });
    const body = await paidResponse.text();

    return {
      status: paidResponse.status,
      body,
      headers: this.responseHeadersToRecord(paidResponse.headers),
      paymentMade: true,
      amountPaid: paymentDetails.amount,
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

      const data = await response.json();
      return { endpoints: Array.isArray(data.endpoints) ? data.endpoints : [] };
    } catch {
      return { endpoints: [] };
    }
  }

  // --- Private helpers ---

  private parsePaymentHeader(header: string): PaymentDetails | undefined {
    try {
      // x402 header is base64-encoded JSON
      const decoded = Buffer.from(header, "base64").toString("utf-8");
      return JSON.parse(decoded) as PaymentDetails;
    } catch {
      try {
        // Try parsing as plain JSON
        return JSON.parse(header) as PaymentDetails;
      } catch {
        return undefined;
      }
    }
  }

  private async signPaymentIntent(details: PaymentDetails): Promise<string> {
    if (!this.privateKey) throw new Error("No private key for signing");

    const wallet = new ethers.Wallet(this.privateKey);

    const value = {
      payTo: details.payTo,
      amount: ethers.parseUnits(details.amount, 6).toString(), // USDC 6 decimals
      resource: details.resource,
      nonce: Date.now() * 1000 + crypto.randomInt(1000),
      expires: details.expires || Math.floor(Date.now() / 1000) + 300, // 5 min
    };

    const signature = await wallet.signTypedData(EIP712_DOMAIN, EIP712_TYPES, value);

    // Encode as base64 JSON with signature + value
    const payload = JSON.stringify({ signature, ...value, from: wallet.address });
    return Buffer.from(payload).toString("base64");
  }

  private responseHeadersToRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
}
