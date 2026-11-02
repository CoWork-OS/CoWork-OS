import { describe, expect, it, vi } from "vitest";

import { truncateToolResult } from "../context-manager";
import {
  omittedCharsNotice,
  omittedCharsNoticeRegExp,
  type ToolResultSpillSink,
} from "../tool-result-spill";

const BUDGET = 40_000;

function memorySink(ok = true) {
  const parts = new Map<string, string>();
  let next = 0;
  const sink: ToolResultSpillSink = {
    newHandle: () => `sp${(0xabc000 + next++).toString(16).padStart(12, "0")}`,
    write: vi.fn((entries: ReadonlyMap<string, string>) => {
      if (!ok) return false;
      for (const [handle, text] of entries) parts.set(handle, text);
      return true;
    }),
  };
  return { sink, parts };
}

function logText(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `log line ${index} ${"=".repeat(40)}`).join(
    "\n",
  );
}

/** Head, notice and tail of a trimmed text; the notice's handle, offset and count. */
function splitAtNotice(trimmed: string) {
  const match = Array.from(trimmed.matchAll(omittedCharsNoticeRegExp()))[0];
  if (!match) throw new Error("no omission notice");
  const raw = match[0];
  const head = trimmed.slice(0, match.index);
  const tail = trimmed.slice(match.index + raw.length);
  return {
    head,
    tail,
    omitted: Number(match[1]),
    handle: match[2],
    offset: match[3] === undefined ? undefined : Number(match[3]),
  };
}

/** The omitted text, read from the kept full text, joins head and tail exactly. */
function expectSeamless(full: string, trimmed: string) {
  const { head, tail, omitted, offset } = splitAtNotice(trimmed);
  expect(offset).toBeDefined();
  expect(full.slice(0, offset)).toBe(head);
  expect(full.slice(offset! + omitted)).toBe(tail);
}

describe("truncateToolResult with a spill sink", () => {
  it("keeps a plain-text result whole and points the marker at the omitted middle", () => {
    const { sink, parts } = memorySink();
    const text = logText(3_000);
    const trimmed = truncateToolResult(text, { spill: sink });

    expect(trimmed.length).toBeLessThanOrEqual(BUDGET);
    const { handle } = splitAtNotice(trimmed);
    expect(handle).toBeDefined();
    expect(parts.get(handle!)).toBe(text);
    expectSeamless(text, trimmed);
    expect(trimmed).toContain(`tool_result_read(handle="${handle}"`);
  });

  it("keeps each shortened JSON field under its own part handle", () => {
    const { sink, parts } = memorySink();
    const stdout = logText(2_500);
    const result = JSON.stringify({ exitCode: 1, command: "npm test", stdout });
    const trimmed = truncateToolResult(result, { spill: sink });

    expect(trimmed.length).toBeLessThanOrEqual(BUDGET);
    const parsed = JSON.parse(trimmed);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.command).toBe("npm test");
    const { handle } = splitAtNotice(parsed.stdout);
    expect(handle).toMatch(/^sp[0-9a-f]{12}\.\d+$/);
    expect(parts.get(handle!)).toBe(stdout);
    expectSeamless(stdout, parsed.stdout);
    expect(parsed._truncated).toContain("tool_result_read");
    expect(sink.write).toHaveBeenCalledTimes(1);
  });

  it("keeps dropped array items and says how to read them", () => {
    const { sink, parts } = memorySink();
    const items = Array.from({ length: 200 }, (_, index) => ({ id: index, text: "x".repeat(300) }));
    const trimmed = truncateToolResult(JSON.stringify(items), { spill: sink });

    expect(trimmed.length).toBeLessThanOrEqual(BUDGET);
    const parsed = JSON.parse(trimmed) as unknown[];
    const notice = String(parsed[parsed.length - 1]);
    const match =
      /^\[\.\.\. (\d+) more items omitted.*handle="([^"]+)", offset=0\) to read them/.exec(notice);
    expect(match).not.toBeNull();
    const kept = parts
      .get(match![2]!)!
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(kept).toHaveLength(Number(match![1]));
    expect(kept[0]).toEqual(items[parsed.length - 1]);
    expect(kept[kept.length - 1]).toEqual(items[items.length - 1]);
  });

  it("falls back to plain markers when the text could not be kept", () => {
    const { sink } = memorySink(false);
    const plain = truncateToolResult(logText(3_000), { spill: sink });
    expect(plain).not.toContain("tool_result_read");
    expect(splitAtNotice(plain).handle).toBeUndefined();

    const json = truncateToolResult(JSON.stringify({ stdout: logText(2_500) }), { spill: sink });
    expect(json).not.toContain("tool_result_read");
    expect(JSON.parse(json).stdout).toContain(" chars omitted ...]");
  });

  it("leaves results without a sink exactly as before", () => {
    const text = logText(3_000);
    const trimmed = truncateToolResult(text);
    expect(trimmed).not.toContain("tool_result_read");
    expect(trimmed).toBe(truncateToolResult(text, {}));
  });

  it("does not spill read_file windows, which say where to continue themselves", () => {
    const { sink } = memorySink();
    const content = logText(8_000);
    const result = JSON.stringify({
      content,
      size: content.length,
      truncated: false,
      path: "src/big.log",
      window: { start: 0, end: content.length, total: content.length },
    });
    const trimmed = JSON.parse(truncateToolResult(result, { spill: sink }));
    expect(trimmed.nextStartChar).toBeGreaterThan(0);
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("keeps an earlier handle reachable when compaction trims the result again", () => {
    const full = logText(4_000);
    const handle = "sp000000abc123";
    const headEnd = full.lastIndexOf("\n", 30_000) + 1;
    const tailStart = full.indexOf("\n", full.length - 30_000) + 1;
    const once =
      `${full.slice(0, headEnd)}\n` +
      omittedCharsNotice(tailStart - headEnd, { handle, offset: headEnd }) +
      `\n${full.slice(tailStart)}`;
    expect(once.length).toBeGreaterThan(BUDGET);
    expectSeamless(full, once);

    const twice = truncateToolResult(once);
    expect(twice.length).toBeLessThanOrEqual(BUDGET);
    expect(splitAtNotice(twice).handle).toBe(handle);
    expectSeamless(full, twice);
  });
});
