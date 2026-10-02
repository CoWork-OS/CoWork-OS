import { describe, expect, it, vi } from "vitest";
import { readBoundedResponse } from "../bounded-response";

describe("bounded decoded response reads", () => {
  it("rejects chunked or dishonest-length overflow and cancels the producer", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(4));
        },
        cancel,
      }),
      { headers: { "content-length": "1" } },
    );
    await expect(readBoundedResponse(response, 6, "test")).rejects.toThrow("6-byte limit");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("keeps UTF-8 intact across chunks and accepts exactly the limit", async () => {
    const bytes = Buffer.from("€ hello");
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes.subarray(0, 1));
          c.enqueue(bytes.subarray(1));
          c.close();
        },
      }),
    );
    expect(Buffer.from(await readBoundedResponse(response, bytes.length, "test")).toString()).toBe(
      "€ hello",
    );
  });
  it("aborts a stalled body after headers and cancels the producer", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const reading = readBoundedResponse(
      new Response(new ReadableStream({ cancel })),
      100,
      "test",
      controller.signal,
    );
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
