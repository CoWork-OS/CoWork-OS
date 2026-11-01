import { describe, expect, it, vi } from "vitest";

import {
  buildSpillHandleIndex,
  extractSpillReferences,
  isSpillHandle,
  LazyFieldSpill,
  omittedCharsNotice,
  omittedCharsNoticeRegExp,
  omittedItemsNotice,
  SPILL_HANDLE_INDEX_HEADER,
  stripSpillClauses,
  stripSpillHandleIndex,
  type ToolResultSpillSink,
} from "../tool-result-spill";

function memorySink(ok = true) {
  const parts = new Map<string, string>();
  let next = 0;
  const sink: ToolResultSpillSink = {
    newHandle: () => `sp${String(next++).padStart(12, "0")}`,
    write: vi.fn((entries: ReadonlyMap<string, string>) => {
      if (!ok) return false;
      for (const [handle, text] of entries) parts.set(handle, text);
      return true;
    }),
  };
  return { sink, parts };
}

describe("spill marker format", () => {
  it("names the handle and offset in the omission marker", () => {
    expect(omittedCharsNotice(120)).toBe("[... 120 chars omitted ...]");
    expect(omittedCharsNotice(120, { handle: "sp0123456789ab", offset: 40 })).toBe(
      '[... 120 chars omitted; call tool_result_read(handle="sp0123456789ab", offset=40) to continue ...]',
    );
    expect(omittedItemsNotice(3, "sp0123456789ab.4")).toBe(
      '[... 3 more items omitted to fit the tool-result budget; call tool_result_read(handle="sp0123456789ab.4", offset=0) to read them ...]',
    );
  });

  it("matches both notice forms and reads their handle and offset", () => {
    const text = `a\n${omittedCharsNotice(5)}\nb\n${omittedCharsNotice(9, { handle: "sp0123456789ab.2", offset: 7 })}\nc`;
    const matches = Array.from(text.matchAll(omittedCharsNoticeRegExp()));
    expect(matches.map((match) => [match[1], match[2], match[3]])).toEqual([
      ["5", undefined, undefined],
      ["9", "sp0123456789ab.2", "7"],
    ]);
  });

  it("validates handles strictly", () => {
    expect(isSpillHandle("sp0123456789ab")).toBe(true);
    expect(isSpillHandle("sp0123456789ab.12")).toBe(true);
    expect(isSpillHandle("../etc/passwd")).toBe(false);
    expect(isSpillHandle("sp0123456789ab/../x")).toBe(false);
    expect(isSpillHandle("SP0123456789AB")).toBe(false);
  });

  it("strips read hints, all of them or one handle's", () => {
    const one = omittedCharsNotice(5, { handle: "sp0123456789ab.0", offset: 1 });
    const two = omittedCharsNotice(6, { handle: "sp0123456789ab.1", offset: 2 });
    expect(stripSpillClauses(`${one} ${two}`)).toBe(
      `${omittedCharsNotice(5)} ${omittedCharsNotice(6)}`,
    );
    expect(stripSpillClauses(`${one} ${two}`, "sp0123456789ab.1")).toBe(
      `${one} ${omittedCharsNotice(6)}`,
    );
  });

  it("finds references in plain text and inside serialized JSON", () => {
    const notice = omittedCharsNotice(50, { handle: "sp0123456789ab.3", offset: 12 });
    expect(extractSpillReferences(notice)).toEqual([{ handle: "sp0123456789ab.3", offset: 12 }]);
    expect(extractSpillReferences(JSON.stringify({ stdout: `head\n${notice}\ntail` }))).toEqual([
      { handle: "sp0123456789ab.3", offset: 12 },
    ]);
    expect(extractSpillReferences("no references here")).toEqual([]);
  });
});

describe("compaction handle index", () => {
  it("keeps the newest handles once each and can be stripped again", () => {
    const index = buildSpillHandleIndex(
      [
        { handle: "sp000000000001", offset: 1, toolName: "run_command" },
        { handle: "sp000000000002", offset: 2, toolName: "web_fetch" },
        { handle: "sp000000000001", offset: 3, toolName: "run_command" },
        { handle: "not-a-handle", offset: 0 },
      ],
      2,
    );
    expect(index.split("\n")).toEqual([
      SPILL_HANDLE_INDEX_HEADER,
      '- tool_result_read(handle="sp000000000002", offset=2) (web_fetch)',
      '- tool_result_read(handle="sp000000000001", offset=3) (run_command)',
    ]);
    expect(buildSpillHandleIndex([])).toBe("");
    expect(stripSpillHandleIndex(`Preamble.\n\n${index}\n\nSummary body.`)).toBe(
      "Preamble.\n\nSummary body.",
    );
  });
});

describe("LazyFieldSpill", () => {
  it("writes each field once, under its own part handle", () => {
    const { sink, parts } = memorySink();
    const spill = new LazyFieldSpill(sink);
    const stdout = spill.handleFor("stdout", "full stdout");
    expect(spill.handleFor("stdout", "full stdout")).toBe(stdout);
    const stderr = spill.handleFor("stderr", "full stderr");
    expect(stdout).toBe("sp000000000000");
    expect(stderr).toBe("sp000000000001");
    expect(sink.write).toHaveBeenCalledTimes(2);
    expect(parts.get(stdout!)).toBe("full stdout");
  });

  it("returns no handle when the text could not be kept", () => {
    const { sink } = memorySink(false);
    const spill = new LazyFieldSpill(sink);
    expect(spill.handleFor("stdout", "x")).toBeUndefined();
    expect(spill.handleFor("stdout", "x")).toBeUndefined();
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(new LazyFieldSpill(undefined).handleFor("stdout", "x")).toBeUndefined();
  });
});
