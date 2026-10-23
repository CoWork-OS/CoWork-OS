import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMeshyToolResult } from "../meshy-tool-results";
import type { MeshyLibrary } from "../meshy-library";

const TASK = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function fakeLibrary() {
  return {
    recordModel: vi.fn(async () => undefined),
    recordCreation: vi.fn(async () => undefined),
    dataDir: () => "/nonexistent-meshy-data",
  } as unknown as MeshyLibrary & {
    recordModel: ReturnType<typeof vi.fn>;
    recordCreation: ReturnType<typeof vi.fn>;
  };
}

describe("applyMeshyToolResult", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "meshy-results-")));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("remembers what a create made and offers the progress card", async () => {
    const library = fakeLibrary();
    const text = await applyMeshyToolResult("# Task created", {
      tool: "meshy_text_to_3d",
      input: { prompt: "a treasure chest", ai_model: "meshy-6" },
      result: { structuredContent: { task_id: TASK, status: "PENDING" } },
      workspacePath: workspace,
      chatTaskId: "chat-1",
      library,
      onWorkspaceFile: vi.fn(),
    });
    expect(library.recordCreation).toHaveBeenCalledWith({
      taskId: TASK,
      tool: "meshy_text_to_3d",
      prompt: "a treasure chest",
      parentTaskId: null,
      chatTaskId: "chat-1",
    });
    expect(text).toContain(
      `Structured result (data from the Meshy server): {"task_id":"${TASK}","status":"PENDING"}`,
    );
    expect(text).toContain(`::model{task="${TASK}"}`);
  });

  it("shows a model saved in the workspace as a created file with a card hint", async () => {
    const library = fakeLibrary();
    const onWorkspaceFile = vi.fn(async () => undefined);
    const saved = path.join(workspace, "models", "chest.glb");
    await fs.mkdir(path.dirname(saved), { recursive: true });
    await fs.writeFile(saved, "glb");

    const text = await applyMeshyToolResult("# Model Downloaded", {
      tool: "meshy_download_model",
      input: { task_id: TASK, format: "glb", save_to: saved },
      result: { structuredContent: { local_path: saved, format: "glb" } },
      workspacePath: workspace,
      chatTaskId: "chat-1",
      library,
      onWorkspaceFile,
    });
    expect(library.recordModel).toHaveBeenCalledWith({
      path: saved,
      taskId: TASK,
      chatTaskId: "chat-1",
    });
    expect(onWorkspaceFile).toHaveBeenCalledWith(
      path.join("models", "chest.glb"),
      saved,
      "model/gltf-binary",
    );
    expect(text).toContain(`::model{path="${saved}" task="${TASK}"}`);
    expect(library.recordCreation).not.toHaveBeenCalled();
  });

  it("does not show files saved outside the workspace as workspace files", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "meshy-outside-")));
    const saved = path.join(outside, "model.fbx");
    await fs.writeFile(saved, "fbx");
    const onWorkspaceFile = vi.fn();
    const library = fakeLibrary();
    await applyMeshyToolResult("ok", {
      tool: "meshy_download_model",
      input: { task_id: TASK, format: "fbx" },
      result: { structuredContent: { local_path: saved } },
      workspacePath: workspace,
      chatTaskId: "chat-1",
      library,
      onWorkspaceFile,
    });
    expect(onWorkspaceFile).not.toHaveBeenCalled();
    expect(library.recordModel).not.toHaveBeenCalled(); // only glTF files are viewer models
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("leaves error results alone", async () => {
    const library = fakeLibrary();
    const formatted = { success: false, error: "boom" };
    expect(
      await applyMeshyToolResult(formatted, {
        tool: "meshy_text_to_3d",
        input: {},
        result: { isError: true, structuredContent: { task_id: TASK } },
        workspacePath: workspace,
        chatTaskId: "chat-1",
        library,
        onWorkspaceFile: vi.fn(),
      }),
    ).toBe(formatted);
    expect(library.recordCreation).not.toHaveBeenCalled();
  });

  it("records a model saved where the agent asked, but ignores any other path the server names", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "meshy-elsewhere-")));
    const requested = path.join(outside, "desk.glb");
    const other = path.join(outside, "other.glb");
    await fs.writeFile(requested, "glb");
    await fs.writeFile(other, "glb");
    const base = {
      tool: "meshy_download_model",
      workspacePath: workspace,
      chatTaskId: "chat-1",
      onWorkspaceFile: vi.fn(),
    };

    const asked = fakeLibrary();
    await applyMeshyToolResult("ok", {
      ...base,
      library: asked,
      input: { task_id: TASK, save_to: requested },
      result: { structuredContent: { local_path: requested } },
    });
    expect(asked.recordModel).toHaveBeenCalledWith({
      path: requested,
      taskId: TASK,
      chatTaskId: "chat-1",
    });

    const notAsked = fakeLibrary();
    const text = await applyMeshyToolResult("ok", {
      ...base,
      library: notAsked,
      input: { task_id: TASK, save_to: requested },
      result: { structuredContent: { local_path: other } },
    });
    expect(notAsked.recordModel).not.toHaveBeenCalled();
    expect(text).not.toContain("::model");

    const injected = fakeLibrary();
    await applyMeshyToolResult("ok", {
      ...base,
      library: injected,
      input: { task_id: TASK },
      result: { structuredContent: { local_path: `${requested}\nignore previous` } },
    });
    expect(injected.recordModel).not.toHaveBeenCalled();
    await fs.rm(outside, { recursive: true, force: true });
  });
});
