import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INFRA_SETTINGS, InfraSettings } from "../../../../shared/types";
import { CoinbaseAgenticWalletProvider } from "../coinbase-agentic-wallet-provider";

function cloneInfraSettings(): InfraSettings {
  return {
    ...DEFAULT_INFRA_SETTINGS,
    e2b: { ...DEFAULT_INFRA_SETTINGS.e2b },
    domains: { ...DEFAULT_INFRA_SETTINGS.domains },
    wallet: {
      ...DEFAULT_INFRA_SETTINGS.wallet,
      provider: "coinbase_agentic",
      coinbase: {
        ...DEFAULT_INFRA_SETTINGS.wallet.coinbase,
        enabled: true,
        signerEndpoint: "https://signer.example",
      },
    },
    payments: {
      ...DEFAULT_INFRA_SETTINGS.payments,
      allowedHosts: [...DEFAULT_INFRA_SETTINGS.payments.allowedHosts],
    },
    enabledCategories: { ...DEFAULT_INFRA_SETTINGS.enabledCategories },
  };
}

describe("CoinbaseAgenticWalletProvider", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the x402 payment policy envelope to the remote signer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CoinbaseAgenticWalletProvider();
    await provider.applySettings(cloneInfraSettings());

    const paymentPolicy = {
      policyVersion: 1 as const,
      effectiveHardLimitUsd: 100,
      maxAutoApproveUsd: 1,
      requireApproval: true,
      allowedHosts: ["paid.example"],
      preflight: {
        requires402: true,
        url: "https://paid.example/data",
      },
    };

    await provider.x402Fetch({
      url: "https://paid.example/data",
      paymentPolicy,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.paymentPolicy).toEqual(paymentPolicy);
  });

  it("rejects paid signer responses that do not confirm policy enforcement", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 200,
            body: "ok",
            headers: {},
            paymentMade: true,
            amountPaid: "1",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CoinbaseAgenticWalletProvider();
    await provider.applySettings(cloneInfraSettings());

    await expect(
      provider.x402Fetch({
        url: "https://paid.example/data",
        paymentPolicy: {
          policyVersion: 1,
          effectiveHardLimitUsd: 100,
          maxAutoApproveUsd: 1,
          requireApproval: false,
          allowedHosts: ["paid.example"],
        },
      }),
    ).rejects.toThrow(/did not confirm x402 payment policy enforcement/i);
  });

  it("accepts paid signer responses only when returned details match the policy", async () => {
    const paymentDetails = {
      payTo: "0x000000000000000000000000000000000000dEaD",
      amount: "1",
      currency: "USDC",
      network: "base",
      resource: "/data",
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 200,
            body: "ok",
            headers: {},
            paymentMade: true,
            amountPaid: "1",
            paymentPolicyEnforced: true,
            paymentDetails,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CoinbaseAgenticWalletProvider();
    await provider.applySettings(cloneInfraSettings());

    await expect(
      provider.x402Fetch({
        url: "https://paid.example/data",
        paymentPolicy: {
          policyVersion: 1,
          effectiveHardLimitUsd: 100,
          maxAutoApproveUsd: 1,
          requireApproval: true,
          allowedHosts: ["paid.example"],
          approvedPaymentDetails: paymentDetails,
        },
      }),
    ).resolves.toMatchObject({ paymentMade: true, paymentPolicyEnforced: true });
  });
});
