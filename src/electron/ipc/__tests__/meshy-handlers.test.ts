import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>>(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel, handler) => registered.set(channel, handler)) },
  shell: { showItemInFolder: vi.fn() },
}));
vi.mock("../../meshy/meshy-service", () => ({
  getMeshyService: vi.fn(),
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { IPC_CHANNELS } from "../../../shared/types";
import { resolveReadableModel, setupMeshyHandlers } from "../meshy-handlers";
import type { MeshyService } from "../../meshy/meshy-service";

const appWindow = { senderFrame: { parent: null } } as IpcMainInvokeEvent;
const framedPage = { senderFrame: { parent: {} } } as unknown as IpcMainInvokeEvent;

describe("meshy IPC", () => {
  let root: string;
  let workspace: string;
  let outside: string;
  let service: { knownModel: ReturnType<typeof vi.fn>; task: ReturnType<typeof vi.fn> };
  const isKnownWorkspace = vi.fn(async (candidate: string) => candidate === workspace);

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "meshy-ipc-")));
    workspace = path.join(root, "workspace");
    outside = path.join(root, "outside");
    await fs.mkdir(path.join(workspace, "models"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(workspace, "models", "chest.glb"), "glTF-bytes");
    await fs.writeFile(path.join(outside, "secret.glb"), "secret");
    service = {
      knownModel: vi.fn(async () => {
        throw new Error("That model is not one Meshy saved on this machine");
      }),
      task: vi.fn(async () => ({ status: "SUCCEEDED" })),
    };
    registered.clear();
    setupMeshyHandlers({ isKnownWorkspace, service: service as unknown as MeshyService });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads a model inside a known workspace, by relative or absolute path", async () => {
    const deps = { isKnownWorkspace, service: service as unknown as MeshyService };
    const expected = path.join(workspace, "models", "chest.glb");
    expect(await resolveReadableModel("models/chest.glb", workspace, deps)).toBe(expected);
    expect(await resolveReadableModel(expected, workspace, deps)).toBe(expected);

    const read = registered.get(IPC_CHANNELS.MODEL3D_READ)!;
    const file = (await read(appWindow, {
      filePath: "models/chest.glb",
      workspacePath: workspace,
    })) as {
      name: string;
      bytes: Uint8Array;
    };
    expect(file.name).toBe("chest.glb");
    expect(Buffer.from(file.bytes).toString()).toBe("glTF-bytes");
  });

  it("refuses models outside the workspace that Meshy did not save", async () => {
    const deps = { isKnownWorkspace, service: service as unknown as MeshyService };
    await expect(resolveReadableModel("../outside/secret.glb", workspace, deps)).rejects.toThrow(
      "Model not found in this workspace",
    );
    await expect(
      resolveReadableModel(path.join(outside, "secret.glb"), workspace, deps),
    ).rejects.toThrow("not one Meshy saved");
  });

  it("does not trust a workspace path the app does not know", async () => {
    const deps = { isKnownWorkspace, service: service as unknown as MeshyService };
    await expect(resolveReadableModel("secret.glb", outside, deps)).rejects.toThrow();
    expect(service.knownModel).not.toHaveBeenCalled();
  });

  it("only reads glTF models", async () => {
    const deps = { isKnownWorkspace, service: service as unknown as MeshyService };
    await fs.writeFile(path.join(workspace, "notes.txt"), "x");
    await expect(resolveReadableModel("notes.txt", workspace, deps)).rejects.toThrow(
      "Only .glb and .gltf models",
    );
  });

  it("answers only the app window and validates task ids", async () => {
    const task = registered.get(IPC_CHANNELS.MESHY_TASK)!;
    await expect(
      task(framedPage, { taskId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" }),
    ).rejects.toThrow("only available to the app window");
    await expect(task(appWindow, { taskId: "../../balance" })).rejects.toThrow();
    expect(service.task).not.toHaveBeenCalled();
  });
});
