import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import {
  collectEndOfTaskArtifactCardStacks,
  collectLatestEndOfTaskArtifactCards,
  estimateEndOfTaskArtifactStackHeight,
  getGeneratedImagePathForTaskEvent,
} from "../MainContent/artifact-logic";

function makeEvent(
  id: string,
  timestamp: number,
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
): TaskEvent {
  return { id, taskId: "task-1", timestamp, type, payload } as TaskEvent;
}

describe("generated image artifact cards", () => {
  it("surfaces built-in generate_image output as an image card anchored at creation", () => {
    const call = makeEvent("call", 100, "tool_call", { tool: "generate_image" });
    const created = makeEvent("created", 200, "file_created", {
      path: "sunset.png",
      type: "image",
      mimeType: "image/png",
    });
    const assistant = makeEvent("assistant", 300, "assistant_message", {
      message: "Here is your image: sunset.png",
    });

    expect(getGeneratedImagePathForTaskEvent(created)).toBe("sunset.png");
    expect(collectEndOfTaskArtifactCardStacks([call, created, assistant])).toEqual([
      {
        anchorEventIndex: 1,
        artifacts: [
          {
            path: "sunset.png",
            kind: "image",
            eventId: "created",
            lastReferenceIndex: 1,
            lastReferenceTimestamp: 200,
          },
        ],
      },
    ]);
  });

  it("surfaces MCP-saved images, including legacy screenshot-typed MCP events", () => {
    const mcpImage = makeEvent("mcp-image", 100, "file_created", {
      path: "qwen-generate-image-1.png",
      type: "image",
      source: "mcp",
      mimeType: "image/png",
    });
    const legacyMcp = makeEvent("legacy", 200, "file_created", {
      path: "mcp-screenshot-123.png",
      type: "screenshot",
      source: "mcp",
      mimeType: "image/png",
    });

    expect(collectLatestEndOfTaskArtifactCards([mcpImage, legacyMcp]).map((c) => c.path)).toEqual([
      "qwen-generate-image-1.png",
      "mcp-screenshot-123.png",
    ]);
  });

  it("does not surface browser screenshots or MCP videos", () => {
    const browserShot = makeEvent("browser", 100, "file_created", {
      path: "screenshot-1.png",
      type: "screenshot",
    });
    const plainImage = makeEvent("plain", 150, "file_created", { path: "copied.png" });
    const mcpVideo = makeEvent("video", 200, "file_created", {
      path: "clip.mp4",
      type: "video",
      source: "mcp",
    });

    expect(getGeneratedImagePathForTaskEvent(browserShot)).toBeNull();
    expect(getGeneratedImagePathForTaskEvent(plainImage)).toBeNull();
    expect(getGeneratedImagePathForTaskEvent(mcpVideo)).toBeNull();
    expect(collectLatestEndOfTaskArtifactCards([browserShot, plainImage, mcpVideo])).toEqual([]);
  });

  it("skips an image card when an assistant answer already embeds the image inline", () => {
    const created = makeEvent("created", 100, "file_created", {
      path: "images/my sunset.png",
      type: "image",
    });
    const other = makeEvent("other", 150, "file_created", { path: "other.png", type: "image" });
    const assistant = makeEvent("assistant", 200, "assistant_message", {
      message: "Done!\n\n![Sunset](images/my%20sunset.png)",
    });

    expect(
      collectLatestEndOfTaskArtifactCards([created, other, assistant]).map((c) => c.path),
    ).toEqual(["other.png"]);
  });

  it("skips an image card when an assistant answer links the image (the link shows a thumbnail)", () => {
    const created = makeEvent("created", 100, "file_created", { path: "cat.png", type: "image" });
    const vector = makeEvent("vector", 120, "file_created", { path: "logo.svg", type: "image" });
    const assistant = makeEvent("assistant", 200, "assistant_message", {
      message: "Saved [cat.png](cat.png) and [logo](logo.svg).",
    });

    expect(
      collectLatestEndOfTaskArtifactCards([created, vector, assistant]).map((c) => c.path),
    ).toEqual(["logo.svg"]);
  });

  it("keeps image cards from crowding out file cards and estimates their taller height", () => {
    const images = Array.from({ length: 10 }, (_, index) =>
      makeEvent(`img-${index}`, 100 + index, "file_created", {
        path: `img-${index}.png`,
        type: "image",
      }),
    );
    const doc = makeEvent("doc", 500, "file_created", { path: "report.docx" });
    const assistant = makeEvent("assistant", 600, "assistant_message", {
      message: "Saved files: report.docx",
    });

    const cards = collectLatestEndOfTaskArtifactCards([...images, doc, assistant]);
    expect(cards.filter((c) => c.kind === "document").map((c) => c.path)).toEqual(["report.docx"]);
    expect(cards.filter((c) => c.kind === "image")).toHaveLength(8);

    const imageCard = cards.find((c) => c.kind === "image")!;
    const docCard = cards.find((c) => c.kind === "document")!;
    expect(estimateEndOfTaskArtifactStackHeight([imageCard], false)).toBeGreaterThan(
      estimateEndOfTaskArtifactStackHeight([docCard], false) + 150,
    );
  });
});
