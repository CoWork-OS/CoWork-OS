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
  it("stages SPACE code without granting access to a host temporary script", async () => {
    const executeCode = vi
      .fn()
      .mockResolvedValue({ stdout: "remote", stderr: "", exitCode: 0, timedOut: false });
    vi.spyOn(await import("../../../admin/policies"), "loadPolicies").mockReturnValue({
      ...loadPolicies(),
      runtime: { ...loadPolicies().runtime, allowedSandboxTypes: ["space"] },
    });
    vi.mocked(createSandbox).mockResolvedValue({ type: "space", executeCode } as never);
    const tools = new CodeExecTools({
      ...workspace,
      permissions: { ...workspace.permissions, sandboxType: "space" },
    });
    const controller = new AbortController();
    await tools.executeCode({ language: "python", code: "print('remote')" }, controller.signal);
    expect(executeCode).toHaveBeenCalledWith(
      "print('remote')",
      "python",
      expect.objectContaining({ signal: expect.any(AbortSignal), allowNetwork: false }),
    );
    expect(executeCode.mock.calls[0][2].allowedReadPaths).toBeUndefined();
    controller.abort();
    expect(executeCode.mock.calls[0][2].signal.aborted).toBe(true);
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSandbox).mockResolvedValue({
      type: "macos",
      execute: vi
        .fn()
        .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false }),
    } as never);
  });

  it("disposes an initializing adapter before stale workspace code can run", async () => {
    let resolve!: (value: never) => void;
    const execute = vi.fn();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createSandbox).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const tools = new CodeExecTools(workspace);
    const execution = tools.executeCode({ language: "shell", code: "must not run" });
    const rejected = expect(execution).rejects.toThrow();
    const closed = tools.cleanup();
    resolve({ type: "space", execute, cleanup } as never);
    await rejected;
    await closed;
    await tools.cleanup();
    expect(execute).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(
      tools.executeCode({ language: "shell", code: "still forbidden" }),
    ).rejects.toThrow();
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("honors caller cancellation while adapter initialization is pending", async () => {
    let resolve!: (value: never) => void;
    const execute = vi.fn();
    vi.mocked(createSandbox).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const tools = new CodeExecTools(workspace);
    const controller = new AbortController();
    const execution = tools.executeCode(
      { language: "shell", code: "must not run" },
      controller.signal,
    );
    const rejected = expect(execution).rejects.toThrow();
    controller.abort();
    resolve({ type: "macos", execute } as never);
    await rejected;
    expect(execute).not.toHaveBeenCalled();
  });

  it("shares concurrent adapter initialization", async () => {
    let resolve!: (value: never) => void;
    const execute = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    vi.mocked(createSandbox).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const tools = new CodeExecTools(workspace);
    const first = tools.executeCode({ language: "shell", code: "first" });
    const second = tools.executeCode({ language: "shell", code: "second" });
    resolve({ type: "macos", execute } as never);
    await Promise.all([first, second]);
    expect(createSandbox).toHaveBeenCalledTimes(1);
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

  it.each(["shell", "python", "javascript"] as const)(
    "rejects on-request %s network capability before process creation",
    async (language) => {
      const tools = new CodeExecTools({
        ...workspace,
        permissions: { ...workspace.permissions, network: true, accessNetworkMode: "on-request" },
      });
      await expect(
        tools.executeCode({ language, code: "ignored", allow_network: true }),
      ).rejects.toThrow("cannot enforce per-request network grants");
      expect(createSandbox).not.toHaveBeenCalled();
    },
  );

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
