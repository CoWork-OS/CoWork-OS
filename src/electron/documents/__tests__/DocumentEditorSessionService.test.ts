import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentBuilder } from "../../agent/skills/document";
import { DocumentEditorSessionService } from "../DocumentEditorSessionService";
import { editPdfRegion } from "../pdf-region-editor";
import { parsePdfBuffer } from "../../utils/pdf-parser";

const tempDirs: string[] = [];

function makeWorkspace(workspacePath: string) {
  return {
    id: "ws-1",
    name: "Workspace",
    path: workspacePath,
    createdAt: Date.now(),
    permissions: {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
      allowedPaths: [],
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DocumentEditorSessionService", () => {
  it("opens the latest sibling version and lists lineage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-doc-editor-"));
    tempDirs.push(dir);
    const original = path.join(dir, "report.pdf");
    const latest = path.join(dir, "report-v2.pdf");
    fs.writeFileSync(original, Buffer.from("original"));
    fs.writeFileSync(latest, Buffer.from("latest"));

    const service = new DocumentEditorSessionService(
      { findAll: () => [makeWorkspace(dir)] } as Any,
      { findById: vi.fn().mockReturnValue(undefined) } as Any,
      {
        findLatestByPath: vi.fn((artifactPath: string) =>
          artifactPath === fs.realpathSync(latest)
            ? {
                id: "artifact-1",
                taskId: "task-1",
                path: fs.realpathSync(latest),
                createdAt: Date.now(),
              }
            : undefined,
        ),
      } as Any,
      {} as Any,
    );

    const session = await service.openSession(original, dir);

    expect(session.currentPath).toBe(fs.realpathSync(latest));
    expect(session.versions.map((item) => item.fileName)).toEqual(["report.pdf", "report-v2.pdf"]);
    expect(session.pdfDataBase64).toBeTruthy();
    expect(session.sourceTaskId).toBe("task-1");
  });

  it("creates a child edit task for DOCX selections when the source artifact belongs to a task", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-doc-editor-"));
    tempDirs.push(dir);
    const original = path.join(dir, "proposal.docx");
    const builder = new DocumentBuilder(makeWorkspace(dir) as Any);
    await builder.create(original, "docx", [
      { type: "heading", text: "Proposal", level: 1 },
      { type: "paragraph", text: "Original body." },
    ]);

    const createChildTask = vi
      .fn()
      .mockResolvedValue({ id: "child-1", title: "Edit proposal.pdf" });
    const createTask = vi.fn();
    const service = new DocumentEditorSessionService(
      { findAll: () => [makeWorkspace(dir)] } as Any,
      { findById: vi.fn().mockReturnValue({ id: "parent-1" }) } as Any,
      {
        findLatestByPath: vi.fn(() => ({
          id: "artifact-1",
          taskId: "parent-1",
          path: original,
          createdAt: Date.now(),
        })),
      } as Any,
      { createChildTask, createTask } as Any,
    );

    const session = await service.openSession(original, dir);
    const blockId = session.docxBlocks?.[0]?.id;
    expect(blockId).toBeTruthy();
    await service.startEditTask({
      sessionId: session.sessionId,
      instruction: "Rewrite the title",
      selection: {
        kind: "docx",
        startBlockId: blockId!,
        endBlockId: blockId!,
        blockIds: [blockId!],
      },
    });

    expect(createChildTask).toHaveBeenCalledOnce();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("runs PDF edits directly without routing through the agent planner", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-doc-editor-"));
    tempDirs.push(dir);
    const original = path.join(dir, "sample.pdf");
    fs.writeFileSync(original, Buffer.from("original"));

    const tasks = new Map<string, Any>();
    const taskRepo = {
      create: vi.fn((task: Any) => {
        const created = {
          ...task,
          id: "task-direct-1",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        tasks.set(created.id, created);
        return created;
      }),
      findById: vi.fn((id: string) => tasks.get(id)),
      update: vi.fn((id: string, patch: Any) => {
        const next = { ...tasks.get(id), ...patch, updatedAt: Date.now() };
        tasks.set(id, next);
        return next;
      }),
    };
    const daemon = {
      createChildTask: vi.fn(),
      createTask: vi.fn(),
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
      updateTaskStatus: vi.fn((id: string, status: string) => {
        taskRepo.update(id, { status });
      }),
      completeTask: vi.fn((id: string, summary: string) => {
        taskRepo.update(id, {
          status: "completed",
          completedAt: Date.now(),
          resultSummary: summary,
        });
      }),
      failTask: vi.fn((id: string, message: string, metadata?: { failureClass?: string }) => {
        taskRepo.update(id, {
          status: "failed",
          completedAt: Date.now(),
          error: message,
          terminalStatus: "failed",
          failureClass: metadata?.failureClass,
        });
      }),
    };
    const pdfRegionEditor = {
      isAvailable: vi.fn().mockResolvedValue(true),
      edit: vi.fn().mockImplementation(async ({ destPath }: { destPath: string }) => {
        fs.writeFileSync(destPath, Buffer.from("edited"));
      }),
    };
    const service = new DocumentEditorSessionService(
      { findAll: () => [makeWorkspace(dir)] } as Any,
      taskRepo as Any,
      { findLatestByPath: vi.fn().mockReturnValue(undefined) } as Any,
      daemon as Any,
      pdfRegionEditor,
    );

    const session = await service.openSession(original, dir);
    const task = await service.startEditTask({
      sessionId: session.sessionId,
      instruction: "Make it italic",
      selection: { kind: "pdf", pageIndex: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
    });

    expect(taskRepo.create).toHaveBeenCalledOnce();
    expect(daemon.createTask).not.toHaveBeenCalled();
    expect(daemon.createChildTask).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(pdfRegionEditor.edit).toHaveBeenCalledOnce();
    expect(daemon.registerArtifact).toHaveBeenCalledOnce();
    expect(daemon.completeTask).toHaveBeenCalledOnce();
    expect(tasks.get(task.id)?.status).toBe("completed");
  });

  it("fails direct PDF edit tasks through the daemon terminal helper", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-doc-editor-"));
    tempDirs.push(dir);
    const original = path.join(dir, "sample.pdf");
    fs.writeFileSync(original, Buffer.from("original"));

    const tasks = new Map<string, Any>();
    const taskRepo = {
      create: vi.fn((task: Any) => {
        const created = {
          ...task,
          id: "task-direct-fail-1",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        tasks.set(created.id, created);
        return created;
      }),
      findById: vi.fn((id: string) => tasks.get(id)),
      update: vi.fn((id: string, patch: Any) => {
        const next = { ...tasks.get(id), ...patch, updatedAt: Date.now() };
        tasks.set(id, next);
        return next;
      }),
    };
    const daemon = {
      createChildTask: vi.fn(),
      createTask: vi.fn(),
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
      completeTask: vi.fn(),
      failTask: vi.fn((id: string, message: string, metadata?: { failureClass?: string }) => {
        taskRepo.update(id, {
          status: "failed",
          completedAt: Date.now(),
          error: message,
          terminalStatus: "failed",
          failureClass: metadata?.failureClass,
        });
      }),
    };
    const pdfRegionEditor = {
      edit: vi.fn().mockRejectedValue(new Error("Ghostscript not installed")),
    };
    const service = new DocumentEditorSessionService(
      { findAll: () => [makeWorkspace(dir)] } as Any,
      taskRepo as Any,
      { findLatestByPath: vi.fn().mockReturnValue(undefined) } as Any,
      daemon as Any,
      pdfRegionEditor,
    );

    const session = await service.openSession(original, dir);
    const task = await service.startEditTask({
      sessionId: session.sessionId,
      instruction: "Make it italic",
      selection: { kind: "pdf", pageIndex: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(daemon.failTask).toHaveBeenCalledWith(
      task.id,
      "Ghostscript not installed",
      expect.objectContaining({
        terminalStatus: "failed",
        failureClass: "dependency_unavailable",
      }),
    );
    expect(tasks.get(task.id)?.status).toBe("failed");
  });

  it("applies a local PDF edit without external tooling", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-doc-editor-"));
    tempDirs.push(dir);
    const original = path.join(dir, "sample.pdf");
    const edited = path.join(dir, "sample-edited.pdf");

    const builder = new DocumentBuilder(makeWorkspace(dir) as Any);
    await builder.create(original, "pdf", [
      { type: "heading", text: "Hello world", level: 1 },
      { type: "paragraph", text: "This is a test document." },
    ]);

    const originalBytes = fs.readFileSync(original);
    await editPdfRegion({
      sourcePath: original,
      destPath: edited,
      pageIndex: 0,
      bbox: { x: 0.08, y: 0.08, w: 0.45, h: 0.18 },
      instruction: "make the selected text italic",
      selectionText: "Hello world",
    });

    const editedBytes = fs.readFileSync(edited);
    expect(editedBytes.equals(originalBytes)).toBe(false);
    const parsed = await parsePdfBuffer(editedBytes);
    expect(parsed.text).toContain("Hello world");
  });
});
