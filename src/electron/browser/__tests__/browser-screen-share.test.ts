import { describe, expect, it, vi } from "vitest";
import { BrowserScreenShare, type BrowserScreenSharePrompt } from "../browser-screen-share";

function setup(options: { owned?: boolean; blocked?: boolean; sources?: number } = {}) {
  const prompts: BrowserScreenSharePrompt[] = [];
  const screen = { id: "screen:1:0", name: "Display", thumbnail: { toDataURL: () => "data:x" } };
  const window = { id: "window:7:0", name: "Editor", thumbnail: { toDataURL: () => "" } };
  const share = new BrowserScreenShare({
    resolveOwner: (id) =>
      options.owned === false || id !== 5 ? null : { taskId: "t", sessionId: "s", tabId: "a" },
    contentsForFrame: () => ({ id: 5, getURL: () => "https://meet.example/room" }),
    listSources: async () => [screen, window].slice(0, options.sources ?? 2),
    sendPrompt: (prompt) => {
      prompts.push(prompt);
      return true;
    },
    isBlocked: () => options.blocked === true,
  });
  const request = async () => {
    const callback = vi.fn();
    await share.handleRequest({ frame: {}, securityOrigin: "https://meet.example" }, callback);
    return callback;
  };
  return { share, prompts, request, screen };
}

describe("BrowserScreenShare", () => {
  it("shows the sources and shares only the one picked", async () => {
    const { share, prompts, request, screen } = setup();
    const callback = await request();
    expect(callback).not.toHaveBeenCalled();
    expect(prompts[0]).toMatchObject({ taskId: "t", tabId: "a", origin: "https://meet.example" });
    expect(prompts[0].sources.map((source) => [source.id, source.kind])).toEqual([
      ["screen:1:0", "screen"],
      ["window:7:0", "window"],
    ]);
    expect(share.listPending("t", "s")).toHaveLength(1);
    expect(share.respond(prompts[0].requestId, "screen:9:9")).toBe(true);
    expect(callback).toHaveBeenCalledWith({});

    const second = await request();
    share.respond(prompts[1].requestId, "screen:1:0");
    expect(second).toHaveBeenCalledWith({ video: screen });
    expect(share.respond(prompts[1].requestId, "screen:1:0")).toBe(false);
  });

  it("denies without a picker for other pages, policy blocks and no sources", async () => {
    for (const options of [{ owned: false }, { blocked: true }, { sources: 0 }]) {
      const { prompts, request } = setup(options);
      const callback = await request();
      expect(callback).toHaveBeenCalledWith({});
      expect(prompts).toEqual([]);
    }
  });
});
