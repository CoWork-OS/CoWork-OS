import { describe, expect, it } from "vitest";
import {
  resolveGroupRoutingMode,
  shouldIngestUnroutedGroupMessage,
  shouldRouteGroupMessage,
  slackThreadId,
} from "../channels/group-routing";

describe("Slack and Discord group routing", () => {
  it("defaults to mention-only", () => {
    expect(resolveGroupRoutingMode(undefined)).toBe("mentionsOnly");
    expect(resolveGroupRoutingMode("everything")).toBe("mentionsOnly");
    expect(resolveGroupRoutingMode("all")).toBe("all");
  });

  it("routes by mode like Telegram", () => {
    const plain = { isMentioned: false, isCommand: false };
    const mention = { isMentioned: true, isCommand: false };
    const reply = { isMentioned: false, isReplyToBot: true, isCommand: false };
    const command = { isMentioned: false, isCommand: true };

    expect(shouldRouteGroupMessage("all", plain)).toBe(true);
    expect(shouldRouteGroupMessage("mentionsOnly", plain)).toBe(false);
    expect(shouldRouteGroupMessage("mentionsOnly", mention)).toBe(true);
    expect(shouldRouteGroupMessage("mentionsOnly", reply)).toBe(true);
    expect(shouldRouteGroupMessage("mentionsOnly", command)).toBe(false);
    expect(shouldRouteGroupMessage("mentionsOrCommands", command)).toBe(true);
    expect(shouldRouteGroupMessage("commandsOnly", mention)).toBe(false);
    expect(shouldRouteGroupMessage("commandsOnly", command)).toBe(true);
  });

  it("ingests unaddressed messages only when something downstream may use them", () => {
    const base = {
      inExistingThread: false,
      ambientMode: false,
      chatGateMode: "explicit_only" as const,
    };
    expect(shouldIngestUnroutedGroupMessage(base)).toBe(false);
    expect(shouldIngestUnroutedGroupMessage({ ...base, inExistingThread: true })).toBe(true);
    expect(shouldIngestUnroutedGroupMessage({ ...base, ambientMode: true })).toBe(true);
    expect(shouldIngestUnroutedGroupMessage({ ...base, chatGateMode: "candidate" })).toBe(true);
    expect(shouldIngestUnroutedGroupMessage({ ...base, chatGateMode: "ignore" })).toBe(false);
  });
});

describe("Slack thread identity", () => {
  it("uses thread_ts for replies in a thread", () => {
    expect(slackThreadId({ ts: "2.0", thread_ts: "1.0" }, false)).toBe("1.0");
    expect(slackThreadId({ ts: "2.0", thread_ts: "1.0" }, true)).toBe("1.0");
  });

  it("names a channel's top-level message as the thread the agent answers in", () => {
    expect(slackThreadId({ ts: "1.0" }, false)).toBe("1.0");
  });

  it("keeps a DM's top-level messages in one conversation", () => {
    expect(slackThreadId({ ts: "1.0" }, true)).toBeUndefined();
  });
});
