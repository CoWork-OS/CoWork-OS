import { describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  existsSync: () => false,
  readFileSync: () => "",
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  watch: vi.fn(),
}));
vi.mock("../../utils/user-data-dir", () => ({ getUserDataDir: () => "/mock/user/data" }));

import { loadPolicies, type AdminPolicies } from "../policies";
import { describePolicyRelaxations } from "../policy-relaxations";

function strict(): AdminPolicies {
  const base = loadPolicies();
  return {
    ...base,
    runtime: {
      ...base.runtime,
      requireSandboxForShell: true,
      allowUnsandboxedShell: false,
      network: { ...base.runtime.network, defaultAction: "deny", allowShellNetwork: false },
    },
  };
}

describe("describePolicyRelaxations", () => {
  it("flags turning off the shell sandbox and opening the network", () => {
    const current = strict();
    const next: AdminPolicies = {
      ...current,
      runtime: {
        ...current.runtime,
        requireSandboxForShell: false,
        network: { ...current.runtime.network, defaultAction: "allow", allowShellNetwork: true },
      },
    };
    expect(describePolicyRelaxations(current, next)).toEqual([
      "Stop requiring an OS sandbox for shell commands",
      "Allow network access by default",
      "Allow shell commands to use the network",
    ]);
  });

  it("does not ask when a change only tightens the policy", () => {
    const current = loadPolicies();
    const next: AdminPolicies = {
      ...current,
      runtime: { ...current.runtime, requireSandboxForShell: true },
      connectors: { blocked: [...current.connectors.blocked, "risky-connector"] },
    };
    expect(describePolicyRelaxations(current, next)).toEqual([]);
  });

  it("flags unblocking a connector", () => {
    const current: AdminPolicies = { ...loadPolicies(), connectors: { blocked: ["gmail"] } };
    const next: AdminPolicies = { ...current, connectors: { blocked: [] } };
    expect(describePolicyRelaxations(current, next)).toEqual(["Unblock connectors: gmail"]);
  });
});
