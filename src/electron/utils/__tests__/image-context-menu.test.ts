import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ Menu: { buildFromTemplate: vi.fn() } }));

import { buildImageContextMenuTemplate } from "../image-context-menu";

const makeContents = () => ({ copyImageAt: vi.fn(), downloadURL: vi.fn() });
const imageParams = (srcURL: string) => ({
  mediaType: "image" as const,
  hasImageContents: true,
  srcURL,
  x: 12,
  y: 34,
});

describe("buildImageContextMenuTemplate", () => {
  it("returns nothing when the click is not on an image", () => {
    const template = buildImageContextMenuTemplate(
      makeContents(),
      { ...imageParams(""), mediaType: "none" },
      { writeText: vi.fn() },
    );
    expect(template).toEqual([]);
  });

  it("copies the image at the clicked point", () => {
    const contents = makeContents();
    const template = buildImageContextMenuTemplate(
      contents,
      imageParams("data:image/png;base64,AAAA"),
      { writeText: vi.fn() },
    );
    const copy = template.find((item) => item.label === "Copy Image");
    copy?.click?.({} as never, undefined, {} as never);
    expect(contents.copyImageAt).toHaveBeenCalledWith(12, 34);
  });

  it("omits the address item for inline data URLs", () => {
    const template = buildImageContextMenuTemplate(
      makeContents(),
      imageParams("data:image/png;base64,AAAA"),
      { writeText: vi.fn() },
    );
    expect(template.map((item) => item.label)).not.toContain("Copy Image Address");
    expect(template.map((item) => item.label)).toContain("Save Image As…");
  });

  it("offers the address for http and file images", () => {
    const writeText = vi.fn();
    const template = buildImageContextMenuTemplate(
      makeContents(),
      imageParams("https://example.com/a.png"),
      { writeText },
    );
    const address = template.find((item) => item.label === "Copy Image Address");
    address?.click?.({} as never, undefined, {} as never);
    expect(writeText).toHaveBeenCalledWith("https://example.com/a.png");
  });
});
