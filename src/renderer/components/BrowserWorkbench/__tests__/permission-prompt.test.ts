import { describe, expect, it } from "vitest";
import { livePermissionRequests } from "../PermissionPrompt";

describe("permission prompt list", () => {
  const prompt = (requestId: string, tabId = "t1") => ({
    requestId,
    tabId,
    origin: "https://a.example",
    permissions: ["camera"],
  });

  it("keeps only prompts the main process still waits on, for open tabs, not yet answered", () => {
    // "expired" timed out in the main process, so it is no longer in the pending list.
    const pending = [prompt("old-answered"), prompt("newer"), prompt("closed-tab", "gone")];
    const live = livePermissionRequests(pending, new Set(["old-answered"]), new Set(["t1"]));
    expect(live.map((request) => request.requestId)).toEqual(["newer"]);
  });
});
