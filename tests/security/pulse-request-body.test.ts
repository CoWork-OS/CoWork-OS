import { describe, expect, it, vi } from "vitest";
import worker, { readJson } from "../../services/pulse-worker/src/index";

function streamed(chunks: Uint8Array[], headers?: Record<string, string>) {
  const cancel = vi.fn();
  let consumed = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[consumed++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const request = new Request("https://pulse.example/v1/installations", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, cancel, consumed: () => consumed };
}

describe("Pulse streamed request limit", () => {
  it.each([undefined, { "content-length": "1" }])(
    "cancels an oversized stream with headers %s",
    async (headers) => {
      const fixture = streamed(
        [new Uint8Array(16384), new Uint8Array(1), new Uint8Array(100000)],
        headers,
      );
      const response = await worker.fetch(fixture.request, {} as never);
      expect(response.status).toBe(413);
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.consumed()).toBe(2);
    },
  );
  it("preserves valid Unicode split across chunks at the byte boundary", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ value: "é".repeat(8186) }));
    expect(bytes.length).toBe(16384);
    expect(await readJson(streamed([bytes.slice(0, 12), bytes.slice(12)]).request)).toEqual({
      value: "é".repeat(8186),
    });
  });
  it("rejects an oversized multibyte body", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ value: "é".repeat(8187) }));
    await expect(readJson(streamed([bytes]).request)).rejects.toThrow("body_too_large");
  });
  it("preserves JSON object validation", async () => {
    await expect(
      readJson(new Request("https://pulse.example", { method: "POST", body: "[]" })),
    ).rejects.toThrow("invalid_json_object");
  });
});
