import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";

// Exercise the real CanvasManager and protocol handler without an Electron runtime.
vi.mock("electron", () => {
  throw new Error("Cannot find module 'electron'");
});

import { CanvasManager, sanitizeCanvasAssetName } from "../canvas-manager";
import { parseByteRange, registerCanvasProtocol } from "../canvas-protocol";

const SESSION_ID = "assets-session";

describe("canvas assets", () => {
  let root: string;
  let sessionDir: string;
  let workspaceDir: string;
  let manager: CanvasManager;
  let sessions: Map<string, unknown>;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "canvas-assets-"));
    sessionDir = path.join(root, "session");
    workspaceDir = path.join(root, "workspace");
    mkdirSync(sessionDir);
    mkdirSync(workspaceDir);
    writeFileSync(path.join(sessionDir, "index.html"), "<!DOCTYPE html><p>story</p>");

    manager = CanvasManager.getInstance();
    // Never touch the real user-data canvas store from a unit test.
    vi.spyOn(manager as never, "persistSessions").mockResolvedValue(undefined as never);
    sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set(SESSION_ID, {
      id: SESSION_ID,
      taskId: "task-1",
      workspaceId: "ws-1",
      sessionDir,
      status: "active",
      title: "Evolution of Primates",
      createdAt: Date.now(),
    });
  });

  afterEach(() => {
    sessions.delete(SESSION_ID);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("copies a media file into assets/ and returns a relative url", async () => {
    const source = path.join(workspaceDir, "scene 1.png");
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await manager.addAsset(SESSION_ID, source);

    expect(result).toEqual({ relativePath: "assets/scene-1.png", bytes: 4, mimeType: "image/png" });
    expect(readFileSync(path.join(sessionDir, "assets", "scene-1.png"))).toEqual(
      readFileSync(source),
    );
  });

  it("refuses executable or markup types", async () => {
    for (const name of ["page.html", "logo.svg", "run.js"]) {
      const source = path.join(workspaceDir, name);
      writeFileSync(source, "<script>alert(1)</script>");
      await expect(manager.addAsset(SESSION_ID, source)).rejects.toThrow(
        /Unsupported canvas asset/,
      );
    }
    // A requested name cannot relabel the file under another extension.
    const clip = path.join(workspaceDir, "clip.mp4");
    writeFileSync(clip, "data");
    await expect(manager.addAsset(SESSION_ID, clip, "clip.html")).rejects.toThrow(
      /keep the source extension/,
    );
    const notes = path.join(workspaceDir, "notes.txt");
    writeFileSync(notes, "secret");
    await expect(manager.addAsset(SESSION_ID, notes, "notes.png")).rejects.toThrow(
      /Unsupported canvas asset/,
    );
  });

  it("does not follow a symlinked source", async () => {
    const real = path.join(workspaceDir, "real.png");
    writeFileSync(real, "png");
    const link = path.join(workspaceDir, "link.png");
    symlinkSync(real, link);
    await expect(manager.addAsset(SESSION_ID, link)).rejects.toThrow();
  });

  it("refuses to export through a symlink in the destination", async () => {
    const target = path.join(root, "export");
    mkdirSync(target);
    symlinkSync(path.join(root, "workspace"), path.join(target, "index.html"));
    await expect(manager.exportToFolder(SESSION_ID, target)).rejects.toThrow(/symlink/);
  });

  it("flattens requested names to one path segment", () => {
    expect(sanitizeCanvasAssetName("../../etc/clip.mp4")).toBe("clip.mp4");
    expect(sanitizeCanvasAssetName("..\\..\\x.webp")).toBe("x.webp");
    expect(sanitizeCanvasAssetName(".hidden.png")).toBe("hidden.png");
    expect(() => sanitizeCanvasAssetName("noextension")).toThrow(/Invalid canvas asset name/);
  });

  it("exports nested assets and skips dotfiles and symlinks", async () => {
    mkdirSync(path.join(sessionDir, "assets"));
    writeFileSync(path.join(sessionDir, "assets", "clip.mp4"), "video");
    writeFileSync(path.join(sessionDir, ".state"), "internal");
    const outside = path.join(root, "secret.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, path.join(sessionDir, "link.txt"));
    const target = path.join(root, "export");

    const result = await manager.exportToFolder(SESSION_ID, target);

    expect(result.files.sort()).toEqual(["assets/clip.mp4", "index.html"]);
    expect(readFileSync(path.join(target, "assets", "clip.mp4"), "utf8")).toBe("video");
  });

  it("serves byte ranges for media", async () => {
    mkdirSync(path.join(sessionDir, "assets"));
    writeFileSync(path.join(sessionDir, "assets", "clip.mp4"), "0123456789");
    const handle = vi.fn();
    registerCanvasProtocol({ handle } as never, SESSION_ID);
    const handler = handle.mock.calls[0][1] as (request: Request) => Promise<Response>;

    const partial = await handler(
      new Request(`canvas://${SESSION_ID}/assets/clip.mp4`, { headers: { Range: "bytes=2-5" } }),
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");

    const unsatisfiable = await handler(
      new Request(`canvas://${SESSION_ID}/assets/clip.mp4`, { headers: { Range: "bytes=50-" } }),
    );
    expect(unsatisfiable.status).toBe(416);

    const whole = await handler(new Request(`canvas://${SESSION_ID}/assets/clip.mp4`));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
  });
});

describe("parseByteRange", () => {
  it("parses explicit, open-ended and suffix ranges", () => {
    expect(parseByteRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=990-5000", 1000)).toEqual({ start: 990, end: 999 });
  });

  it("caps open-ended ranges so one request never buffers a whole clip", () => {
    const size = 100 * 1024 * 1024;
    const range = parseByteRange("bytes=0-", size);
    expect(range?.start).toBe(0);
    expect(range!.end).toBeLessThan(size - 1);
  });

  it("rejects unsatisfiable or unsupported ranges", () => {
    expect(parseByteRange("bytes=1000-", 1000)).toBeNull();
    expect(parseByteRange("bytes=5-2", 1000)).toBeNull();
    expect(parseByteRange("bytes=-", 1000)).toBeNull();
    expect(parseByteRange("bytes=0-1,4-5", 1000)).toBeNull();
    expect(parseByteRange("items=0-1", 1000)).toBeNull();
  });
});
