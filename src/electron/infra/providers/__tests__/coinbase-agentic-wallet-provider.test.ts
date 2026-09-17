import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INFRA_SETTINGS, InfraSettings } from "../../../../shared/types";
import { CoinbaseAgenticWalletProvider } from "../coinbase-agentic-wallet-provider";

const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

function paymentDetails(amount = "1000000", overrides: Record<string, unknown> = {}) {
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
  return {
    x402Version: 2 as const,
    resource: { url: "https://paid.example/data" },
    accepts: [requirement],
    selectedRequirement: { ...requirement },
    resourceUrl: "https://paid.example/data",
    scheme: requirement.scheme,
    payTo: requirement.payTo,
    amount: requirement.amount,
    asset: requirement.asset,
    network: requirement.network,
  };
}

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
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
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

  it("normalizes a raw canonical v2 preflight response", async () => {
    const details = paymentDetails();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            requires402: true,
            url: "https://paid.example/data",
            paymentDetails: {
              x402Version: details.x402Version,
              resource: details.resource,
              accepts: details.accepts,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CoinbaseAgenticWalletProvider();
    await provider.applySettings(cloneInfraSettings());
    const result = await provider.x402Check("https://paid.example/data");

    expect(result.paymentDetails?.selectedRequirement.amount).toBe("1000000");
    expect(result.paymentDetails?.resource.url).toBe("https://paid.example/data");
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
    const details = paymentDetails();
    const rawDetails = {
      x402Version: details.x402Version,
      resource: details.resource,
      accepts: details.accepts,
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 200,
            body: "ok",
            headers: {},
            paymentMade: true,
            amountPaid: "1000000",
            paymentPolicyEnforced: true,
            paymentDetails: rawDetails,
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
          approvedPaymentDetails: details,
        },
      }),
    ).resolves.toMatchObject({ paymentMade: true, paymentPolicyEnforced: true });
  });

  it("rejects legacy flattened signer details", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 200,
            body: "ok",
            headers: {},
            paymentMade: true,
            paymentPolicyEnforced: true,
            paymentDetails: {
              payTo: RECIPIENT,
              amount: "1",
              network: "base",
              resource: "/data",
            },
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
    ).rejects.toThrow(/non-canonical x402 v2/i);
  });

  it("rejects a signer response when nested token-domain metadata changes", async () => {
    const expected = paymentDetails();
    const actual = paymentDetails("1000000", {
      extra: { name: "USD Coin", version: "9", assetTransferMethod: "eip3009" },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 200,
            body: "ok",
            headers: {},
            paymentMade: true,
            paymentPolicyEnforced: true,
            paymentDetails: actual,
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
          approvedPaymentDetails: expected,
        },
      }),
    ).rejects.toThrow(/accepts mismatch/i);
  });
});
