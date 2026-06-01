import { beforeEach, describe, expect, it, vi } from "vitest";
import { X402Client } from "../x402-client";

function paymentHeader(amount: string): string {
  return Buffer.from(
    JSON.stringify({
      payTo: "0x000000000000000000000000000000000000dEaD",
      amount,
      currency: "USDC",
      network: "base",
      resource: "/paid",
    }),
  ).toString("base64");
}

describe("X402Client", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires approval of the real payment challenge before signing and retrying", async () => {
    const client = new X402Client();
    client.setWallet(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "0x0000000000000000000000000000000000000001",
    );

    const fetchMock = vi.fn(async () => {
      return new Response("", {
        status: 402,
        headers: { "payment-required": paymentHeader("10") },
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
    const client = new X402Client();
    client.setWallet(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "0x0000000000000000000000000000000000000001",
    );

    const fetchMock = vi.fn(async () => {
      return new Response("", {
        status: 402,
        headers: { "payment-required": paymentHeader("10") },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.fetchWithPayment("https://trusted.example/paid")).rejects.toThrow(
      /approval handler is required/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not require an approval handler when no payment is requested", async () => {
    const client = new X402Client();
    client.setWallet(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "0x0000000000000000000000000000000000000001",
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response("free", { status: 200 })));

    await expect(client.fetchWithPayment("https://trusted.example/free")).resolves.toMatchObject({
      paymentMade: false,
      body: "free",
    });
  });

  it("signs the actual challenge amount after approval", async () => {
    const client = new X402Client();
    client.setWallet(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "0x0000000000000000000000000000000000000001",
    );

    const seenSignatures: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signature = init?.headers && (init.headers as Record<string, string>)["payment-signature"];
      if (!signature) {
        return new Response("", {
          status: 402,
          headers: { "payment-required": paymentHeader("2") },
        });
      }
      seenSignatures.push(signature);
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.fetchWithPayment("https://trusted.example/paid", {
      approvePayment: ({ paymentDetails }) => paymentDetails.amount === "2",
    });

    expect(result.paymentMade).toBe(true);
    expect(result.amountPaid).toBe("2");
    const signedPayload = JSON.parse(Buffer.from(seenSignatures[0], "base64").toString("utf8"));
    expect(signedPayload.amount).toBe("2000000");
  });
});
