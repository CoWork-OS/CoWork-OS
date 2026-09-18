import { describe, expect, it, vi, beforeEach } from "vitest";
import { DEFAULT_INFRA_SETTINGS, InfraSettings } from "../../../shared/types";
import { InfraManager } from "../infra-manager";
import { InfraSettingsManager } from "../infra-settings";
import { InfraTools } from "../infra-tools";

const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

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

function paymentDetails(
  amount = "1250000",
  url = "https://trusted.example/data",
  overrides: Record<string, unknown> = {},
) {
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
    resource: { url },
    accepts: [requirement],
    selectedRequirement: { ...requirement },
    resourceUrl: url,
    scheme: requirement.scheme,
    payTo: requirement.payTo,
    amount: requirement.amount,
    asset: requirement.asset,
    network: requirement.network,
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

  it("uses canonical atomic accepts[].amount for the preflight hard limit", async () => {
    const settings = cloneInfraSettings();
    settings.payments.hardLimitUsd = 2;
    settings.payments.allowedHosts = ["trusted.example"];
    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: true,
      paymentDetails: paymentDetails("5000000"),
      url: "https://trusted.example/data",
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-1");
    const result = await tools.executeTool("x402_fetch", { url: "https://trusted.example/data" });

    expect(result.error).toMatch(/exceeds configured hard limit/i);
    expect(daemonMock.requestApproval).not.toHaveBeenCalled();
    expect(managerMock.x402Fetch).not.toHaveBeenCalled();
  });

  it("requires approval when the preflight amount is unknown", async () => {
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
    await tools.executeTool("x402_fetch", { url: "https://trusted.example/unknown" });

    expect(daemonMock.requestApproval).toHaveBeenCalledTimes(1);
    expect(daemonMock.requestApproval.mock.calls[0][4]).toEqual({ allowAutoApprove: false });
  });

  it("auto-approves a canonical amount below the configured cap", async () => {
    const settings = cloneInfraSettings();
    settings.payments.requireApproval = false;
    settings.payments.maxAutoApproveUsd = 2;
    settings.payments.hardLimitUsd = 50;
    settings.payments.allowedHosts = ["trusted.example"];
    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: true,
      paymentDetails: paymentDetails("1250000", "https://trusted.example/small"),
      url: "https://trusted.example/small",
    });
    managerMock.x402Fetch.mockResolvedValue({
      status: 200,
      body: "ok",
      headers: {},
      paymentMade: true,
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-3");
    const result = await tools.executeTool("x402_fetch", { url: "https://trusted.example/small" });

    expect(result.error).toBeUndefined();
    expect(daemonMock.requestApproval).not.toHaveBeenCalled();
  });

  it("blocks a real canonical challenge that exceeds the hard limit", async () => {
    const settings = cloneInfraSettings();
    settings.payments.requireApproval = false;
    settings.payments.maxAutoApproveUsd = 10;
    settings.payments.hardLimitUsd = 20;
    settings.payments.allowedHosts = ["trusted.example"];
    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: true,
      paymentDetails: paymentDetails("10000"),
      url: "https://trusted.example/data",
    });
    managerMock.x402Fetch.mockImplementation(async (_url, opts) => {
      await opts.approvePayment({
        url: "https://trusted.example/data",
        method: "GET",
        paymentDetails: paymentDetails("50000000"),
      });
      return { status: 200, body: "ok", headers: {}, paymentMade: true };
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-real-limit");
    const result = await tools.executeTool("x402_fetch", { url: "https://trusted.example/data" });

    expect(result.error).toMatch(/exceeds configured hard limit/i);
    expect(daemonMock.requestApproval).not.toHaveBeenCalled();
  });

  it("requires approval for a real challenge when HEAD preflight is free", async () => {
    const settings = cloneInfraSettings();
    settings.payments.requireApproval = true;
    settings.payments.allowedHosts = ["trusted.example"];
    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: false,
      url: "https://trusted.example/data",
    });
    managerMock.x402Fetch.mockImplementation(async (_url, opts) => {
      const approved = await opts.approvePayment({
        url: "https://trusted.example/data",
        method: "GET",
        paymentDetails: paymentDetails(),
      });
      expect(approved).toBe(true);
      return { status: 200, body: "ok", headers: {}, paymentMade: true, amountPaid: "1250000" };
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-real-approval");
    const result = await tools.executeTool("x402_fetch", { url: "https://trusted.example/data" });

    expect(result.error).toBeUndefined();
    expect(daemonMock.requestApproval).toHaveBeenCalledTimes(1);
    expect(daemonMock.requestApproval.mock.calls[0][2]).toMatch(/Amount: 1\.25 USDC/);
  });

  it("rejects a changed nested requirement after preflight", async () => {
    const settings = cloneInfraSettings();
    settings.payments.requireApproval = true;
    settings.payments.allowedHosts = ["trusted.example"];
    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: true,
      paymentDetails: paymentDetails("1250000"),
      url: "https://trusted.example/data",
    });
    managerMock.x402Fetch.mockImplementation(async (_url, opts) => {
      await opts.approvePayment({
        url: "https://trusted.example/data",
        method: "GET",
        paymentDetails: paymentDetails("1500000", "https://trusted.example/data", {
          payTo: "0x000000000000000000000000000000000000bEEF",
        }),
      });
      return { status: 200, body: "ok", headers: {}, paymentMade: true };
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-mismatch");
    const result = await tools.executeTool("x402_fetch", { url: "https://trusted.example/data" });

    expect(result.error).toMatch(/requirement changed after preflight/i);
    expect(daemonMock.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("rejects legacy flattened challenges", async () => {
    const settings = cloneInfraSettings();
    settings.payments.requireApproval = true;
    settings.payments.allowedHosts = ["trusted.example"];
    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: false,
      url: "https://trusted.example/data",
    });
    managerMock.x402Fetch.mockImplementation(async (_url, opts) => {
      await opts.approvePayment({
        url: "https://trusted.example/data",
        method: "GET",
        paymentDetails: {
          payTo: RECIPIENT,
          amount: "1250000",
          network: "eip155:8453",
          resource: "/data",
        },
      });
      return { status: 200, body: "ok", headers: {}, paymentMade: true };
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-legacy");
    const result = await tools.executeTool("x402_fetch", { url: "https://trusted.example/data" });

    expect(result.error).toMatch(/canonical v2 shape/i);
    expect(daemonMock.requestApproval).not.toHaveBeenCalled();
  });

  it("does not lose precision for atomic amounts above JavaScript safe integer range", async () => {
    const settings = cloneInfraSettings();
    settings.payments.hardLimitUsd = 1;
    settings.payments.allowedHosts = ["trusted.example"];
    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);
    managerMock.x402Check.mockResolvedValue({
      requires402: true,
      paymentDetails: paymentDetails("9007199254740993"),
      url: "https://trusted.example/data",
    });

    const tools = new InfraTools(workspace, daemonMock as Any, "task-bigint");
    const result = await tools.executeTool("x402_fetch", { url: "https://trusted.example/data" });

    expect(result.error).toMatch(/exceeds configured hard limit/i);
    expect(result.error).toContain("9007199254");
  });

  it("blocks x402 requests to hosts outside the allowlist", async () => {
    const settings = cloneInfraSettings();
    settings.payments.allowedHosts = ["allowed.example"];
    vi.spyOn(InfraSettingsManager, "loadSettings").mockReturnValue(settings);

    const tools = new InfraTools(workspace, daemonMock as Any, "task-host");
    const result = await tools.executeTool("x402_fetch", { url: "https://blocked.example/data" });

    expect(result.error).toMatch(/not in the allowed hosts list/i);
    expect(managerMock.x402Check).not.toHaveBeenCalled();
  });
});
