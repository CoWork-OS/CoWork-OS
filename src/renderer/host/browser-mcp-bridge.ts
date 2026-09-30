/** Routes shared MCP settings calls through the authenticated host in browser mode. */
export function invokeMcpApi<T>(method: string, ...args: unknown[]): Promise<T> {
  const electronApi = window.electronAPI as unknown as Record<string, unknown>;
  const handler = electronApi[method];
  if (typeof handler !== "function") {
    return Promise.reject(new Error(`The MCP method ${method} is not available.`));
  }

  if (window.coworkBrowserHost !== true) {
    return Reflect.apply(handler, window.electronAPI, args) as Promise<T>;
  }

  const workspaceId = window.coworkBrowserHostInfo?.activeWorkspaceId?.trim();
  if (!workspaceId) {
    return Promise.reject(new Error("Select a workspace before managing MCP servers."));
  }
  const request = makeBrowserMcpRequest(method, args, workspaceId);
  return Reflect.apply(handler, window.electronAPI, [request]) as Promise<T>;
}

function makeBrowserMcpRequest(method: string, args: unknown[], workspaceId: string): unknown {
  switch (method) {
    case "getMCPSettings":
    case "getMCPStatus":
    case "getMCPAllTools":
    case "fetchMCPRegistry":
    case "checkMCPUpdates":
      return { workspaceId };
    case "searchMCPRegistry":
      return { workspaceId, query: args[0], tags: args[1] };
    case "previewMCPServerInstall":
      return { workspaceId, entryId: args[0] };
    case "previewMCPServerUpdate":
      return { workspaceId, serverId: args[0] };
    case "installMCPServer":
      return { workspaceId, entryId: args[0], approvalToken: args[1] };
    case "saveMCPSettings":
      return { workspaceId, settings: args[0] };
    case "addMCPServer":
      return { workspaceId, config: args[0] };
    case "updateMCPServer":
      return { workspaceId, serverId: args[0], updates: args[1] };
    case "uninstallMCPServer":
    case "removeMCPServer":
    case "connectMCPServer":
    case "disconnectMCPServer":
    case "getMCPServerStatus":
    case "getMCPServerTools":
    case "testMCPServer":
      return { workspaceId, serverId: args[0] };
    case "updateMCPServerFromRegistry":
      return { workspaceId, serverId: args[0], approvalToken: args[1] };
    default:
      throw new Error(`The browser host does not support MCP method ${method}.`);
  }
}
