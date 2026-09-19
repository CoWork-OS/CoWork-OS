import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunBirdCommand = vi.hoisted(() => vi.fn());
const mockSettingsLoad = vi.hoisted(() => vi.fn());
const mockBrowserToolsExecuteTool = vi.hoisted(() => vi.fn());
const mockBrowserToolsSetWorkspace = vi.hoisted(() => vi.fn());

vi.mock("../../src/electron/utils/x-cli", () => ({
  runBirdCommand: mockRunBirdCommand,
}));

vi.mock("../../src/electron/settings/x-manager", () => ({
  XSettingsManager: {
    loadSettings: (..._args: unknown[]) => mockSettingsLoad(),
  },
}));

vi.mock("../../src/electron/agent/tools/browser-tools", () => ({
  BrowserTools: vi.fn().mockImplementation(function () {
    return {
      executeTool: mockBrowserToolsExecuteTool,
      setWorkspace: mockBrowserToolsSetWorkspace,
    };
  }),
}));

import { XTools } from "../../src/electron/agent/tools/x-tools";
import { Workspace } from "../../src/shared/types";

const mockWorkspace: Workspace = {
  id: "test-workspace",
  name: "Test Workspace",
  path: "/tmp/workspace",
  permissions: {
    read: true,
    write: true,
    delete: true,
    network: true,
    shell: true,
  },
  createdAt: Date.now(),
};

const mockDaemon = {
  logEvent: vi.fn(),
  requestApproval: vi.fn().mockResolvedValue(true),
};

describe("XTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunBirdCommand.mockReset();
    mockSettingsLoad.mockReset();
    mockBrowserToolsExecuteTool.mockReset();
    mockBrowserToolsSetWorkspace.mockReset();

    mockSettingsLoad.mockReturnValue({
      enabled: true,
      authMethod: "browser",
      cookieSource: ["chrome"],
      timeoutMs: 20000,
      cookieTimeoutMs: 20000,
      quoteDepth: 1,
    });
  });

  const buildTool = () => new XTools(mockWorkspace, mockDaemon as any, "task-test");

  it("retries transient non-blocking command errors for read actions", async () => {
    mockRunBirdCommand
      .mockRejectedValueOnce(new Error("connection reset while reading"))
      .mockResolvedValueOnce({
        stdout: "Read result",
        stderr: "",
        data: [{ id: 1, text: "ok" }],
      });

    const tool = buildTool();
    const result = await tool.executeAction({
      action: "read",
      id_or_url: "https://x.com/i/web/status/123",
    });

    expect(mockRunBirdCommand).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.output).toBe("Read result");
  });

  it("does not retry transient command errors for write actions", async () => {
    mockRunBirdCommand.mockRejectedValue(new Error("connection reset while writing"));

    const tool = buildTool();

    await expect(tool.executeAction({ action: "follow", user: "alice" })).rejects.toThrow(
      "connection reset while writing",
    );

    expect(mockRunBirdCommand).toHaveBeenCalledTimes(1);
    expect(mockBrowserToolsExecuteTool).not.toHaveBeenCalled();
  });

  it("falls back to browser fallback for blocked read actions with sanitized fallback URL", async () => {
    mockRunBirdCommand.mockRejectedValue(new Error("rate limit exceeded")); // blocking path

    let evaluateCall = 0;
    mockBrowserToolsExecuteTool.mockImplementation(async (tool: string, payload: any) => {
      if (tool === "browser_navigate") {
        return { url: payload.url, isError: false };
      }
      if (tool === "browser_get_content") {
        return {
          text: "Home timeline content",
          title: "X Home",
          url: payload.url || "https://x.com",
        };
      }
      if (tool === "browser_evaluate") {
        evaluateCall += 1;
        if (evaluateCall === 1) {
          return {
            success: true,
            result: { hasTweetContainer: true, hasTweetLink: false },
          };
        }

        return {
          success: true,
          result: [
            {
              author: "@alice",
              body: "First post",
              time: "10:00 AM",
              url: "https://x.com/i/web/status/123",
            },
          ],
        };
      }

      throw new Error(`Unexpected browser tool: ${tool}`);
    });

    const tool = buildTool();
    const result = await tool.executeAction({
      action: "read",
      id_or_url: "https://malicious.example.com/bad",
    });

    const navCall = mockBrowserToolsExecuteTool.mock.calls.find(
      ([toolName]) => toolName === "browser_navigate",
    );
    expect(navCall?.[1]?.url).toBe("https://x.com");
    expect(result.success).toBe(true);
    expect(result.fallback).toBeDefined();
    expect(result.data?.items).toHaveLength(1);
    expect(result.data?.items[0]?.author).toBe("@alice");
  });

  it("treats missing write controls as a manual fallback scenario", async () => {
    mockRunBirdCommand.mockRejectedValue(new Error("rate limit exceeded"));

    mockBrowserToolsExecuteTool.mockImplementation(async (tool: string) => {
      if (tool === "browser_navigate") {
        return {
          url: "https://x.com/compose/post",
          isError: false,
        };
      }
      if (tool === "browser_get_content") {
        return {
          text: "compose page",
          title: "Compose",
          url: "https://x.com/compose/post",
        };
      }
      if (tool === "browser_evaluate") {
        return {
          success: true,
          result: false,
        };
      }

      throw new Error(`Unexpected browser tool: ${tool}`);
    });

    const tool = buildTool();
    const result = await tool.executeAction({
      action: "tweet",
      text: "hello world",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("write controls");
    expect(result.fallback?.manualAction).toContain("compose/follow controls");
  });

  it("normalizes handles and tweet URLs through private helpers", () => {
    const tool = buildTool();

    expect((tool as any).normalizeHandle("https://x.com/john_doe")).toBe("@john_doe");
    expect((tool as any).normalizeHandle("status")).toBeUndefined();
    expect((tool as any).normalizeHandle("@Jane")).toBe("@Jane");
    expect((tool as any).normalizeHandle("not a handle")).toBeUndefined();

    expect((XTools as any).normalizeToTweetUrl("https://twitter.com/i/web/status/123456")).toBe(
      "https://x.com/i/web/status/123456",
    );
    expect((XTools as any).normalizeToTweetUrl("https://malicious.example.org/foo")).toBe(
      "https://x.com",
    );
    expect((XTools as any).normalizeToTweetUrl("123456")).toBe("https://x.com/i/web/status/123456");
  });
});
