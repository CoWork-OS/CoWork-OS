import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMeshyLibrary, downloadMeshyAsset, freeDestination } from "../meshy-library";

const TASK = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("meshy library", () => {
  let root: string;
  let dataDir: string;
  let project: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "meshy-library-")));
    dataDir = path.join(root, "meshy");
    project = path.join(root, "project");
    await fs.mkdir(path.join(dataDir, "meshy_output", TASK), { recursive: true });
    await fs.mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists recorded models with their prompt, and models in Meshy's own folder", async () => {
    const library = createMeshyLibrary(() => dataDir);
    const saved = path.join(project, "chest.glb");
    await fs.writeFile(saved, "glb");
    await fs.writeFile(path.join(dataDir, "meshy_output", TASK, "model.glb"), "glb");

    await library.recordCreation({
      taskId: TASK,
      tool: "meshy_text_to_3d",
      prompt: "  a   chest ",
    });
    await library.recordModel({ path: saved, taskId: TASK, chatTaskId: "chat-1" });

    const models = await library.listModels(10);
    expect(models.map((model) => model.path).sort()).toEqual(
      [saved, path.join(dataDir, "meshy_output", TASK, "model.glb")].sort(),
    );
    const chest = models.find((model) => model.path === saved)!;
    expect(chest).toMatchObject({ taskId: TASK, prompt: "a chest", chatTaskId: "chat-1" });
    expect(await library.savedPathFor(TASK)).toBe(saved);
  });

  it("knows only recorded models and files in its own folder", async () => {
    const library = createMeshyLibrary(() => dataDir);
    const recorded = path.join(project, "chest.glb");
    const other = path.join(project, "other.glb");
    await fs.writeFile(recorded, "glb");
    await fs.writeFile(other, "glb");
    await library.recordModel({ path: recorded, taskId: TASK });

    expect(await library.isKnownModelPath(recorded)).toBe(true);
    expect(await library.isKnownModelPath(other)).toBe(false);
    expect(
      await library.isKnownModelPath(path.join(dataDir, "meshy_output", TASK, "model.glb")),
    ).toBe(true);
    expect(await library.isKnownModelPath(path.join(dataDir, "notes.txt"))).toBe(false);
  });

  it("ignores paths that are not models, are relative or do not exist", async () => {
    const library = createMeshyLibrary(() => dataDir);
    await fs.writeFile(path.join(project, "secret.txt"), "x");
    await library.recordModel({ path: path.join(project, "secret.txt") });
    await library.recordModel({ path: "relative.glb" });
    await library.recordModel({ path: path.join(project, "missing.glb") });
    expect(await library.isKnownModelPath(path.join(project, "secret.txt"))).toBe(false);
    expect((await library.listModels(10)).length).toBe(0);
  });

  it("keeps its index outside the server's folder when given its own", async () => {
    const indexDir = path.join(root, "index");
    const library = createMeshyLibrary(
      () => dataDir,
      () => indexDir,
    );
    const saved = path.join(project, "chest.glb");
    await fs.writeFile(saved, "glb");
    await library.recordModel({ path: saved, taskId: TASK });
    await expect(fs.access(path.join(indexDir, "cowork-library.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dataDir, "cowork-library.json"))).rejects.toThrow();
  });

  it("never picks an existing file name", async () => {
    await fs.writeFile(path.join(project, "model.fbx"), "x");
    await fs.writeFile(path.join(project, "model-2.fbx"), "x");
    expect(await freeDestination(project, "model", "fbx")).toBe(path.join(project, "model-3.fbx"));
  });
});

describe("downloadMeshyAsset", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "meshy-download-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses hosts other than Meshy's asset host", async () => {
    const fetchMock = async () => new Response("x");
    await expect(
      downloadMeshyAsset("https://evil.example/m.glb", path.join(root, "m.glb"), fetchMock),
    ).rejects.toThrow("Unexpected download host");
  });

  it("writes the file and never over an existing one", async () => {
    const target = path.join(root, "m.glb");
    const fetchMock = async () => new Response("model-bytes");
    const bytes = await downloadMeshyAsset("https://assets.meshy.ai/a/m.glb", target, fetchMock);
    expect(bytes).toBe(11);
    expect(await fs.readFile(target, "utf8")).toBe("model-bytes");
    await expect(
      downloadMeshyAsset("https://assets.meshy.ai/a/m.glb", target, fetchMock),
    ).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("model-bytes");
  });

  it("says an expired link has expired", async () => {
    const fetchMock = async () => new Response("", { status: 403 });
    await expect(
      downloadMeshyAsset("https://assets.meshy.ai/a/m.glb", path.join(root, "m.glb"), fetchMock),
    ).rejects.toThrow(/expired/);
  });
});
