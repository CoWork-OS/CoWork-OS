import { describe, expect, it } from "vitest";
import { buildYouTubeWatchUrl, extractYouTubeVideoId } from "../url";

describe("extractYouTubeVideoId", () => {
  it("accepts direct video IDs", () => {
    expect(extractYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts IDs from common YouTube URL formats", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://music.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("rejects non-YouTube and malformed inputs", () => {
    expect(extractYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=too-short")).toBeNull();
    expect(extractYouTubeVideoId("")).toBeNull();
  });
});

describe("buildYouTubeWatchUrl", () => {
  it("builds timestamped watch URLs", () => {
    expect(buildYouTubeWatchUrl("dQw4w9WgXcQ", 42_900)).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    );
  });

  it("omits invalid timestamps", () => {
    expect(buildYouTubeWatchUrl("dQw4w9WgXcQ", -1)).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });
});
