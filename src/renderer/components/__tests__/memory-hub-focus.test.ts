import { afterEach, describe, expect, it } from "vitest";
import {
  requestBotMemoryContext,
  requestMemoryHubFocus,
  peekBotMemoryContext,
  peekMemoryHubFocusWorkspace,
  takeMemoryHubFocus,
} from "../memory/memory-hub-focus";
afterEach(() => {
  takeMemoryHubFocus();
});
describe("Memory Hub bot context navigation", () => {
  it("opens an exact workspace without inventing item or bot ownership", () => {
    requestBotMemoryContext(" ws-a ", "My private bot");
    expect(peekMemoryHubFocusWorkspace()).toBe("ws-a");
    expect(peekBotMemoryContext()).toEqual({ workspaceId: "ws-a", botName: "My private bot" });
    expect(takeMemoryHubFocus("ws-a")).toEqual({
      workspaceId: "ws-a",
      itemId: "",
      query: "",
      contextBotName: "My private bot",
    });
    expect(peekBotMemoryContext()).toBeNull();
  });
  it("does not apply a foreign workspace request and lets item navigation replace context navigation", () => {
    requestBotMemoryContext("ws-a", "A");
    expect(takeMemoryHubFocus("ws-b")).toBeNull();
    requestBotMemoryContext("ws-a", "A");
    requestMemoryHubFocus({ workspaceId: "ws-b", itemId: "item", query: "fact" });
    expect(peekBotMemoryContext()).toBeNull();
    expect(takeMemoryHubFocus("ws-b")?.itemId).toBe("item");
  });
});
