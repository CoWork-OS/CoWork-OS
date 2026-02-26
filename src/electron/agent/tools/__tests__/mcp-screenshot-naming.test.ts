import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ToolRegistry instantiates MentionTools which requires a live DatabaseManager. Mock it for unit tests.
vi.mock("../mention-tools", () => {
  return {
    MentionTools: class MockMentionTools {
      constructor() {}
      getTools() {
        return [];
      }
      static getToolDefinitions() {
        return [];
      }
    },
  };
});

describe("ToolRegistry MCP screenshot naming", () => {
  it("saves MCP inline image content using input.name as <name>.png and returns the saved filename", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-mcp-img-"));

    const { ToolRegistry } = await import("../registry");

    const workspace: Any = {
      id: "test-workspace",
      name: "Test Workspace",
      path: workspacePath,
      isTemp: true,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: true, shell: false },
    };

    const daemon: Any = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
    };

    const registry = new ToolRegistry(workspace, daemon, "test-task");

    const fakeImageBytes = Buffer.from("not-a-real-png", "utf-8");
    const result = {
      isError: false,
      content: [
        { type: "text", text: "ok" },
        {
          type: "image",
          data: fakeImageBytes.toString("base64"),
          mimeType: "image/png",
        },
      ],
    };

    const out = await (registry as Any).formatMCPResult(result, "puppeteer_screenshot", {
      name: "opentable_initial",
      width: 1280,
      height: 900,
    });

    expect(typeof out).toBe("string");
    expect(out).toContain("Saved image: opentable_initial.png");

    const expectedPath = path.join(workspacePath, "opentable_initial.png");
    expect(fs.existsSync(expectedPath)).toBe(true);

    expect(daemon.registerArtifact).toHaveBeenCalledWith("test-task", expectedPath, "image/png");
  }, 30_000);
});
