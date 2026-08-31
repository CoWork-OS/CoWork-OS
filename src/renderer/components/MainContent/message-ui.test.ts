import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isLastAssistantMessageEvent, UserMessageImageGallery } from "./message-ui";

describe("isLastAssistantMessageEvent", () => {
  it("matches only the assistant event that is currently last", () => {
    const earlier = { id: "assistant-1" };
    const latest = { id: "assistant-2" };

    expect(isLastAssistantMessageEvent(earlier, latest)).toBe(false);
    expect(isLastAssistantMessageEvent(latest, latest)).toBe(true);
  });

  it("does not expose latest-message actions for events without an id", () => {
    expect(isLastAssistantMessageEvent({}, { id: "assistant-1" })).toBe(false);
    expect(isLastAssistantMessageEvent({ id: "assistant-1" }, null)).toBe(false);
  });
});

describe("UserMessageImageGallery", () => {
  it("renders multiple image attachments as a dedicated gallery above the message bubble", () => {
    const markup = renderToStaticMarkup(
      createElement(UserMessageImageGallery, {
        attachments: [
          {
            filePath: "/workspace/one.png",
            mimeType: "image/png",
            filename: "one.png",
            sizeBytes: 100,
          },
          {
            filePath: "/workspace/two.png",
            mimeType: "image/png",
            filename: "two.png",
            sizeBytes: 200,
          },
          {
            filePath: "/workspace/three.png",
            mimeType: "image/png",
            filename: "three.png",
            sizeBytes: 300,
          },
        ],
        workspacePath: "/workspace",
      }),
    );

    expect(markup).toContain("user-message-image-gallery-multiple");
    expect(markup).toContain('aria-label="3 attached images"');
    expect(markup.match(/user-message-image-gallery-item/g)).toHaveLength(3);
    expect(markup).not.toContain("user-message-image-gallery-fallback");
  });

  it("does not create a gallery for video-only attachments", () => {
    const markup = renderToStaticMarkup(
      createElement(UserMessageImageGallery, {
        attachments: [
          {
            filePath: "/workspace/demo.mp4",
            mimeType: "video/mp4",
            filename: "demo.mp4",
            sizeBytes: 400,
          },
        ],
        workspacePath: "/workspace",
      }),
    );

    expect(markup).toBe("");
  });
});
