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

const { ImageLightbox, resolveFocusTrapIndex } = await import("../ImageLightbox");

describe("ImageLightbox", () => {
  it("closes on a backdrop click without letting it reach the surrounding link", () => {
    const onClose = vi.fn();
    vi.stubGlobal("document", { body: {} });
    try {
      renderToStaticMarkup(
        createElement(ImageLightbox, { src: "data:image/png;base64,", onClose }),
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(portalContent?.props.role).toBe("dialog");
    expect(portalContent?.props.tabIndex).toBe(-1);
    const stopPropagation = vi.fn();
    const onClick = portalContent?.props.onClick as
      | ((event: { stopPropagation: () => void }) => void)
      | undefined;
    onClick?.({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab focus between the first and last controls", () => {
    expect(resolveFocusTrapIndex(4, 3, false)).toBe(0);
    expect(resolveFocusTrapIndex(4, 0, true)).toBe(3);
    expect(resolveFocusTrapIndex(4, -1, false)).toBe(0);
    expect(resolveFocusTrapIndex(4, -1, true)).toBe(3);
    expect(resolveFocusTrapIndex(4, 1, false)).toBeNull();
    expect(resolveFocusTrapIndex(4, 2, true)).toBeNull();
    expect(resolveFocusTrapIndex(0, -1, false)).toBeNull();
  });
});
