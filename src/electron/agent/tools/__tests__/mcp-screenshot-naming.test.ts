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
    // Screenshot tools keep the "screenshot" event type.
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "test-task",
      "file_created",
      expect.objectContaining({ path: "opentable_initial.png", type: "screenshot", source: "mcp" }),
    );
  }, 30_000);

  it("names generated MCP images after the tool, logs them as images, and asks for inline display", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-mcp-gen-"));
    const { ToolRegistry } = await import("../registry");
    const workspace: Any = {
      id: "test-workspace",
      name: "Test Workspace",
      path: workspacePath,
      isTemp: true,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: true, shell: false },
    };
    const daemon: Any = { logEvent: vi.fn(), registerArtifact: vi.fn() };
    const registry = new ToolRegistry(workspace, daemon, "test-task");

    const imageContent = {
      type: "image",
      data: Buffer.from("not-a-real-png", "utf-8").toString("base64"),
      mimeType: "image/png",
    };

    const out = await (registry as Any).formatMCPResult(
      { isError: false, content: [{ type: "text", text: "Generated in 41s" }, imageContent] },
      "qwen_generate_image",
      { prompt: "a snow leopard" },
    );

    expect(typeof out).toBe("string");
    const match = /(^|\n)Saved image: (\S+)/.exec(out);
    expect(match?.[2]).toMatch(/^qwen-generate-image-\d+\.png$/);
    const filename = match![2];
    expect(out).toContain(
      `Saved image: ${filename}\nShow it to the user inline with ![](${filename}).`,
    );
    expect(fs.existsSync(path.join(workspacePath, filename))).toBe(true);
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "test-task",
      "file_created",
      expect.objectContaining({ path: filename, type: "image", source: "mcp" }),
    );

    // Image-only results (no text) still lead with the "Saved image:" line.
    const imageOnly = await (registry as Any).formatMCPResult(
      { isError: false, content: [imageContent] },
      "qwen_get_image_result",
      {},
    );
    expect(imageOnly).toMatch(
      /^Saved image: qwen-get-image-result-\d+\.png\nShow it to the user inline with !\[\]\(/,
    );
  }, 30_000);
});
