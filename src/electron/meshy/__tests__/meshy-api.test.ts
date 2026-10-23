import { describe, expect, it, vi } from "vitest";
import { createMeshyApiClient, resultUrls, toTaskInfo, viewerGlbUrl } from "../meshy-api";

const TASK = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const asset = (name: string) => `https://assets.meshy.ai/abc/${name}?Expires=1`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resultUrls", () => {
  it("keeps a model's own format links, only from Meshy's asset host", () => {
    expect(
      resultUrls({
        model_urls: { glb: asset("m.glb"), fbx: asset("m.fbx"), obj: "https://evil.example/m.obj" },
      }),
    ).toEqual({ glb: asset("m.glb"), fbx: asset("m.fbx") });
  });

  it("names a rig's character and its free clips", () => {
    const urls = resultUrls({
      result: {
        rigged_character_glb_url: asset("rig.glb"),
        rigged_character_fbx_url: asset("rig.fbx"),
        basic_animations: {
          walking_glb_url: asset("walk.glb"),
          running_glb_url: asset("run.glb"),
          walking_armature_glb_url: asset("walk-armature.glb"),
        },
      },
    });
    expect(urls).toEqual({
      glb: asset("rig.glb"),
      fbx: asset("rig.fbx"),
      "glb:walking": asset("walk.glb"),
      "glb:running": asset("run.glb"),
    });
    expect(viewerGlbUrl(urls)).toBe(asset("rig.glb"));
    expect(
      viewerGlbUrl({ "glb:running": asset("run.glb"), "glb:walking": asset("walk.glb") }),
    ).toBe(asset("walk.glb"));
  });
});

describe("toTaskInfo", () => {
  it("reports a running task's progress and stage", () => {
    const info = toTaskInfo(
      {
        id: TASK,
        status: "IN_PROGRESS",
        progress: 38.6,
        type: "text-to-3d-preview",
        prompt: "a chest",
      },
      TASK,
    );
    expect(info).toMatchObject({
      status: "IN_PROGRESS",
      progress: 39,
      stage: "previewing",
      prompt: "a chest",
      hasModel: false,
      error: null,
    });
  });

  it("reports a finished model and a failed task", () => {
    const done = toTaskInfo(
      {
        id: TASK,
        status: "SUCCEEDED",
        type: "image-to-3d",
        consumed_credits: 15,
        thumbnail_url: asset("t.png"),
        model_urls: { glb: asset("m.glb") },
      },
      TASK,
    );
    expect(done).toMatchObject({ hasModel: true, credits: 15, thumbnailUrl: asset("t.png") });

    const failed = toTaskInfo(
      { id: TASK, status: "FAILED", task_error: { message: "Image too dark" } },
      TASK,
    );
    expect(failed.error).toBe("Image too dark");
  });
});

describe("createMeshyApiClient", () => {
  it("finds a task on whichever endpoint owns it and sends the key", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/openapi/v1/image-to-3d/")
        ? jsonResponse(200, { id: TASK, status: "SUCCEEDED", type: "image-to-3d" })
        : jsonResponse(404, { message: "not found" }),
    );
    const client = createMeshyApiClient("msy_test", fetchMock as unknown as typeof fetch);
    const row = await client.task(TASK);
    expect(row.type).toBe("image-to-3d");
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.meshy.ai/openapi/v2/text-to-3d/${TASK}`);
    const init = fetchMock.mock.calls[0][1] as unknown as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer msy_test");
  });

  it("stops at a rejected key instead of trying every endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, {}));
    const client = createMeshyApiClient("bad", fetchMock as unknown as typeof fetch);
    await expect(client.task(TASK)).rejects.toThrow("Meshy rejected the API key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an id that is not a Meshy task id before any request", async () => {
    const fetchMock = vi.fn();
    const client = createMeshyApiClient("msy_test", fetchMock as unknown as typeof fetch);
    await expect(client.task("../balance")).rejects.toThrow("Not a Meshy task id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists recent finished generations newest first", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.meshy.ai/openapi/v2/text-to-3d?")) {
        return jsonResponse(200, [
          {
            id: TASK,
            status: "SUCCEEDED",
            type: "text-to-3d-preview",
            prompt: "chest",
            created_at: 10,
          },
          { id: "0199a1b2-c3d4-7e5f-8a9b-000000000000", status: "IN_PROGRESS", created_at: 20 },
        ]);
      }
      if (url.startsWith("https://api.meshy.ai/openapi/v1/text-to-image?")) {
        return jsonResponse(200, [
          {
            id: "0199a1b2-c3d4-7e5f-8a9b-111111111111",
            status: "SUCCEEDED",
            prompt: "dragon",
            created_at: 30,
          },
        ]);
      }
      return jsonResponse(200, []);
    });
    const client = createMeshyApiClient("msy_test", fetchMock as unknown as typeof fetch);
    const recent = await client.recent(10);
    expect(recent.map((item) => [item.prompt, item.kind])).toEqual([
      ["dragon", "image"],
      ["chest", "model"],
    ]);
  });
});
