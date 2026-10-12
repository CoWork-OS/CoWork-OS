import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import {
  collectGeneratedImageStacks,
  estimateGeneratedImageStackHeight,
  getGeneratedImagePathForTaskEvent,
  getVisibleGeneratedImageCards,
  type GeneratedImageCard,
} from "../MainContent/artifact-logic";

function collectImagePaths(events: TaskEvent[]): string[] {
  return collectGeneratedImageStacks(events).flatMap((stack) =>
    stack.images.map((image) => image.path),
  );
}

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
    expect(collectGeneratedImageStacks([call, created, assistant])).toEqual([
      {
        anchorEventIndex: 1,
        images: [{ path: "sunset.png", eventId: "created", eventIndex: 1 }],
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

    expect(collectImagePaths([mcpImage, legacyMcp])).toEqual([
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
    expect(collectGeneratedImageStacks([browserShot, plainImage, mcpVideo])).toEqual([]);
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

    expect(collectImagePaths([created, other, assistant])).toEqual(["other.png"]);
  });

  it("skips an image card when an assistant answer links the image (the link shows a thumbnail)", () => {
    const created = makeEvent("created", 100, "file_created", { path: "cat.png", type: "image" });
    const vector = makeEvent("vector", 120, "file_created", { path: "logo.svg", type: "image" });
    const assistant = makeEvent("assistant", 200, "assistant_message", {
      message: "Saved [cat.png](cat.png) and [logo](logo.svg).",
    });

    expect(collectImagePaths([created, vector, assistant])).toEqual(["logo.svg"]);
  });

  it("keeps the latest eight images, never document cards, and folds past five", () => {
    const images = Array.from({ length: 10 }, (_, index) =>
      makeEvent(`img-${index}`, 100 + index, "file_created", {
        path: `img-${index}.png`,
        type: "image",
      }),
    );
    const doc = makeEvent("doc", 500, "file_created", { path: "report.docx" });

    const paths = collectImagePaths([...images, doc]);
    expect(paths).toHaveLength(8);
    expect(paths[0]).toBe("img-2.png");
    expect(paths).not.toContain("report.docx");

    const cards: GeneratedImageCard[] = paths.map((path, eventIndex) => ({ path, eventIndex }));
    expect(getVisibleGeneratedImageCards(cards, false)).toEqual({
      visibleImages: cards.slice(0, 5),
      hiddenCount: 3,
    });
    expect(getVisibleGeneratedImageCards(cards, true).hiddenCount).toBe(0);
    expect(estimateGeneratedImageStackHeight(cards, true)).toBeGreaterThan(
      estimateGeneratedImageStackHeight(cards, false),
    );
  });
});
