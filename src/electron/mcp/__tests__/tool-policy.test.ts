import { describe, expect, it } from "vitest";
import { resolveMcpToolPolicy } from "../tool-policy";
import { MCPServerConfigSchema, MCPServerUpdateSchema } from "../../utils/validation";
import type { MCPServerConfig, MCPTool } from "../types";

const server: MCPServerConfig = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "TEST DATA — Dayanak Lens",
  enabled: true,
  transport: "stdio",
  command: "node",
};
const tool: MCPTool = {
  name: "get_yargitay_passage",
  annotations: { readOnlyHint: true },
  inputSchema: { type: "object" },
};

describe("saved MCP tool policy", () => {
  it("applies per-tool overrides before server defaults", () => {
    expect(
      resolveMcpToolPolicy(tool, {
        ...server,
        defaultToolsApprovalMode: "prompt",
        toolApprovals: { get_yargitay_passage: "writes" },
      }).approvalMode,
    ).toBe("writes");
    expect(
      resolveMcpToolPolicy(
        { ...tool, name: "other" },
        {
          ...server,
          defaultToolsApprovalMode: "prompt",
          toolApprovals: { get_yargitay_passage: "approve" },
        },
      ).approvalMode,
    ).toBe("prompt");
  });

  it("does not infer read-only authority from names or idempotence", () => {
    expect(
      resolveMcpToolPolicy(
        { ...tool, name: "search_and_delete", annotations: { idempotentHint: true } },
        server,
      ).readOnly,
    ).toBe(false);
    expect(resolveMcpToolPolicy(tool, server).readOnly).toBe(true);
  });

  it("preserves policy through create/update IPC validation", () => {
    const policy = {
      defaultToolsApprovalMode: "writes",
      toolApprovals: { get_yargitay_passage: "approve" },
    };
    expect(MCPServerConfigSchema.parse({ ...server, ...policy })).toMatchObject(policy);
    expect(MCPServerUpdateSchema.parse(policy)).toEqual(policy);
    expect(
      MCPServerUpdateSchema.safeParse({ defaultToolsApprovalMode: "allow-everything" }).success,
    ).toBe(false);
    expect(MCPServerUpdateSchema.safeParse({ toolApprovals: { other: "never" } }).success).toBe(
      false,
    );
  });
});
