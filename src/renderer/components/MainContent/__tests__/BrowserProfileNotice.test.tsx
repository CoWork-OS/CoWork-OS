import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProfileNotice } from "../BrowserProfileNotice";

afterEach(() => vi.unstubAllGlobals());
describe("browser profile notice isolation", () => {
  it.each([undefined, false])("renders nothing on desktop with browser flag %s", (flag) => {
    vi.stubGlobal("window", { coworkBrowserHost: flag });
    expect(
      renderToStaticMarkup(
        <BrowserProfileNotice notice="Approval prompts are off" onReview={() => {}} />,
      ),
    ).toBe("");
  });
  it("shows the explanation and action only in the browser preview", () => {
    vi.stubGlobal("window", { coworkBrowserHost: true });
    const markup = renderToStaticMarkup(
      <BrowserProfileNotice notice="Approval prompts are off" onReview={() => {}} />,
    );
    expect(markup).toContain('role="note"');
    expect(markup).toContain("Approval prompts are off");
    expect(markup).toContain("Review profiles");
  });
  it("does not show an empty browser notice", () => {
    vi.stubGlobal("window", { coworkBrowserHost: true });
    expect(renderToStaticMarkup(<BrowserProfileNotice notice={null} onReview={() => {}} />)).toBe(
      "",
    );
  });
});
