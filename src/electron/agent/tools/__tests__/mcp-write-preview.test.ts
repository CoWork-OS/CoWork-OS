import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../admin/policies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../admin/policies")>()),
  loadPolicies: vi.fn(() => ({ connectors: { blocked: [] } })),
}));

import { ToolRegistry } from "../registry";
import { AgentDaemon } from "../../daemon";
import { MCPClientManager } from "../../../mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../../../mcp/settings";

const KEY = "0123456789abcdef0123456789abcdef";
const PREVIEW_TOOL = {
  name: "jira.create_issue",
  inputSchema: { type: "object" },
  _meta: { "cowork.preview": true },
};

const previewAnswer = {
  content: [{ type: "text", text: "{}" }],
  structuredContent: {
    status: "preview",
    prepared: {
      kind: "preview",
      summary: "Create a Task in Jira project OPS",
      references: [],
      payload: { fields: [{ label: "Summary", value: "Rotate keys" }] },
    },
  },
};

const receipt = {
  status: "verified",
  summary: "Created Jira issue OPS-1",
  checkedAt: 1_000,
  evidence: [
    { source: "jira:issue:OPS-1", claim: 'Issue OPS-1 exists with summary "Rotate keys"' },
  ],
};

function setup(options: { transport?: string; tool?: Any; result?: Any } = {}) {
  const server = {
    id: "server-jira",
    name: "Jira",
    enabled: true,
    transport: options.transport ?? "stdio",
  };
  vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({
    toolNamePrefix: "mcp_",
    servers: [server],
  } as Any);
  const callTool = vi.fn(async () => options.result ?? previewAnswer);
  vi.spyOn(MCPClientManager, "getInstance").mockReturnValue({
    hasTool: (name: string) => name === "jira.create_issue",
    getServerIdForTool: () => server.id,
    getAllTools: () => [options.tool ?? PREVIEW_TOOL],
    callTool,
  } as Any);
  const recordToolReceipt = vi.fn();
  const registry = Object.create(ToolRegistry.prototype) as Any;
  Object.assign(registry, {
    taskId: "task-1",
    daemon: { recordToolReceipt },
    workspace: {
      id: "fixture-workspace",
      path: "/tmp/fixture-workspace",
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    },
    evaluateMcpEndpointNetworkPolicy: () => null,
    getMcpServerName: () => server.name,
  });
  return { registry, callTool, recordToolReceipt };
}

describe("MCP write preview before approval", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks a local connector to describe the write, and labels the answer as its own", async () => {
    const { registry, callTool } = setup();
    const preview = await registry.fetchMcpWritePreview(
      "mcp_jira.create_issue",
      { projectKey: "OPS" },
      "Jira",
    );

    expect(callTool).toHaveBeenCalledWith(
      "jira.create_issue",
      { projectKey: "OPS" },
      { preview: true },
    );
    expect(preview.approvalPreview).toEqual({
      label: "Described by Jira",
      text: "Create a Task in Jira project OPS\nSummary: Rotate keys",
    });
    expect(preview.prepared.summary).toBe("Create a Task in Jira project OPS");
  });

  it("does not send arguments to a remote server before approval", async () => {
    const { registry, callTool } = setup({ transport: "streamable-http" });
    expect(await registry.fetchMcpWritePreview("mcp_jira.create_issue", {}, "Jira")).toBeNull();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not ask a tool that does not advertise previews", async () => {
    const { registry, callTool } = setup({
      tool: { name: "jira.create_issue", inputSchema: { type: "object" } },
    });
    expect(await registry.fetchMcpWritePreview("mcp_jira.create_issue", {}, "Jira")).toBeNull();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("falls back to the arguments when the answer is not a preview or the call fails", async () => {
    const wrongShape = setup({ result: { content: [], structuredContent: { status: "created" } } });
    expect(
      await wrongShape.registry.fetchMcpWritePreview("mcp_jira.create_issue", {}, "Jira"),
    ).toBeNull();
    vi.restoreAllMocks();

    const failing = setup();
    failing.callTool.mockRejectedValueOnce(new Error("server gone"));
    expect(
      await failing.registry.fetchMcpWritePreview("mcp_jira.create_issue", {}, "Jira"),
    ).toBeNull();
  });
});

describe("MCP write receipts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hands a write's receipt to the daemon with the attempt key", async () => {
    const { registry, recordToolReceipt } = setup({
      result: {
        content: [{ type: "text", text: '{"ok":true,"status":"created"}' }],
        structuredContent: { status: "created", receipt },
      },
    });
    await registry.tryExecuteMCPTool(
      "mcp_jira.create_issue",
      { projectKey: "OPS" },
      { toolAttempt: { idempotencyKey: KEY, attemptId: "attempt-1" } },
    );
    expect(recordToolReceipt).toHaveBeenCalledWith("task-1", {
      tool: "jira.create_issue",
      serverName: "Jira",
      receipt,
      idempotencyKey: KEY,
    });
  });

  it("ignores a malformed receipt", async () => {
    const { registry, recordToolReceipt } = setup({
      result: {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { status: "created", receipt: { status: "done" } },
      },
    });
    await registry.tryExecuteMCPTool("mcp_jira.create_issue", {}, {});
    expect(recordToolReceipt).not.toHaveBeenCalled();
  });

  it("the daemon records a receipt as task evidence", () => {
    const recordEvidence = vi.fn();
    const logEvent = vi.fn();
    const daemon = Object.create(AgentDaemon.prototype) as Any;
    Object.assign(daemon, { workSessionContractService: { recordEvidence }, logEvent });

    daemon.recordToolReceipt("task-1", {
      tool: "jira.create_issue",
      serverName: "Jira",
      receipt,
      idempotencyKey: KEY,
    });
    daemon.recordToolReceipt("task-1", {
      tool: "jira.create_issue",
      receipt: { ...receipt, status: "unavailable", summary: "Created; not read back" },
    });

    expect(recordEvidence).toHaveBeenNthCalledWith(1, "task-1", {
      claim: "Created Jira issue OPS-1",
      sourceType: "tool_output",
      sourceRef: "mcp:Jira:jira.create_issue",
      status: "supporting",
      confidence: 1,
      basis: "observed",
      capturedAt: 1_000,
      snippet: JSON.stringify(receipt.evidence),
      idempotencyKey: `mcp_receipt:jira.create_issue:${KEY}`,
    });
    expect(recordEvidence.mock.calls[1][1]).toMatchObject({
      sourceRef: "mcp:connector:jira.create_issue",
      status: "neutral",
      confidence: 0,
      basis: "unknown",
      idempotencyKey: "mcp_receipt:jira.create_issue:1000",
    });
    expect(logEvent).toHaveBeenCalledWith("task-1", "tool_receipt_recorded", {
      tool: "jira.create_issue",
      status: "verified",
      summary: "Created Jira issue OPS-1",
    });
  });
});
