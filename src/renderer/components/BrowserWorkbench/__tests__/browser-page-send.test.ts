import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROWSER_PAGE_SEND, buildBrowserAskMessage } from "../browser-page-send";

const viewSource = readFileSync(
  fileURLToPath(new URL("../../BrowserWorkbenchView.tsx", import.meta.url)),
  "utf8",
);
const appSource = readFileSync(fileURLToPath(new URL("../../../App.tsx", import.meta.url)), "utf8");

describe("browser page sends", () => {
  it("sends page text verbatim with the browser_page origin", () => {
    expect(BROWSER_PAGE_SEND).toEqual({ verbatim: true, surfaceOrigin: "browser_page" });
    expect(buildBrowserAskMessage("Line one\nLine two", "https://example.com/a")).toBe(
      "About this text from https://example.com/a:\n\n> Line one\n> Line two\n\nExplain this and tell me what matters here.",
    );
    expect(buildBrowserAskMessage("Hi", "")).toContain("About this text from the page:");
  });

  it("tags every send that carries page content", () => {
    const ask = viewSource.match(/action\.kind === "ask"\) \{[\s\S]*?\} else if/)?.[0];
    expect(ask).toContain("buildBrowserAskMessage(action.text, action.url)");
    expect(ask).toContain("BROWSER_PAGE_SEND");

    const youtube = viewSource.match(
      /const sendYouTubeAnswerToChat = useCallback\([\s\S]*?\}, \[onSendMessage, youtubeAskResult\]\);/,
    )?.[0];
    expect(youtube).toContain("BROWSER_PAGE_SEND");

    expect(viewSource).toContain(
      "(message) => void onSendMessage(message, undefined, BROWSER_PAGE_SEND)",
    );
    expect(viewSource).toContain("typedNote ? undefined : BROWSER_PAGE_SEND");
    expect(viewSource).toContain("changeList ? BROWSER_PAGE_SEND : undefined");
  });

  it("forwards the send options from the browser view to the task", () => {
    const send = appSource.match(
      /const sendSpreadsheetFullscreenMessage = useCallback\([\s\S]*?\[onSendMessage\],/,
    )?.[0];
    expect(send).toContain("await onSendMessage(message, images, undefined, options);");
  });
});
