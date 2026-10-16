import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let portalContent: ReactElement<Record<string, unknown>> | null = null;

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: ReactElement<Record<string, unknown>>) => {
    portalContent = children;
    return null;
  },
}));

const { VideoLightbox, formatVideoTime, nextPlaybackRate, resolveVideoShortcut } =
  await import("../VideoLightbox");

function render(props: Partial<Parameters<typeof VideoLightbox>[0]> = {}) {
  vi.stubGlobal("document", { body: {} });
  try {
    renderToStaticMarkup(createElement(VideoLightbox, { onClose: () => {}, ...props }));
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("VideoLightbox", () => {
  it("closes on a backdrop click without letting it reach the surrounding card", () => {
    const onClose = vi.fn();
    render({ src: "blob:video", onClose });

    expect(portalContent?.props.role).toBe("dialog");
    const stopPropagation = vi.fn();
    const onClick = portalContent?.props.onClick as
      | ((event: { stopPropagation: () => void }) => void)
      | undefined;
    onClick?.({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the player with custom controls instead of native ones", () => {
    render({ src: "blob:video", fileName: "clip.mp4", formatLabel: "MP4", sizeLabel: "2.2 MB" });
    const html = renderToStaticMarkup(portalContent as ReactElement);
    expect(html).toContain("video-lightbox-video");
    expect(html).not.toContain("controls=");
    expect(html).toContain('aria-label="Seek"');
    expect(html).toContain("MP4 · 2.2 MB");
  });

  it("shows a spinner and no controls while the source is loading", () => {
    render({ fileName: "clip.mp4" });
    const html = renderToStaticMarkup(portalContent as ReactElement);
    expect(html).toContain('aria-label="Loading video"');
    expect(html).not.toContain("video-lightbox-controls");
  });
});

describe("formatVideoTime", () => {
  it("formats minutes and hours", () => {
    expect(formatVideoTime(2.4)).toBe("0:02");
    expect(formatVideoTime(65)).toBe("1:05");
    expect(formatVideoTime(3729)).toBe("1:02:09");
    expect(formatVideoTime(Number.NaN)).toBe("0:00");
    expect(formatVideoTime(-1)).toBe("0:00");
  });
});

describe("resolveVideoShortcut", () => {
  it("maps player keys", () => {
    expect(resolveVideoShortcut(" ")).toEqual({ type: "toggle" });
    expect(resolveVideoShortcut("k")).toEqual({ type: "toggle" });
    expect(resolveVideoShortcut("ArrowLeft")).toEqual({ type: "seek", by: -5 });
    expect(resolveVideoShortcut("l")).toEqual({ type: "seek", by: 10 });
    expect(resolveVideoShortcut(".")).toEqual({ type: "frame", direction: 1 });
    expect(resolveVideoShortcut("5")).toEqual({ type: "seekFraction", value: 0.5 });
    expect(resolveVideoShortcut("End")).toEqual({ type: "seekFraction", value: 1 });
    expect(resolveVideoShortcut("m")).toEqual({ type: "mute" });
    expect(resolveVideoShortcut("f")).toEqual({ type: "fullscreen" });
    expect(resolveVideoShortcut("Escape")).toBeNull();
    expect(resolveVideoShortcut("x")).toBeNull();
  });
});

describe("nextPlaybackRate", () => {
  it("cycles through the speeds and recovers from unknown rates", () => {
    expect(nextPlaybackRate(1)).toBe(1.25);
    expect(nextPlaybackRate(2)).toBe(0.5);
    expect(nextPlaybackRate(0.5)).toBe(1);
    expect(nextPlaybackRate(3)).toBe(1);
  });
});
