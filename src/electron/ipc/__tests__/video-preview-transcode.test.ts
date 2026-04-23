import { describe, expect, it } from "vitest";

import { buildVideoPreviewTranscodeArgs } from "../video-preview-transcode";

describe("buildVideoPreviewTranscodeArgs", () => {
  it("builds a video-only ffmpeg command so silent mp4 previews still transcode", () => {
    const args = buildVideoPreviewTranscodeArgs(
      "/workspace/artifacts/demo.mp4",
      "/tmp/demo-preview.webm",
    );

    expect(args).toEqual([
      "-y",
      "-i",
      "/workspace/artifacts/demo.mp4",
      "-map",
      "0:v:0",
      "-an",
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-cpu-used",
      "5",
      "-crf",
      "24",
      "-b:v",
      "1M",
      "/tmp/demo-preview.webm",
    ]);
    expect(args).not.toContain("-c:a");
    expect(args).not.toContain("-b:a");
  });
});
