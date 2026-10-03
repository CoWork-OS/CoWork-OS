import { describe, expect, it } from "vitest";
import {
  attributeMemoryUse,
  countMemoryUsedRefs,
  parseMemoryUsedRef,
  MEMORY_USED_MAX_REFS,
} from "../memory-used";

const used = (timestamp: number, surface: string, refs: unknown[]) => ({
  id: `mu-${timestamp}`,
  type: "memory_used",
  timestamp,
  payload: { surface, refs },
});
const reply = (id: string, timestamp: number, type = "assistant_message") => ({
  id,
  type,
  timestamp,
  payload: {},
});
const user = (timestamp: number) => ({ id: `u-${timestamp}`, type: "user_message", timestamp });

describe("memory used attribution", () => {
  it("gives each reply the memory used since the previous reply or user message", () => {
    const result = attributeMemoryUse("t", [
      user(1),
      used(2, "pinned_profile", ["memory:a", "memory:b"]),
      used(3, "step", ["memory:b", "archive:c"]),
      reply("r1", 4),
      used(5, "step", ["external:supermemory"]),
      reply("r2", 6, "task_completed"),
      reply("r3", 7),
    ]);
    expect(result.replies).toEqual({
      r1: {
        eventId: "r1",
        refs: ["memory:a", "memory:b", "archive:c"],
        surfaces: ["pinned_profile", "step"],
      },
      r2: { eventId: "r2", refs: ["external:supermemory"], surfaces: ["step"] },
    });
    expect(result.replyEventIds).toEqual(["r1", "r2", "r3"]);
  });

  it("drops memory of a turn that ended without a reply and orders by time", () => {
    const result = attributeMemoryUse("t", [
      reply("r2", 6),
      used(5, "chat", ["memory:new"]),
      used(2, "chat", ["memory:old"]),
      user(3),
    ]);
    expect(result.replies.r2.refs).toEqual(["memory:new"]);
  });

  it("ignores malformed refs and caps the list", () => {
    const many = Array.from({ length: MEMORY_USED_MAX_REFS + 20 }, (_, i) => `memory:m${i}`);
    const result = attributeMemoryUse("t", [
      used(1, "chat", [42, "nope", "memory:", ...many]),
      { type: "memory_used", timestamp: 2, payload: "garbage" },
      reply("r", 3),
    ]);
    expect(result.replies.r.refs).toHaveLength(MEMORY_USED_MAX_REFS);
    expect(result.replies.r.refs[0]).toBe("memory:m0");
  });

  it("parses and counts refs by lane", () => {
    expect(parseMemoryUsedRef("archive:123")).toEqual({
      ref: "archive:123",
      lane: "archive",
      id: "123",
    });
    expect(parseMemoryUsedRef("event:1")).toBeNull();
    expect(countMemoryUsedRefs(["memory:a", "memory:b", "external:x", "bad"])).toEqual({
      memory: 2,
      archive: 0,
      external: 1,
    });
  });
});
