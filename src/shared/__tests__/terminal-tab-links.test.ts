import { describe, expect, it } from "vitest";
import {
  parseTerminalTabHref,
  terminalTabHref,
  terminalTabMarkdownLink,
} from "../terminal-tab-links";

describe("terminal tab links", () => {
  it("round-trips agent process ids and shell tab ids", () => {
    expect(terminalTabHref("bg-1a2b3c4d")).toBe("#terminal/bg-1a2b3c4d");
    expect(parseTerminalTabHref("#terminal/bg-1a2b3c4d")).toBe("bg-1a2b3c4d");
    const shellTab = "tab:ws-1:tab-1760000000-ab12";
    expect(parseTerminalTabHref(terminalTabHref(shellTab))).toBe(shellTab);
    expect(parseTerminalTabHref(`#terminal/${shellTab}`)).toBe(shellTab);
  });

  it.each([
    undefined,
    "",
    "#terminal/",
    "#terminal/%E0%A4%A",
    "#terminal/../secrets",
    "#terminal/bg 1",
    "#terminals/bg-1",
    "https://example.com/#terminal/bg-1",
  ])("ignores hrefs that are not terminal tab links: %s", (href) => {
    expect(parseTerminalTabHref(href)).toBeNull();
  });

  it("writes a markdown link whose label cannot break out of the brackets", () => {
    expect(terminalTabMarkdownLink("dev server", "bg-00ff00ff")).toBe(
      "[dev server](#terminal/bg-00ff00ff)",
    );
    expect(terminalTabMarkdownLink("[x](y) \\", "bg-00ff00ff")).toBe(
      "[x(y)](#terminal/bg-00ff00ff)",
    );
    expect(terminalTabMarkdownLink("  ", "bg-00ff00ff")).toBe("[terminal](#terminal/bg-00ff00ff)");
  });
});
