import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { publishPhoneScreenshot } from "../phone-screenshot-artifact";
import { verifiedPhoneScreenshotPath } from "../phone-screenshot-evidence";

const { authorize } = vi.hoisted(() => ({ authorize: vi.fn(async (value: string) => value) }));
vi.mock("../../agent/tools/file-tools", () => ({
  FileTools: class {
    authorizeApplicationPath = authorize;
  },
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  authorize.mockImplementation(async (value) => value);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "phone-artifact-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const captureId = randomUUID();
  const source = path.join(root, "private.png");
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  await fs.writeFile(source, bytes);
  const daemon = {
    getTask: () => ({ workspaceId: "ws" }),
    getWorkspaceById: () => ({
      id: "ws",
      path: workspace,
      permissions: { write: true, read: true },
    }),
    registerArtifact: vi.fn(),
    logEvent: vi.fn(),
  };
  const observation = {
    captureId,
    deviceId: "selected",
    mediaType: "image/png",
    imageBase64: bytes.toString("base64"),
  };
  const service = { capturePath: () => source };
  const publish = () =>
    publishPhoneScreenshot(daemon as never, "task", service as never, observation as never);
  return { root, workspace, source, bytes, daemon, observation, publish };
}
describe("approved phone screenshot deliverables", () => {
  it("publishes a linkable workspace PNG with file evidence and survives an identical repeated result", async () => {
    const f = await fixture();
    const result = await f.publish();
    expect(authorize).toHaveBeenCalledWith(result.path, "write");
    expect(await fs.readFile(result.path!)).toEqual(f.bytes);
    expect(f.daemon.registerArtifact).toHaveBeenCalledWith("task", result.path, "image/png");
    expect(f.daemon.logEvent).toHaveBeenCalledWith(
      "task",
      "file_created",
      expect.objectContaining({ path: result.path, type: "image", source: "android-phone" }),
    );
    expect(
      verifiedPhoneScreenshotPath("android_phone_observe", {}, result, "task", f.workspace),
    ).toBe(result.path);
    expect(
      verifiedPhoneScreenshotPath(
        "application_operation",
        { action: "execute" },
        result,
        "task",
        f.workspace,
      ),
    ).toBe(result.path);
    expect((await f.publish()).path).toBe(result.path);
  });
  it("keeps approved pixels available without exporting into a read-only workspace", async () => {
    const f = await fixture();
    f.daemon.getWorkspaceById = () => ({
      id: "ws",
      path: f.workspace,
      permissions: { read: true, write: false },
    });
    const result = await f.publish();
    expect(result.imageBase64).toBe(f.observation.imageBase64);
    expect(result.artifactWarning).toContain("does not permit");
    expect(result.path).toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
    expect(await fs.readdir(f.workspace)).toEqual([]);
  });
  it("denies export before writing when workspace file authority is denied", async () => {
    const f = await fixture();
    authorize.mockRejectedValueOnce(new Error("write permission denied"));
    await expect(f.publish()).rejects.toThrow(/permission denied/);
    expect(await fs.readdir(f.workspace)).toEqual([]);
    expect(f.daemon.registerArtifact).not.toHaveBeenCalled();
  });
  it("does not overwrite or follow a pre-existing screenshot destination", async () => {
    const f = await fixture();
    const external = path.join(f.root, "outside.png");
    await fs.writeFile(external, "keep");
    await fs.symlink(
      external,
      path.join(f.workspace, `android-screen-${f.observation.captureId}.png`),
    );
    await expect(f.publish()).rejects.toThrow();
    expect(await fs.readFile(external, "utf8")).toBe("keep");
    expect(f.daemon.registerArtifact).not.toHaveBeenCalled();
  });
  it("rejects missing, changed, cross-task, out-of-workspace, untrusted-tool and symlinked evidence", async () => {
    const f = await fixture();
    const result = await f.publish();
    expect(
      verifiedPhoneScreenshotPath("android_phone_observe", {}, result, "other", f.workspace),
    ).toBeNull();
    expect(verifiedPhoneScreenshotPath("web_fetch", {}, result, "task", f.workspace)).toBeNull();
    expect(
      verifiedPhoneScreenshotPath(
        "application_operation",
        { action: "create" },
        result,
        "task",
        f.workspace,
      ),
    ).toBeNull();
    expect(
      verifiedPhoneScreenshotPath("android_phone_observe", {}, result, "task", f.root),
    ).toBeNull();
    await fs.writeFile(result.path!, "changed");
    expect(
      verifiedPhoneScreenshotPath("android_phone_observe", {}, result, "task", f.workspace),
    ).toBeNull();
    await fs.unlink(result.path!);
    expect(
      verifiedPhoneScreenshotPath("android_phone_observe", {}, result, "task", f.workspace),
    ).toBeNull();
    await fs.symlink(f.source, result.path!);
    expect(
      verifiedPhoneScreenshotPath("android_phone_observe", {}, result, "task", f.workspace),
    ).toBeNull();
  });
});
