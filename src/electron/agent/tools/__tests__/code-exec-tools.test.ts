import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { CodeExecTools } from "../code-exec-tools";
import { loadPolicies } from "../../../admin/policies";
import { createSandbox } from "../../sandbox/sandbox-factory";

vi.mock("../../sandbox/sandbox-factory", () => ({ createSandbox: vi.fn() }));

const workspace: Workspace = {
  id: "code-test",
  name: "Code test",
  path: "/tmp/code-test",
  createdAt: 0,
  permissions: { read: true, write: true, delete: true, shell: true, network: false },
};

describe("execute_code capability boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSandbox).mockResolvedValue({
      type: "macos",
      execute: vi
        .fn()
        .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false }),
    } as never);
  });

  it.each(["shell", "python", "javascript"] as const)(
    "rejects %s before creating a sandbox without shell authority",
    async (language) => {
      const tools = new CodeExecTools({
        ...workspace,
        permissions: { ...workspace.permissions, shell: false },
      });
      await expect(tools.executeCode({ language, code: "ignored" })).rejects.toThrow(
        "shell permission",
      );
      expect(createSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(["shell", "python", "javascript"] as const)(
    "rejects administrator-disallowed %s networking before process creation",
    async (language) => {
      const policies = loadPolicies();
      vi.spyOn(await import("../../../admin/policies"), "loadPolicies").mockReturnValue({
        ...policies,
        runtime: {
          ...policies.runtime,
          network: { ...policies.runtime.network, allowShellNetwork: false },
        },
      });
      const tools = new CodeExecTools({
        ...workspace,
        permissions: { ...workspace.permissions, network: true },
      });
      await expect(
        tools.executeCode({ language, code: "ignored", allow_network: true }),
      ).rejects.toThrow("administrator policy");
      expect(createSandbox).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    },
  );
  it("rejects a truthy nonboolean network request before process creation", async () => {
    const tools = new CodeExecTools(workspace);
    await expect(
      tools.executeCode({ language: "shell", code: "ignored", allow_network: "true" } as Any),
    ).rejects.toThrow("must be a boolean");
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("rejects implicit networking in the unsandboxed backend", async () => {
    vi.mocked(createSandbox).mockResolvedValue({ type: "none", execute: vi.fn() } as never);
    const tools = new CodeExecTools({
      ...workspace,
      permissions: {
        ...workspace.permissions,
        network: true,
        accessSandboxMode: "danger-full-access",
        accessApprovalPolicy: "never",
        unrestrictedFileAccess: true,
      },
    });
    await expect(
      tools.executeCode({ language: "javascript", code: "ignored", allow_network: false }),
    ).rejects.toThrow("cannot enforce network restrictions");
  });
  it("preserves authorized execution and output", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    vi.mocked(createSandbox).mockResolvedValue({ type: "macos", execute } as never);
    const tools = new CodeExecTools(workspace);
    await expect(
      tools.executeCode({ language: "shell", code: "printf ok" }),
    ).resolves.toMatchObject({ stdout: "ok", exit_code: 0 });
    expect(execute).toHaveBeenCalledWith(
      "printf ok",
      [],
      expect.objectContaining({ allowNetwork: false }),
    );
  });
});
