import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WebRequestContext } from "../../web/WebApplication";
import {
  parseBrowserTaskMediaDescriptors,
  releaseBrowserTaskMedia,
  resolveBrowserTaskMedia,
  type BrowserTaskMediaDescriptor,
} from "../browser-task-media";

const context: WebRequestContext = {
  audience: "control-plane",
  sessionId: "session",
  identity: {
    installationId: "install",
    profileId: "profile",
    generation: "generation",
    runtime: "node",
    platform: "linux",
    appVersion: "test",
  },
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const descriptor: BrowserTaskMediaDescriptor = {
  relativePath: "uploads/image.png",
  mimeType: "image/png",
  sizeBytes: png.length,
};
function reader(bytes = png) {
  return {
    readTaskMedia: vi.fn().mockResolvedValue({
      bytes,
      sizeBytes: bytes.length,
      identity: { dev: 1, ino: 2, size: bytes.length, mtimeMs: 3 },
    }),
  };
}

describe("browser task media capture", () => {
  it.each([
    { ...descriptor, relativePath: "../image.png" },
    { ...descriptor, relativePath: "/private/image.png" },
    { ...descriptor, relativePath: "uploads\\image.png" },
    { ...descriptor, relativePath: "uploads//image.png" },
    { ...descriptor, relativePath: "uploads/./image.png" },
    { ...descriptor, filePath: "/private/image.png" },
    { ...descriptor, data: "raw-base64" },
    { ...descriptor, mimeType: "image/svg+xml" },
    { ...descriptor, filename: "image.html" },
    { ...descriptor, filename: "bad\nimage.png" },
    { ...descriptor, sizeBytes: 0 },
    { ...descriptor, sizeBytes: 1.5 },
  ])("rejects unscoped or unsupported descriptors %#", (value) => {
    expect(() => parseBrowserTaskMediaDescriptors([value])).toThrow();
  });

  it("rejects count and byte limits before opening a file", async () => {
    expect(() => parseBrowserTaskMediaDescriptors(Array(6).fill(descriptor))).toThrow();
    const source = reader();
    await expect(
      resolveBrowserTaskMedia(source, context, "workspace", [
        { ...descriptor, sizeBytes: 25 * 1024 * 1024 + 1 },
      ]),
    ).rejects.toThrow(/size limit/);
    const video: BrowserTaskMediaDescriptor = {
      relativePath: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 64 * 1024 * 1024,
    };
    await expect(
      resolveBrowserTaskMedia(source, context, "workspace", [video, video, video]),
    ).rejects.toThrow(/total size/);
    expect(source.readTaskMedia).not.toHaveBeenCalled();
  });

  it.each([
    ["image/jpeg", "image.jpg", Buffer.from([255, 216, 255, 224])],
    ["image/png", "image.png", png],
    ["image/gif", "image.gif", Buffer.from("GIF89a")],
    ["image/webp", "image.webp", Buffer.from("RIFF0000WEBP")],
    ["video/mp4", "video.mp4", Buffer.from("0000ftypisom")],
    ["video/quicktime", "video.mov", Buffer.from("0000ftypqt  ")],
    ["video/webm", "video.webm", Buffer.from([26, 69, 223, 163])],
  ] as const)(
    "captures verified %s content and fingerprints its bytes",
    async (mimeType, filename, bytes) => {
      const source = reader(bytes);
      const captures = await resolveBrowserTaskMedia(source, context, "workspace", [
        {
          relativePath: `uploads/${filename}`,
          mimeType,
          sizeBytes: bytes.length,
        },
      ]);
      try {
        expect(captures[0]).toMatchObject({
          filename,
          mimeType,
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          identity: { dev: 1, ino: 2, size: bytes.length, mtimeMs: 3 },
        });
        expect(source.readTaskMedia).toHaveBeenCalledWith(
          context,
          "workspace",
          `uploads/${filename}`,
          mimeType.startsWith("video/") ? 64 * 1024 * 1024 : 25 * 1024 * 1024,
          bytes.length,
        );
      } finally {
        releaseBrowserTaskMedia(captures);
      }
    },
  );

  it("rejects disguised media and changed selection sizes", async () => {
    await expect(
      resolveBrowserTaskMedia(reader(Buffer.from("not-an-image")), context, "workspace", [
        { ...descriptor, sizeBytes: 12 },
      ]),
    ).rejects.toThrow(/media type/);
    await expect(
      resolveBrowserTaskMedia(reader(), context, "workspace", [
        { ...descriptor, sizeBytes: png.length + 1 },
      ]),
    ).rejects.toThrow(/changed/);
    const captures = await resolveBrowserTaskMedia(reader(), context, "workspace", [descriptor]);
    releaseBrowserTaskMedia(captures);
    releaseBrowserTaskMedia(captures);
  });

  it("reserves concurrent capture bytes before reads and frees failed reservations", async () => {
    const rejectors: Array<(error: Error) => void> = [];
    const source = {
      readTaskMedia: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectors.push(reject);
          }),
      ),
    };
    const video: BrowserTaskMediaDescriptor = {
      relativePath: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 64 * 1024 * 1024,
    };
    const pending = [
      resolveBrowserTaskMedia(source, context, "workspace", [video, video]),
      resolveBrowserTaskMedia(source, context, "workspace", [video, video]),
    ];
    const settled = Promise.allSettled(pending);
    try {
      await expect(
        resolveBrowserTaskMedia(reader(), context, "workspace", [descriptor]),
      ).rejects.toMatchObject({ code: "RATE_LIMITED", statusCode: 429 });
      expect(source.readTaskMedia).toHaveBeenCalledTimes(2);
    } finally {
      for (const reject of rejectors) reject(new Error("capture failed"));
      expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    }
    const captures = await resolveBrowserTaskMedia(reader(), context, "workspace", [descriptor]);
    releaseBrowserTaskMedia(captures);
  });
});
