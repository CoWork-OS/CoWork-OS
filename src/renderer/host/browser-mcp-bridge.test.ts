import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeMcpApi } from "./browser-mcp-bridge";

describe("browser MCP renderer bridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds the active workspace to scoped lifecycle and install-review requests", async () => {
    const getSettings = vi.fn(async (request: unknown) => request);
    const previewInstall = vi.fn(async (request: unknown) => request);
    const install = vi.fn(async (request: unknown) => request);
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { activeWorkspaceId: "workspace-qa" },
      electronAPI: {
        getMCPSettings: getSettings,
        previewMCPServerInstall: previewInstall,
        installMCPServer: install,
      },
    } as unknown as Window);

    await expect(invokeMcpApi("getMCPSettings")).resolves.toEqual({
      workspaceId: "workspace-qa",
    });
    await invokeMcpApi("previewMCPServerInstall", "qa-echo");
    await invokeMcpApi("installMCPServer", "qa-echo", "approval-token");

    expect(previewInstall).toHaveBeenCalledWith({
      workspaceId: "workspace-qa",
      entryId: "qa-echo",
    });
    expect(install).toHaveBeenCalledWith({
      workspaceId: "workspace-qa",
      entryId: "qa-echo",
      approvalToken: "approval-token",
    });
  });

  it("requires a selected workspace and preserves native Electron signatures", async () => {
    const nativeConnect = vi.fn(async (serverId: string) => ({ serverId }));
    vi.stubGlobal("window", {
      electronAPI: { connectMCPServer: nativeConnect },
    } as unknown as Window);
    await expect(invokeMcpApi("connectMCPServer", "server-one")).resolves.toEqual({
      serverId: "server-one",
    });
    expect(nativeConnect).toHaveBeenCalledWith("server-one");

    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { activeWorkspaceId: null },
      electronAPI: { connectMCPServer: nativeConnect },
    } as unknown as Window);
    await expect(invokeMcpApi("connectMCPServer", "server-one")).rejects.toThrow(
      "Select a workspace",
    );
  });
});
