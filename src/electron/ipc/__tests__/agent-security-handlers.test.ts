import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/types";

const { dialogMock, handlers, serviceMock } = vi.hoisted(() => ({
  dialogMock: vi.fn(),
  handlers: new Map<string, (...args: Any[]) => Promise<unknown>>(),
  serviceMock: {
    installHook: vi.fn(),
    uninstallHook: vi.fn(),
    prune: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showMessageBox: dialogMock },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: Any[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock("../../security/numbat", () => ({
  getNumbatService: vi.fn(() => serviceMock),
}));

import { setupAgentSecurityHandlers } from "../agent-security-handlers";

describe("agent security IPC mutation confirmation", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    setupAgentSecurityHandlers();
  });

  it("does not install a hook when native confirmation is cancelled", async () => {
    dialogMock.mockResolvedValueOnce({ response: 0 });
    const handler = handlers.get(IPC_CHANNELS.AGENT_SECURITY_HOOK_INSTALL)!;

    await expect(handler({ sender: {} }, "codex")).rejects.toThrow(/cancelled/i);
    expect(serviceMock.installHook).not.toHaveBeenCalled();
  });

  it("allows confirmed hook installation and pruning", async () => {
    dialogMock.mockResolvedValue({ response: 1 });
    serviceMock.installHook.mockResolvedValueOnce({ ok: true });
    serviceMock.prune.mockReturnValueOnce({ findings: 1, decisions: 2, diagnostics: 3 });

    await expect(
      handlers.get(IPC_CHANNELS.AGENT_SECURITY_HOOK_INSTALL)!({ sender: {} }, "codex"),
    ).resolves.toEqual({ ok: true });
    await expect(handlers.get(IPC_CHANNELS.AGENT_SECURITY_PRUNE)!({ sender: {} })).resolves.toEqual(
      { findings: 1, decisions: 2, diagnostics: 3 },
    );
    expect(serviceMock.installHook).toHaveBeenCalledWith("codex");
    expect(serviceMock.prune).toHaveBeenCalledTimes(1);
  });
});
