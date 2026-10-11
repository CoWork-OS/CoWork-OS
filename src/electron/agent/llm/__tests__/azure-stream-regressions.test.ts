import { describe, expect, it } from "vitest";
import { AzureOpenAIProvider } from "../azure-openai-provider";

function provider() {
  return Object.create(AzureOpenAIProvider.prototype) as Any;
}

function events(payloads: unknown[]) {
  return new Response(payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Azure stream failure boundaries", () => {
  it("does not expose a Responses function call from an incomplete response", () => {
    const result = provider().fromResponsesApiResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "function_call",
          call_id: "write",
          name: "write_file",
          arguments: '{"path":"file.txt"}',
        },
      ],
    });
    expect(result.stopReason).toBe("max_tokens");
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  });

  it("does not expose a filtered or incomplete function-call item", () => {
    const result = provider().fromResponsesApiResponse({
      status: "completed",
      output: [
        {
          type: "function_call",
          status: "incomplete",
          call_id: "write",
          name: "write_file",
          arguments: '{"path":"file.txt"}',
        },
      ],
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  });

  it("does not expose a function call alongside a Responses refusal", () => {
    const result = provider().fromResponsesApiResponse({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "cannot comply" }],
        },
        {
          type: "function_call",
          call_id: "write",
          name: "write_file",
          arguments: '{"path":"file.txt"}',
        },
      ],
    });
    expect(result.stopReason).toBe("refusal");
    expect(result.content.some((block: Any) => block.type === "tool_use")).toBe(false);
  });

  it("does not expose an in-progress function-call item at a terminal response", () => {
    const result = provider().fromResponsesApiResponse({
      status: "completed",
      output: [
        {
          type: "function_call",
          status: "in_progress",
          call_id: "write",
          name: "write_file",
          arguments: '{"path":"file.txt"}',
        },
      ],
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.content.some((block: Any) => block.type === "tool_use")).toBe(false);
  });

  it("keeps a completed Responses function call executable", () => {
    const result = provider().fromResponsesApiResponse({
      status: "completed",
      output: [
        {
          type: "function_call",
          status: "completed",
          call_id: "write",
          name: "write_file",
          arguments: '{"path":"file.txt"}',
        },
      ],
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "write",
        name: "write_file",
        input: { path: "file.txt" },
      },
    ]);
  });

  it("rejects a Chat Completions stream that only sends DONE", async () => {
    await expect(
      provider().fromChatCompletionsStreamResponse(
        new Response("data: [DONE]\n\n"),
        {},
        Date.now(),
      ),
    ).rejects.toThrow("without a terminal response");
  });

  it.each(["length", "content_filter"] as const)(
    "does not expose valid-argument tools for Chat finish_reason %s",
    async (finish_reason) => {
      const response = events([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "write",
                    function: { name: "write_file", arguments: '{"path":"file.txt"}' },
                  },
                ],
              },
              finish_reason,
            },
          ],
        },
      ]);
      const result = await provider().fromChatCompletionsStreamResponse(response, {}, Date.now());
      expect(result.stopReason).toBe(finish_reason === "length" ? "max_tokens" : "refusal");
      expect(result.content.some((block: Any) => block.type === "tool_use")).toBe(false);
    },
  );

  it.each([
    { type: "response.failed", response: { error: { message: "generation failed" } } },
    { type: "error", message: "generation failed" },
  ])("rejects a failed response after a complete partial tool call: $type", async (failure) => {
    const response = events([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "write",
          name: "write_file",
          arguments: '{"path":"file.txt","content":"partial"}',
        },
      },
      failure,
    ]);
    await expect(provider().fromResponsesStreamResponse(response, {}, Date.now())).rejects.toThrow(
      "generation failed",
    );
  });

  it("rejects a Chat Completions error after streamed text", async () => {
    const response = events([
      { choices: [{ delta: { content: "partial answer" }, finish_reason: null }] },
      { error: { message: "generation failed" } },
    ]);
    await expect(
      provider().fromChatCompletionsStreamResponse(response, {}, Date.now()),
    ).rejects.toThrow("generation failed");
  });

  it("does not consider output-item completion or DONE a completed Responses generation", async () => {
    const body =
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"write","name":"write_file","arguments":"{}"}}\n\ndata: [DONE]\n\n';
    await expect(
      provider().fromResponsesStreamResponse(new Response(body), {}, Date.now()),
    ).rejects.toThrow("without a terminal response");
  });

  it("keeps partial UTF-8 bytes isolated between concurrent provider streams", async () => {
    const encoder = new TextEncoder();
    let firstController!: ReadableStreamDefaultController<Uint8Array>;
    const first = new ReadableStream<Uint8Array>({
      start(controller) {
        firstController = controller;
      },
    });
    const firstEvents: string[] = [];
    const firstParse = provider().consumeSseEvents(new Response(first), (event: string) =>
      firstEvents.push(event),
    );
    firstController.enqueue(encoder.encode('data: {"text":"'));
    firstController.enqueue(new Uint8Array([0xe2, 0x82]));
    // Let stream A retain an incomplete Euro character before stream B reads.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondEvents: string[] = [];
    await provider().consumeSseEvents(events([{ text: "stream B" }]), (event: string) =>
      secondEvents.push(event),
    );
    firstController.enqueue(new Uint8Array([0xac]));
    firstController.enqueue(encoder.encode('"}\n\n'));
    firstController.close();
    await firstParse;
    expect(firstEvents).toEqual(['{"text":"€"}']);
    expect(secondEvents).toEqual(['{"text":"stream B"}']);
  });
});
