import { describe, expect, it } from "vitest";
import { browserVisualAttachments } from "./browser-task-input";

const image = {
  filePath: "/work/project/input.png",
  mimeType: "image/png",
  filename: "input.png",
  sizeBytes: 10,
};

describe("browser visual task input", () => {
  it("sends only a workspace-relative descriptor for an imported image", () => {
    expect(browserVisualAttachments([image], "/work/project")).toEqual([
      { relativePath: "input.png", mimeType: "image/png", filename: "input.png", sizeBytes: 10 },
    ]);
  });

  it.each([
    "/work/project-other/input.png",
    "/work/project/../private/input.png",
    "/private/input.png",
    "../input.png",
    "file:///work/project/input.png",
  ])("rejects out-of-scope or aliased path %s", (filePath) => {
    expect(() => browserVisualAttachments([{ ...image, filePath }], "/work/project")).toThrow();
  });

  it("handles native Windows workspace paths without exposing the drive", () => {
    expect(
      browserVisualAttachments(
        [{ ...image, filePath: "C:\\work\\project\\input.png" }],
        "C:\\work\\project",
      )[0].relativePath,
    ).toBe("input.png");
  });

  it.each([
    { data: "secret" },
    { tempFile: true },
    { videoFramePaths: ["/private/frame.png"] },
    { mimeType: "image/svg+xml" },
    { filename: "../input.png" },
    { sizeBytes: 0 },
    { sizeBytes: 64 * 1024 * 1024 + 1 },
  ])("rejects unsupported or unbounded input %j", (override) => {
    expect(() => browserVisualAttachments([{ ...image, ...override }], "/work/project")).toThrow();
  });

  it("bounds attachment count", () => {
    expect(() => browserVisualAttachments(Array(6).fill(image), "/work/project")).toThrow();
  });

  it("bounds total media bytes and the stricter image size", () => {
    expect(() =>
      browserVisualAttachments([{ ...image, sizeBytes: 25 * 1024 * 1024 + 1 }], "/work/project"),
    ).toThrow();
    const video = {
      ...image,
      filePath: "/work/project/input.mp4",
      filename: "input.mp4",
      mimeType: "video/mp4",
      sizeBytes: 64 * 1024 * 1024,
    };
    expect(() =>
      browserVisualAttachments([video, video, { ...video, sizeBytes: 1 }], "/work/project"),
    ).toThrow();
  });
});
