import { describe, expect, it, vi, beforeEach } from "vitest";
import { DEFAULT_INFRA_SETTINGS, InfraSettings } from "../../../shared/types";
import { InfraManager } from "../infra-manager";
import { InfraSettingsManager } from "../infra-settings";
import { InfraTools } from "../infra-tools";

function cloneInfraSettings(): InfraSettings {
  return {
    ...DEFAULT_INFRA_SETTINGS,
    enabled: true,
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

describe("InfraTools x402 payment policy", () => {
  const managerMock = {
    x402Check: vi.fn(),
    x402Fetch: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ enabled: true }),
    getWalletInfo: vi.fn().mockReturnValue({ network: "base" }),
    getWalletInfoWithBalance: vi.fn(),
    getWalletBalance: vi.fn(),
    sandboxCreate: vi.fn(),
    sandboxExec: vi.fn(),
    sandboxWriteFile: vi.fn(),
    sandboxReadFile: vi.fn(),
    sandboxList: vi.fn(),
    sandboxDelete: vi.fn(),
    sandboxGetUrl: vi.fn(),
    domainSearch: vi.fn(),
    domainRegister: vi.fn(),
    domainList: vi.fn(),
    domainDnsList: vi.fn(),
    domainDnsAdd: vi.fn(),
    domainDnsDelete: vi.fn(),
  };

  const daemonMock = {
    logEvent: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(true),
  };

  const workspace = { id: "w1", path: "/tmp", permissions: {} } as Any;

  beforeEach(() => {
    vi.restoreAllMocks();
    daemonMock.logEvent.mockReset();
    daemonMock.requestApproval.mockReset();
    daemonMock.requestApproval.mockResolvedValue(true);
    managerMock.x402Check.mockReset();
    managerMock.x402Fetch.mockReset();
    vi.spyOn(InfraManager, "getInstance").mockReturnValue(managerMock as Any);
  });

  it("blocks x402 fetch when preflight amount exceeds hard limit", async () => {
    const settings = cloneInfraSettings();
    settings.payments.hardLimitUsd = 2;
    settings.payments.allowedHosts = ["trusted.example"];

    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: true,
      paymentDetails: { amount: "5.0" },
      url: "https://trusted.example/data",
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-1");
    const result = await tools.executeTool("x402_fetch", {
      url: "https://trusted.example/data",
    });

    expect(result.error).toMatch(/exceeds configured hard limit/i);
    expect(daemonMock.requestApproval).not.toHaveBeenCalled();
    expect(managerMock.x402Fetch).not.toHaveBeenCalled();
  });

  it("requires approval when amount is unknown even with requireApproval=false", async () => {
    const settings = cloneInfraSettings();
    settings.payments.requireApproval = false;
    settings.payments.maxAutoApproveUsd = 10;
    settings.payments.allowedHosts = ["trusted.example"];

    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: true,
      url: "https://trusted.example/unknown",
    });
    managerMock.x402Fetch.mockResolvedValue({
      status: 200,
      body: "ok",
      headers: {},
      paymentMade: true,
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-2");
    await tools.executeTool("x402_fetch", {
      url: "https://trusted.example/unknown",
    });

    expect(daemonMock.requestApproval).toHaveBeenCalledTimes(1);
    expect(daemonMock.requestApproval.mock.calls[0][4]).toEqual({ allowAutoApprove: false });
    expect(managerMock.x402Fetch).toHaveBeenCalledTimes(1);
  });

  it("skips approval for small payment when auto-approve settings allow it", async () => {
    const settings = cloneInfraSettings();
    settings.payments.requireApproval = false;
    settings.payments.maxAutoApproveUsd = 2;
    settings.payments.hardLimitUsd = 50;
    settings.payments.allowedHosts = ["trusted.example"];

    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: true,
      paymentDetails: { amount: "1.25" },
      url: "https://trusted.example/small",
    });
    managerMock.x402Fetch.mockResolvedValue({
      status: 200,
      body: "ok",
      headers: {},
      paymentMade: true,
      amountPaid: "1.25",
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-3");
    const result = await tools.executeTool("x402_fetch", {
      url: "https://trusted.example/small",
    });

    expect(result.error).toBeUndefined();
    expect(daemonMock.requestApproval).not.toHaveBeenCalled();
    expect(managerMock.x402Fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks x402 requests to hosts outside allowlist", async () => {
    const settings = cloneInfraSettings();
    settings.payments.allowedHosts = ["allowed.example"];

    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);

    const tools = new InfraTools(workspace, daemonMock as Any, "task-4");
    const result = await tools.executeTool("x402_fetch", {
      url: "https://blocked.example/data",
    });

    expect(result.error).toMatch(/not in the allowed hosts list/i);
    expect(managerMock.x402Check).not.toHaveBeenCalled();
    expect(managerMock.x402Fetch).not.toHaveBeenCalled();
  });

  it("does not treat non-wildcard allowed hosts as suffix wildcards", async () => {
    const settings = cloneInfraSettings();
    settings.payments.allowedHosts = ["api.example.com"];

    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);

    const tools = new InfraTools(workspace, daemonMock as Any, "task-5");
    const result = await tools.executeTool("x402_fetch", {
      url: "https://evil.api.example.com/data",
    });

    expect(result.error).toMatch(/not in the allowed hosts list/i);
    expect(managerMock.x402Check).not.toHaveBeenCalled();
    expect(managerMock.x402Fetch).not.toHaveBeenCalled();
  });
});
