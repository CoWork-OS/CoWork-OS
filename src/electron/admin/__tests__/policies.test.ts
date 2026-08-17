import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  watch: vi.fn(),
}));

vi.mock("fs", () => mockFs);

vi.mock("../../utils/user-data-dir", () => ({
  getUserDataDir: () => "/mock/user/data",
}));

import { validatePolicies } from "../policies";

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("validatePolicies", () => {
  it("accepts non-conflicting pack policy lists", () => {
    expect(
      validatePolicies({
        packs: {
          allowed: ["alpha", "beta"],
          blocked: ["blocked-pack"],
          required: ["alpha"],
        },
      }),
    ).toBeNull();
  });

  it("rejects required IDs that are also blocked", () => {
    expect(
      validatePolicies({
        packs: {
          allowed: [],
          blocked: ["shared-pack"],
          required: ["shared-pack", "other-pack"],
        },
      }),
    ).toBe("A pack ID cannot be both required and blocked");
  });

  it("requires required IDs to be in allowlist when allowlist is set", () => {
    expect(
      validatePolicies({
        packs: {
          allowed: ["core-pack"],
          blocked: [],
          required: ["missing-pack"],
        },
      }),
    ).toBe("All required packs must also be in allowed list when allowlist is set");
  });

  it("accepts runtime safety policies", () => {
    expect(
      validatePolicies({
        runtime: {
          allowedPermissionModes: ["default", "dangerous_only"],
          allowedSandboxTypes: ["macos", "docker"],
          requireSandboxForShell: true,
          allowUnsandboxedShell: false,
          network: {
            defaultAction: "deny",
            allowedDomains: ["docs.example.com"],
            blockedDomains: ["*.tracking.example"],
            allowShellNetwork: false,
          },
          telemetry: {
            enabled: true,
            otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
          },
        },
      }),
    ).toBeNull();
  });

  it("rejects invalid runtime sandbox types", () => {
    expect(
      validatePolicies({
        runtime: {
          allowedSandboxTypes: ["bare-metal"],
        },
      }),
    ).toBe("runtime.allowedSandboxTypes contains an invalid sandbox type");
  });

  it("rejects invalid shell network policy type", () => {
    expect(
      validatePolicies({
        runtime: {
          network: {
            allowShellNetwork: "yes",
          },
        },
      }),
    ).toBe("runtime.network.allowShellNetwork must be a boolean");
  });

  it("accepts a complete agent security policy", () => {
    expect(
      validatePolicies({
        runtime: {
          agentSecurity: {
            enabled: true,
            mode: "enforce",
            ruleProfile: "custom",
            customRuleDirs: ["/opt/cowork/numbat-rules"],
            failurePolicy: "deny_high_risk",
            timeoutMs: 2_000,
            retentionDays: 45,
            scheduledScan: {
              enabled: true,
              intervalHours: 12,
            },
          },
        },
      }),
    ).toBeNull();
  });

  it("rejects agent security timeouts outside the bounded range", () => {
    expect(
      validatePolicies({
        runtime: {
          agentSecurity: {
            timeoutMs: 20_000,
          },
        },
      }),
    ).toBe("runtime.agentSecurity.timeoutMs must be between 250 and 5000");
  });

  it("accepts Everyday Agent admin policy controls", () => {
    expect(
      validatePolicies({
        everydayAgent: {
          blocked: false,
          blockedBundles: ["browser", "screen_context"],
          forceReviewOnly: true,
          maxHeartbeatCadenceMinutes: 15,
          maxConcurrentBackgroundWork: 1,
        },
      }),
    ).toBeNull();
  });

  it("rejects invalid Everyday Agent bundles", () => {
    expect(
      validatePolicies({
        everydayAgent: {
          blockedBundles: ["browser", "all_the_things"],
        },
      }),
    ).toBe("everydayAgent.blockedBundles contains an invalid bundle");
  });
});

describe("loadPoliciesStrict", () => {
  it("does not fall back to permissive defaults when an existing policy file is invalid", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("{");
    const { loadPoliciesStrict: freshLoadPoliciesStrict } = await import("../policies");

    expect(freshLoadPoliciesStrict()).toBeNull();
  });

  it("keeps the last valid policy when a later read is invalid", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync
      .mockReturnValueOnce(JSON.stringify({ packs: { blocked: ["smb-complete"] } }))
      .mockReturnValueOnce("{");
    const { loadPoliciesStrict: freshLoadPoliciesStrict } = await import("../policies");

    expect(freshLoadPoliciesStrict()?.packs.blocked).toEqual(["smb-complete"]);
    expect(freshLoadPoliciesStrict()?.packs.blocked).toEqual(["smb-complete"]);
  });

  it("rejects invalid Everyday Agent bundles before normalization can drop them", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ everydayAgent: { blockedBundles: ["browser", "all_the_things"] } }),
    );
    const { loadPoliciesStrict: freshLoadPoliciesStrict } = await import("../policies");

    expect(freshLoadPoliciesStrict()).toBeNull();
  });

  it("loadPolicies remains permissive only when no valid policy is available", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("{");
    const { loadPolicies: freshLoadPolicies } = await import("../policies");

    expect(freshLoadPolicies().packs.blocked).toEqual([]);
  });

  it("migrates legacy policies to disabled monitor-mode agent security", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        runtime: {
          network: {
            defaultAction: "deny",
          },
        },
      }),
    );
    const { loadPoliciesStrict: freshLoadPoliciesStrict } = await import("../policies");

    expect(freshLoadPoliciesStrict()?.version).toBe(2);
    expect(freshLoadPoliciesStrict()?.runtime.agentSecurity).toEqual(
      expect.objectContaining({
        enabled: false,
        mode: "monitor",
        ruleProfile: "recommended",
        failurePolicy: "open",
      }),
    );
  });
});

describe("policy change notifications", () => {
  it("notifies watchers synchronously when policies are saved in-process", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const close = vi.fn();
    mockFs.watch.mockReturnValue({ on: vi.fn(), close });
    const {
      loadPolicies: freshLoadPolicies,
      savePolicies: freshSavePolicies,
      watchPolicies: freshWatchPolicies,
    } = await import("../policies");
    const onChange = vi.fn();
    const cleanup = freshWatchPolicies(onChange);

    freshSavePolicies(freshLoadPolicies());

    expect(onChange).toHaveBeenCalledTimes(1);
    cleanup();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
