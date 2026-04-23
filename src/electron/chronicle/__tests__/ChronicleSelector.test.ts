import { describe, expect, it } from "vitest";
import { ChronicleSelector } from "../ChronicleSelector";

describe("ChronicleSelector", () => {
  it("prefers OCR and app/title matches over recency alone", () => {
    const now = Date.now();
    const results = ChronicleSelector.rank(
      [
        {
          id: "recent-generic",
          capturedAt: now,
          displayId: "1",
          appName: "Finder",
          windowTitle: "Desktop",
          imagePath: "/tmp/a.png",
          localTextSnippet: "",
          width: 100,
          height: 100,
        },
        {
          id: "older-match",
          capturedAt: now - 90_000,
          displayId: "1",
          appName: "Visual Studio Code",
          windowTitle: "build.log",
          imagePath: "/tmp/b.png",
          localTextSnippet: "TypeError: build failed on line 42",
          width: 100,
          height: 100,
        },
      ],
      "why is this failing",
      2,
    );

    expect(results[0]?.observationId).toBe("older-match");
    expect(results[0]?.confidence).toBeGreaterThan(results[1]?.confidence ?? 0);
  });

  it("requests fallback when only weak passive matches exist", () => {
    const results = ChronicleSelector.rank(
      [
        {
          id: "frame-1",
          capturedAt: Date.now() - 30_000,
          displayId: "1",
          appName: "Desktop",
          windowTitle: "Screen",
          imagePath: "/tmp/frame.png",
          localTextSnippet: "",
          width: 100,
          height: 100,
        },
      ],
      "latest draft in google docs",
      1,
    );

    expect(ChronicleSelector.shouldFallback(results, "latest draft in google docs")).toBe(true);
  });
});
