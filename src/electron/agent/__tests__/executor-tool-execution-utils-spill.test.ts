import { describe, expect, it, vi } from "vitest";

import {
  buildDuplicateToolResult,
  buildNormalizedToolResult,
  getToolFailureReason,
} from "../executor-tool-execution-utils";
import { omittedCharsNoticeRegExp, type ToolResultSpillSink } from "../tool-result-spill";

function memorySink() {
  const parts = new Map<string, string>();
  let next = 0;
  const sink: ToolResultSpillSink = {
    newHandle: () => `sp${(0xfeed00 + next++).toString(16).padStart(12, "0")}`,
    write: vi.fn((entries: ReadonlyMap<string, string>) => {
      for (const [handle, text] of entries) parts.set(handle, text);
      return true;
    }),
  };
  return { sink, parts };
}

const passthrough = (_toolName: string, resultText: string) => resultText;

/** The kept text, read at the marker's offset, joins the visible head and tail exactly. */
function expectSeamless(kept: string | undefined, clipped: string) {
  const match = Array.from(clipped.matchAll(omittedCharsNoticeRegExp()))[0];
  expect(match?.[2]).toBeDefined();
  expect(kept).toBeDefined();
  const head = clipped.slice(0, match!.index);
  const tail = clipped.slice(match!.index + match![0].length);
  const offset = Number(match![3]);
  const omitted = Number(match![1]);
  expect(kept!.slice(0, offset)).toBe(head);
  expect(kept!.slice(offset + omitted)).toBe(tail);
  return match![2]!;
}

describe("run_command output spill", () => {
  it("keeps the cleaned full stdout of a long successful run", () => {
    const { sink, parts } = memorySink();
    const stdout = `RUN v3\n${"\u001b[32m✓\u001b[0m src/ok.test.ts > passes\n".repeat(4_000)}Tests  4000 passed\n`;
    const result = { success: true, stdout, stderr: "", exitCode: 0, terminationReason: "normal" };

    const normalized = buildNormalizedToolResult({
      toolName: "run_command",
      toolUseId: "tool-1",
      result,
      rawResult: JSON.stringify(result),
      sanitizeToolResult: passthrough,
      getToolFailureReason,
      spill: sink,
    });
    const parsed = JSON.parse(normalized.toolResult.content);
    expect(normalized.toolResult.content.length).toBeLessThan(40_000);
    expect(parsed.stdout).toContain("Tests  4000 passed");
    const handle = expectSeamless([...parts.values()][0], parsed.stdout);
    expect(parts.get(handle)).not.toContain("\u001b[");
    expect(parts.get(handle)).toContain("Tests  4000 passed");
  });

  it("keeps the full stdout of a failed run behind the failure payload", () => {
    const { sink, parts } = memorySink();
    const stdout = `${"✓ src/ok.test.ts > passes\n".repeat(2_400)}FAIL src/x.test.ts > adds\n`;
    const result = {
      success: false,
      stdout,
      stderr: "AssertionError: expected 2 to be 3",
      exitCode: 1,
      terminationReason: "normal",
    };

    const normalized = buildNormalizedToolResult({
      toolName: "run_command",
      toolUseId: "tool-2",
      result,
      rawResult: JSON.stringify(result),
      sanitizeToolResult: passthrough,
      getToolFailureReason,
      includeRunCommandTerminationContext: true,
      spill: sink,
    });
    const parsed = JSON.parse(normalized.toolResult.content);
    expect(normalized.toolResult.is_error).toBe(true);
    expect(parsed.stderr).toBe("AssertionError: expected 2 to be 3");
    const handle = expectSeamless(stdout, parsed.stdout);
    expect(parts.get(handle)).toBe(stdout);
    // Only the payload that is sent keeps text: one write, for stdout.
    expect(sink.write).toHaveBeenCalledTimes(1);
  });

  it("spills other long results and never re-spills a tool_result_read page", () => {
    const { sink, parts } = memorySink();
    const body = "page text\n".repeat(6_000);
    const fetched = buildNormalizedToolResult({
      toolName: "web_fetch",
      toolUseId: "tool-3",
      result: { success: true },
      rawResult: body,
      sanitizeToolResult: passthrough,
      getToolFailureReason,
      spill: sink,
    });
    expect(fetched.toolResult.content).toContain("tool_result_read(handle=");
    expect([...parts.values()]).toContain(body);

    const page = buildNormalizedToolResult({
      toolName: "tool_result_read",
      toolUseId: "tool-4",
      result: { success: true },
      rawResult: body,
      sanitizeToolResult: passthrough,
      getToolFailureReason,
      spill: sink,
    });
    expect(page.toolResult.content).not.toContain("tool_result_read(handle=");
    expect(sink.write).toHaveBeenCalledTimes(1);
  });

  it("spills a long cached result served for a duplicate call", () => {
    const { sink } = memorySink();
    const cached = "cached line\n".repeat(6_000);
    const duplicate = buildDuplicateToolResult({
      toolName: "web_fetch",
      toolUseId: "tool-5",
      duplicateCheck: { reason: "Same call", cachedResult: cached },
      isIdempotentTool: () => true,
      suggestion: "",
      spill: sink,
    });
    expect(String(duplicate.toolResult.content)).toContain("tool_result_read(handle=");
  });
});
