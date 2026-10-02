import { describe, expect, it } from "vitest";
import { createSelectionQuote, getSelectionReplySource } from "../selection-reply";

type Any = any; // oxlint-disable-line typescript-eslint(no-explicit-any)

function fakeSource(dataset: Record<string, string> = {}) {
  return { dataset, nodeType: 1 } as Any;
}

function fakeTextNode(source: Any) {
  return { nodeType: 3, parentElement: { closest: () => source } } as Any;
}

function fakeSelection(text: string, start: Any, end: Any, collapsed = false) {
  const range = { startContainer: start, endContainer: end, cloneRange: () => range };
  return {
    rangeCount: 1,
    isCollapsed: collapsed,
    toString: () => text,
    getRangeAt: () => range,
  } as Any;
}

const container = { contains: () => true } as Any;

describe("getSelectionReplySource", () => {
  it("returns the message both ends of the selection share", () => {
    const source = fakeSource({ replyEventId: "evt-1" });
    const selection = fakeSelection(
      "  the AWS pair appears in 6 files  ",
      fakeTextNode(source),
      fakeTextNode(source),
    );

    const found = getSelectionReplySource(selection, container);

    expect(found?.source).toBe(source);
    expect(found?.text).toBe("the AWS pair appears in 6 files");
  });

  it("ignores a selection spanning two messages", () => {
    const selection = fakeSelection("text", fakeTextNode(fakeSource()), fakeTextNode(fakeSource()));
    expect(getSelectionReplySource(selection, container)).toBeNull();
  });

  it("ignores empty, collapsed and out-of-feed selections", () => {
    const source = fakeSource();
    const node = fakeTextNode(source);
    expect(getSelectionReplySource(fakeSelection("   ", node, node), container)).toBeNull();
    expect(getSelectionReplySource(fakeSelection("x", node, node, true), container)).toBeNull();
    expect(
      getSelectionReplySource(fakeSelection("x", node, node), { contains: () => false } as Any),
    ).toBeNull();
  });
});

describe("createSelectionQuote", () => {
  it("carries the source message ids", () => {
    expect(
      createSelectionQuote("quoted", fakeSource({ replyEventId: "evt-1", replyTaskId: "task-1" })),
    ).toEqual({ eventId: "evt-1", taskId: "task-1", message: "quoted" });
  });

  it("truncates very long selections", () => {
    const quote = createSelectionQuote("a".repeat(2500), fakeSource());
    expect(quote.truncated).toBe(true);
    expect(quote.message.length).toBe(2000);
    expect(quote.message.endsWith("…")).toBe(true);
  });
});
