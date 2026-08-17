import { describe, expect, it } from "vitest";
import {
  buildAgentSecurityAction,
  buildAgentSecurityHookPayload,
  hookEventToLifecycle,
} from "../NumbatEventAdapter";

describe("NumbatEventAdapter", () => {
  it("projects shell inputs without forwarding arbitrary or secret fields", () => {
    const payload = buildAgentSecurityHookPayload({
      hookEventName: "PreToolUse",
      taskId: "task-1",
      workspacePath: "/tmp/workspace",
      toolCallId: "tool-1",
      toolName: "run_command",
      toolInput: {
        command: "curl 'https://example.com?token=super-secret-token-value'",
        apiKey: "sk-never-forward-this-value",
        nested: { password: "never-forward-this-value" },
      },
      provider: "openai",
      model: "gpt-test",
    });

    expect(payload.source_agent).toBe("cowork-os");
    expect(payload.tool_class).toBe("shell");
    expect(payload.action?.command).toContain("token=[REDACTED]");
    expect(payload.action?.input_keys).toEqual(["command", "[REDACTED_KEY]", "nested"]);
    expect(payload.tool_input).toEqual({
      command: payload.action?.command,
      input_keys: payload.action?.input_keys,
    });
    expect(JSON.stringify(payload)).not.toContain("super-secret-token-value");
    expect(JSON.stringify(payload)).not.toContain("sk-never-forward-this-value");
    expect(JSON.stringify(payload)).not.toContain("never-forward-this-value");
  });

  it("normalizes file paths and MCP identities into bounded action fields", () => {
    expect(
      buildAgentSecurityAction(
        "edit_file",
        { path: "src/main.ts", destinationPath: "src/main.old.ts", contents: "omitted" },
        "/tmp/workspace",
      ),
    ).toEqual({
      toolClass: "file_write",
      action: {
        input_keys: ["path", "destinationPath", "contents"],
        file_path: "/tmp/workspace/src/main.ts",
        destination_path: "/tmp/workspace/src/main.old.ts",
      },
    });

    expect(buildAgentSecurityAction("mcp__github__create_issue", { body: "omitted" })).toEqual({
      toolClass: "mcp",
      action: {
        input_keys: ["body"],
        mcp_server: "github",
        mcp_tool: "create_issue",
      },
    });
  });

  it("maps all CoWork lifecycle names to Numbat hook lifecycle names", () => {
    expect(hookEventToLifecycle("SessionStart")).toBe("session-start");
    expect(hookEventToLifecycle("PermissionDenied")).toBe("permission-denied");
    expect(hookEventToLifecycle("PostToolUseFailure")).toBe("post-tool-failure");
  });
});
