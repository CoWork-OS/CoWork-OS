import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INFRA_SETTINGS, InfraSettings } from "../../../shared/types";
import { InfraManager } from "../infra-manager";
import { InfraSettingsManager } from "../infra-settings";
import { CoinbaseAgenticWalletProvider } from "../providers/coinbase-agentic-wallet-provider";

function cloneInfraSettings(): InfraSettings {
  return {
    ...DEFAULT_INFRA_SETTINGS,
    e2b: { ...DEFAULT_INFRA_SETTINGS.e2b },
    domains: { ...DEFAULT_INFRA_SETTINGS.domains },
    wallet: {
      ...DEFAULT_INFRA_SETTINGS.wallet,
      coinbase: { ...DEFAULT_INFRA_SETTINGS.wallet.coinbase },
    },
    payments: {
      ...DEFAULT_INFRA_SETTINGS.payments,
      allowedHosts: [...DEFAULT_INFRA_SETTINGS.payments.allowedHosts],
    },
    enabledCategories: { ...DEFAULT_INFRA_SETTINGS.enabledCategories },
  };
}

describe("InfraManager.setup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (InfraManager as Any).instance = null;
  });

  it("does not call ensureWallet for incomplete coinbase provider config", async () => {
    const settings = cloneInfraSettings();
    settings.enabled = false;
    settings.wallet.provider = "coinbase_agentic";
    settings.wallet.coinbase.enabled = false;
    settings.wallet.coinbase.signerEndpoint = "";

    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    vi.spyOn(InfraSettingsManager, "saveSettings").mockImplementation(() => {});

    const ensureSpy = vi
      .spyOn(CoinbaseAgenticWalletProvider.prototype, "ensureWallet")
      .mockResolvedValue(undefined);

    const manager = InfraManager.getInstance();
    await expect(manager.setup()).resolves.toBeTruthy();
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("clears cached wallet state when provider has no wallet", async () => {
    const manager = InfraManager.getInstance();
    const providerMock = {
      hasWallet: vi.fn().mockResolvedValue(false),
    };

    (manager as Any).walletProvider = providerMock;
    (manager as Any).walletProviderConnected = true;
    (manager as Any).cachedWalletAddress = "0xabc";
    (manager as Any).cachedBalance = "12.34";

    await expect(manager.getWalletBalance()).resolves.toBe("0.00");
    expect((manager as Any).walletProviderConnected).toBe(false);
    expect((manager as Any).cachedWalletAddress).toBeNull();
    expect((manager as Any).cachedBalance).toBe("0.00");
  });
});
