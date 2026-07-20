import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getToken: vi.fn(), refreshToken: vi.fn() }));

vi.mock("../../../settings/google-workspace-manager", () => ({
  GoogleWorkspaceSettingsManager: {
    loadSettings: () => ({
      enabled: true,
      timeoutMs: 5_000,
      accounts: [
        { email: "one@example.com", accessToken: "token-one" },
        { email: "two@example.com", accessToken: "token-two" },
      ],
    }),
  },
}));

vi.mock("../../../utils/google-workspace-auth", () => ({
  getGoogleWorkspaceAccessToken: auth.getToken,
  refreshGoogleWorkspaceAccessToken: auth.refreshToken,
}));

import { createRoutineWorkflowActionExecutor } from "../action-executor";
import { MCPClientManager } from "../../../mcp/client/MCPClientManager";

describe("Routine workflow action executor", () => {
  beforeEach(() => {
    auth.getToken.mockReset();
    auth.getToken.mockImplementation(async (settings: Any) => settings.accessToken);
    auth.refreshToken.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ updates: { updatedRows: 1 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the workflow-bound Google account for first-party actions", async () => {
    const execute = createRoutineWorkflowActionExecutor({
      createAgentTask: vi.fn(),
      getTaskSnapshot: vi.fn(),
    });

    const result = await execute({
      routine: {
        id: "routine-1",
        name: "Sheet flow",
        workspaceId: "workspace-1",
        workflow: { accountBindings: { "google-workspace": "one@example.com" } },
      } as Any,
      workflow: {
        version: 1,
        starterNodeId: "starter",
        nodes: [],
        edges: [],
        accountBindings: { "google-workspace": "two@example.com" },
      },
      node: {
        id: "sheet",
        kind: "action",
        operation: "sheets.add_row",
        name: "Add row",
        config: {},
      },
      input: { spreadsheetId: "sheet-1", range: "Sheet1!A:B", values: ["a", "b"] },
      runId: "run-1",
      stepId: "step-1",
      dryRun: false,
      signal: new AbortController().signal,
    });

    expect(auth.getToken).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "token-two" }),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/spreadsheets/sheet-1/values/Sheet1!A%3AB:append"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token-two" }),
        body: JSON.stringify({ values: [["a", "b"]] }),
      }),
    );
    expect(result).toMatchObject({ updates: { updatedRows: 1 }, spreadsheetId: "sheet-1" });
  });

  it("previews writes without reading credentials or calling the network", async () => {
    const execute = createRoutineWorkflowActionExecutor({
      createAgentTask: vi.fn(),
      getTaskSnapshot: vi.fn(),
    });

    const result = await execute({
      routine: { id: "routine-1", name: "Flow", workspaceId: "workspace-1" } as Any,
      workflow: { version: 1, starterNodeId: "starter", nodes: [], edges: [] },
      node: { id: "chat", kind: "action", operation: "chat.notify", name: "Notify", config: {} },
      input: { spaceName: "spaces/1", text: "Hello" },
      runId: "run-1",
      stepId: "step-1",
      dryRun: true,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ preview: true, operation: "chat.notify" });
    expect(auth.getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks custom MCP tools outside the routine connector allowlist", async () => {
    const manager = MCPClientManager.getInstance();
    vi.spyOn(manager, "getServerIdForTool").mockReturnValue("server-two");
    vi.spyOn(manager, "getConnectorIdForTool").mockReturnValue("jira");
    const callTool = vi.spyOn(manager, "callTool");
    const execute = createRoutineWorkflowActionExecutor({
      createAgentTask: vi.fn(),
      getTaskSnapshot: vi.fn(),
    });

    await expect(
      execute({
        routine: {
          id: "routine-1",
          name: "Restricted flow",
          workspaceId: "workspace-1",
          connectorPolicy: { mode: "allowlist", connectorIds: ["google-workspace"] },
        } as Any,
        workflow: { version: 1, starterNodeId: "starter", nodes: [], edges: [] },
        node: {
          id: "custom",
          kind: "custom",
          operation: "custom.mcp_tool",
          name: "Custom tool",
          config: {},
        },
        input: { toolName: "jira.create_issue", arguments: { summary: "Unexpected" } },
        runId: "run-1",
        stepId: "step-1",
        dryRun: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Connector policy does not allow");
    expect(callTool).not.toHaveBeenCalled();
  });
});
