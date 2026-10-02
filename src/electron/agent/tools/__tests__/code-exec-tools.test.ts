import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { CodeExecTools } from "../code-exec-tools";
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
