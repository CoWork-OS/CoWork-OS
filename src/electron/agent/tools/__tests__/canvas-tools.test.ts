import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import type { Workspace } from "../../../../shared/types";
import { CanvasTools } from "../canvas-tools";

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    readFile: readFileMock,
  };
});

describe("CanvasTools.pushContent", () => {
  const workspace: Workspace = {
    id: "workspace-1",
    name: "Workspace",
    path: "/repo",
    createdAt: Date.now(),
    permissions: { read: true, write: true, delete: true, network: true, shell: false },
  };

  const daemon = {
    logEvent: vi.fn(),
  };

  const session = {
    id: "session-1",
    taskId: "task-1",
    workspaceId: workspace.id,
    sessionDir: "/tmp/canvas/session-1",
    mode: "html",
    status: "active",
    title: "Canvas",
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };

  let manager: {
    getSession: ReturnType<typeof vi.fn>;
    listSessionsForTask: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
    pushContent: ReturnType<typeof vi.fn>;
  };
  let tools: CanvasTools;

  beforeEach(() => {
    vi.clearAllMocks();
    readFileMock.mockReset();
    manager = {
      getSession: vi.fn(() => session),
      listSessionsForTask: vi.fn(() => [session]),
      createSession: vi.fn(async () => session),
      pushContent: vi.fn(async () => undefined),
    };
    tools = new CanvasTools(workspace, daemon as Any, "task-1");
    (tools as Any).manager = manager;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inlines local stylesheet links for canvas HTML pushes", async () => {
    const cssPath = path.resolve(workspace.path, "css/win95.css");
    readFileMock.mockImplementation(async (target: Any, encoding: Any) => {
      if (String(target) === cssPath && encoding === "utf-8") {
        return "body { color: red; }";
      }
      throw new Error(`Unexpected read: ${String(target)}`);
    });

    const html =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/win95.css"></head><body>Win95</body></html>';
    await tools.pushContent("session-1", html, "index.html");

    expect(readFileMock).toHaveBeenCalledWith(cssPath, "utf-8");
    expect(manager.pushContent).toHaveBeenCalledTimes(1);
    const pushedHtml = String(manager.pushContent.mock.calls[0][1] || "");
    expect(pushedHtml).toContain('<style data-canvas-inline-source="css/win95.css">');
    expect(pushedHtml).toContain("body { color: red; }");
    expect(pushedHtml).not.toContain('<link rel="stylesheet"');
  });

  it("does not inline external stylesheet links", async () => {
    const html =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="https://cdn.example.com/app.css"></head><body>Win95</body></html>';

    await tools.pushContent("session-1", html, "index.html");

    expect(readFileMock).not.toHaveBeenCalled();
    const pushedHtml = String(manager.pushContent.mock.calls[0][1] || "");
    expect(pushedHtml).toContain("https://cdn.example.com/app.css");
  });
});
