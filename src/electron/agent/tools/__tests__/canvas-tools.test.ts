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

  it("rejects foreign-task push, eval, open, and restore targets before any manager effect", async () => {
    manager.getSession.mockReturnValue({ ...session, taskId: "other-task" });
    await expect(
      tools.pushContent("session-1", "<img src='https://attacker.example'>"),
    ).rejects.toThrow("another task");
    await expect(
      tools.evalScript("session-1", "fetch('https://attacker.example')"),
    ).rejects.toThrow("another task");
    await expect(tools.openUrl("session-1", "https://attacker.example")).rejects.toThrow(
      "another task",
    );
    await expect(tools.restoreCheckpoint("session-1", "checkpoint")).rejects.toThrow(
      "another task",
    );
    expect(manager.pushContent).not.toHaveBeenCalled();
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

describe("CanvasTools asset and export boundaries", () => {
  const daemon = { logEvent: vi.fn() };
  let root: string;
  let workspace: Workspace;
  let manager: {
    getSession: ReturnType<typeof vi.fn>;
    addAsset: ReturnType<typeof vi.fn>;
    exportToFolder: ReturnType<typeof vi.fn>;
  };
  let tools: CanvasTools;

  beforeEach(async () => {
    const fsSync = await vi.importActual<typeof import("fs")>("fs");
    const os = await import("os");
    root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "canvas-tools-")));
    fsSync.mkdirSync(path.join(root, "ws"));
    fsSync.writeFileSync(path.join(root, "ws", "scene.png"), "png");
    fsSync.writeFileSync(path.join(root, "outside.png"), "png");
    workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: path.join(root, "ws"),
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: true, shell: false },
    };
    manager = {
      getSession: vi.fn(() => ({
        id: "session-1",
        taskId: "task-1",
        workspaceId: workspace.id,
        sessionDir: path.join(root, "canvas"),
        status: "active",
        title: "Evolution of Primates",
        createdAt: Date.now(),
      })),
      addAsset: vi.fn(async () => ({
        relativePath: "assets/scene.png",
        bytes: 3,
        mimeType: "image/png",
      })),
      exportToFolder: vi.fn(async (_id: string, target: string) => ({
        files: ["index.html"],
        targetDir: target,
      })),
    };
    tools = new CanvasTools(workspace, daemon as Any, "task-1");
    (tools as Any).manager = manager;
  });

  afterEach(async () => {
    const fsSync = await vi.importActual<typeof import("fs")>("fs");
    fsSync.rmSync(root, { recursive: true, force: true });
  });

  it("copies a workspace file through the manager", async () => {
    const result = await tools.addAsset("session-1", "scene.png");
    expect(result.url).toBe("assets/scene.png");
    expect(manager.addAsset).toHaveBeenCalledWith(
      "session-1",
      path.join(root, "ws", "scene.png"),
      undefined,
    );
  });

  it("refuses files outside the workspace without an approval", async () => {
    await expect(tools.addAsset("session-1", path.join(root, "outside.png"))).rejects.toThrow(
      /Access denied/,
    );
    expect(manager.addAsset).not.toHaveBeenCalled();
  });

  it("enforces a project's ACCESS.md for the assigned agent role", async () => {
    const fsSync = await vi.importActual<typeof import("fs")>("fs");
    const projectDir = path.join(root, "ws", ".cowork", "projects", "secret");
    fsSync.mkdirSync(projectDir, { recursive: true });
    fsSync.writeFileSync(path.join(projectDir, "ACCESS.md"), "## Deny\n- role-1\n");
    fsSync.writeFileSync(path.join(projectDir, "plan.png"), "png");
    (daemon as Any).getTask = vi.fn(() => ({ assignedAgentRoleId: "role-1" }));
    // This file mocks fs/promises.readFile; let the ACCESS.md read reach the disk.
    const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises");
    readFileMock.mockImplementation(realFs.readFile as Any);
    try {
      await expect(tools.addAsset("session-1", ".cowork/projects/secret/plan.png")).rejects.toThrow(
        /Denied by ACCESS.md/,
      );
      expect(manager.addAsset).not.toHaveBeenCalled();
    } finally {
      delete (daemon as Any).getTask;
    }
  });

  it("refuses another task's canvas", async () => {
    manager.getSession.mockReturnValue({ ...manager.getSession(), taskId: "other-task" });
    await expect(tools.addAsset("session-1", "scene.png")).rejects.toThrow("another task");
    await expect(tools.exportCanvas("session-1")).rejects.toThrow("another task");
  });

  it("exports to a workspace folder named after the canvas", async () => {
    const result = await tools.exportCanvas("session-1");
    expect(result.targetDir).toBe(path.join(root, "ws", "evolution-of-primates"));
    expect(result.entry).toBe(path.join(root, "ws", "evolution-of-primates", "index.html"));
    expect(daemon.logEvent).toHaveBeenCalledWith("task-1", "file_created", {
      path: path.join("evolution-of-primates", "index.html"),
      type: "canvas_export",
    });
  });

  it("refuses export outside the workspace or without write permission", async () => {
    await expect(tools.exportCanvas("session-1", path.join(root, "elsewhere"))).rejects.toThrow(
      /Access denied/,
    );
    workspace.permissions.write = false;
    await expect(tools.exportCanvas("session-1")).rejects.toThrow(/Write permission/);
    expect(manager.exportToFolder).not.toHaveBeenCalled();
  });
});
