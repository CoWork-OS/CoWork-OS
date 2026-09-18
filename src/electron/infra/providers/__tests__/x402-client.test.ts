import { beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { X402Client } from "../x402-client";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WALLET = new ethers.Wallet(PRIVATE_KEY);
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SEPOLIA_ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

function paymentRequired(amount = "2", overrides: Record<string, unknown> = {}): string {
  const requirement = {
    scheme: "exact",
    network: "eip155:8453",
    amount,
    asset: ASSET,
    payTo: RECIPIENT,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    ...overrides,
  };
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://trusted.example/paid", mimeType: "application/json" },
      accepts: [requirement],
    }),
  ).toString("base64");
}

function newClient(): X402Client {
  const client = new X402Client();
  client.setWallet(PRIVATE_KEY, WALLET.address);
  return client;
}

function decodePayload(header: string): Record<string, any> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

describe("X402Client", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires approval of the canonical v2 challenge before signing and retrying", async () => {
    const client = newClient();
    const fetchMock = vi.fn(async () => {
      return new Response("", {
        status: 402,
        headers: { "payment-required": paymentRequired("10") },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client.fetchWithPayment("https://trusted.example/paid", {
        approvePayment: () => false,
      }),
    ).rejects.toThrow(/not approved by policy/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses paid signing when no approval handler is provided", async () => {
    const client = newClient();
    const fetchMock = vi.fn(async () => {
      return new Response("", {
        status: 402,
        headers: { "payment-required": paymentRequired("10") },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.fetchWithPayment("https://trusted.example/paid")).rejects.toThrow(
      /approval handler is required/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not require an approval handler when no payment is requested", async () => {
    const client = newClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("free", { status: 200 })),
    );

    await expect(client.fetchWithPayment("https://trusted.example/free")).resolves.toMatchObject({
      paymentMade: false,
      body: "free",
    });
  });

  it("signs canonical v2 exact EVM payload with the atomic amount unchanged", async () => {
    const client = newClient();
    let signedHeader: string | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const paymentSignature = new Headers(init?.headers).get("payment-signature");
      if (!paymentSignature) {
        return new Response("", {
          status: 402,
          headers: { "payment-required": paymentRequired("1000") },
        });
      }
      signedHeader = paymentSignature;
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.fetchWithPayment("https://trusted.example/paid", {
      approvePayment: ({ paymentDetails }) => paymentDetails.amount === "1000",
    });

    expect(result.paymentMade).toBe(true);
    expect(result.amountPaid).toBe("1000");
    expect(signedHeader).not.toBeNull();
    const payload = decodePayload(signedHeader!);
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted.amount).toBe("1000");
    expect(payload.payload.authorization.value).toBe("1000");
    expect(payload.payload.authorization.from.toLowerCase()).toBe(WALLET.address.toLowerCase());
    expect(payload.payload.authorization.to.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(payload.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(payload).not.toHaveProperty("payment-address");

    const recovered = ethers.verifyTypedData(
      {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: ASSET,
      },
      {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      payload.payload.authorization,
      payload.payload.signature,
    );
    expect(recovered.toLowerCase()).toBe(WALLET.address.toLowerCase());
  });

  it("selects the supported exact Base requirement from accepts", async () => {
    const client = newClient();
    const unsupported = {
      scheme: "upto",
      network: "eip155:8453",
      amount: "1",
      asset: ASSET,
      payTo: RECIPIENT,
      maxTimeoutSeconds: 300,
    };
    const required = JSON.parse(Buffer.from(paymentRequired("7"), "base64").toString("utf8"));
    required.accepts.unshift(unsupported);
    const header = Buffer.from(JSON.stringify(required)).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (!new Headers(init?.headers).get("payment-signature")) {
          return new Response("", { status: 402, headers: { "payment-required": header } });
        }
        return new Response("ok", { status: 200 });
      }),
    );

    const result = await client.fetchWithPayment("https://trusted.example/paid", {
      approvePayment: ({ paymentDetails }) => paymentDetails.amount === "7",
    });
    expect(result.paymentMade).toBe(true);
  });

  it("uses the CAIP-2 Base Sepolia chain and asset in the EIP-712 domain", async () => {
    const client = newClient();
    let signedHeader: string | null = null;
    const header = paymentRequired("1000", {
      network: "eip155:84532",
      asset: SEPOLIA_ASSET,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const signature = new Headers(init?.headers).get("payment-signature");
        if (!signature) {
          return new Response("", { status: 402, headers: { "payment-required": header } });
        }
        signedHeader = signature;
        return new Response("ok", { status: 200 });
      }),
    );

    await client.fetchWithPayment("https://trusted.example/paid", {
      approvePayment: () => true,
    });

    const payload = decodePayload(signedHeader!);
    const recovered = ethers.verifyTypedData(
      { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: SEPOLIA_ASSET },
      {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      payload.payload.authorization,
      payload.payload.signature,
    );
    expect(payload.accepted.network).toBe("eip155:84532");
    expect(payload.accepted.asset).toBe(SEPOLIA_ASSET);
    expect(recovered.toLowerCase()).toBe(WALLET.address.toLowerCase());
  });

  it.each([
    ["unsupported version", { x402Version: 1 }],
    ["unsupported network", { network: "eip155:1" }],
    ["unsupported scheme", { scheme: "upto" }],
    ["unsupported asset", { asset: "0x0000000000000000000000000000000000000001" }],
    ["missing token domain", { extra: { assetTransferMethod: "eip3009" } }],
  ])("rejects %s payment requirements", async (_name, overrides) => {
    const client = newClient();
    let header = paymentRequired("1", overrides);
    if (_name === "unsupported version") {
      const value = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      value.x402Version = 1;
      header = Buffer.from(JSON.stringify(value)).toString("base64");
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 402, headers: { "payment-required": header } })),
    );
    await expect(
      client.fetchWithPayment("https://trusted.example/paid", { approvePayment: () => true }),
    ).rejects.toThrow(/Failed to parse PAYMENT-REQUIRED header/);
  });

  it("rejects a v2 resource that is different from the requested URL", async () => {
    const client = newClient();
    const header = paymentRequired("1");
    const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    required.resource.url = "https://trusted.example/other";
    const mismatchedHeader = Buffer.from(JSON.stringify(required)).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("", { status: 402, headers: { "payment-required": mismatchedHeader } }),
      ),
    );

    await expect(
      client.fetchWithPayment("https://trusted.example/paid", { approvePayment: () => true }),
    ).rejects.toThrow(/resource does not match/i);
  });
});
