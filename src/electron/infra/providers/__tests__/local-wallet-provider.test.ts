import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INFRA_SETTINGS } from "../../../../shared/types";

const hoisted = vi.hoisted(() => {
  const walletManager = {
    startupCheck: vi.fn(),
    hasWallet: vi.fn(),
    getPrivateKey: vi.fn(),
    getAddress: vi.fn(),
    getNetwork: vi.fn(),
    getBalance: vi.fn(),
    generate: vi.fn(),
  };

  const x402Client = {
    setWallet: vi.fn(),
    check: vi.fn(),
    fetchWithPayment: vi.fn(),
  };

  return {
    walletManager,
    x402Client,
    x402ClientCtor: vi.fn(function x402ClientCtor() {
      return x402Client;
    }),
  };
});

vi.mock("../../wallet/wallet-manager", () => ({
  WalletManager: hoisted.walletManager,
}));

vi.mock("../x402-client", () => ({
  X402Client: hoisted.x402ClientCtor,
}));

import { LocalWalletProvider } from "../local-wallet-provider";

describe("LocalWalletProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.walletManager.startupCheck.mockReturnValue({ status: "ok", address: "0xabc" });
    hoisted.walletManager.hasWallet.mockReturnValue(true);
    hoisted.walletManager.getPrivateKey.mockReturnValue("0xprivate");
    hoisted.walletManager.getAddress.mockReturnValue("0xabc");
    hoisted.walletManager.getNetwork.mockReturnValue("base");
    hoisted.walletManager.getBalance.mockResolvedValue("12.34");
    hoisted.x402Client.check.mockResolvedValue({ requires402: false, url: "https://example.com" });
    hoisted.x402Client.fetchWithPayment.mockResolvedValue({
      status: 200,
      body: "ok",
      headers: {},
      paymentMade: false,
    });
  });

  it("initializes from existing local wallet and configures x402 signer", async () => {
    const provider = new LocalWalletProvider();

    await provider.initialize();

    expect(hoisted.walletManager.startupCheck).toHaveBeenCalledTimes(1);
    expect(hoisted.x402Client.setWallet).toHaveBeenCalledWith("0xprivate", "0xabc");
  });

  it("generates wallet during ensureWallet when missing", async () => {
    hoisted.walletManager.hasWallet.mockReturnValueOnce(false).mockReturnValue(true);

    const provider = new LocalWalletProvider();
    await provider.ensureWallet();

    expect(hoisted.walletManager.generate).toHaveBeenCalledTimes(1);
    expect(hoisted.x402Client.setWallet).toHaveBeenCalledWith("0xprivate", "0xabc");
  });

  it("delegates x402 fetch with headers/body", async () => {
    const provider = new LocalWalletProvider();
    await provider.applySettings(DEFAULT_INFRA_SETTINGS);

    await provider.x402Fetch({
      url: "https://paid.example/data",
      method: "POST",
      body: "{\"q\":1}",
      headers: { "x-test": "1" },
    });

    expect(hoisted.x402Client.fetchWithPayment).toHaveBeenCalledWith("https://paid.example/data", {
      method: "POST",
      body: "{\"q\":1}",
      headers: { "x-test": "1" },
    });
  });
});
