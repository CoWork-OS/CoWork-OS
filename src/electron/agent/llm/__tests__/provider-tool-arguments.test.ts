import { describe, expect, it } from "vitest";
import { AzureOpenAIProvider } from "../azure-openai-provider";
import { OpenRouterProvider } from "../openrouter-provider";
import { XAIProvider } from "../xai-provider";
import { PiProvider } from "../pi-provider";
import type { LLMResponse } from "../types";

const calls = [
  { id: "bad", name: "write_file", arguments: '{"path":' },
  { id: "good", name: "read_file", arguments: '{"path":"source.txt"}' },
];

function assertMixedResult(response: LLMResponse) {
  expect(response.stopReason).toBe("tool_use");
  expect(response.content).toEqual([
    expect.objectContaining({
      type: "tool_use",
      id: "bad",
      input: {},
      inputError: { code: "malformed_json", message: expect.any(String) },
    }),
    { type: "tool_use", id: "good", name: "read_file", input: { path: "source.txt" } },
  ]);
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("provider-specific malformed argument boundaries", () => {
  it.each([
    ["Azure Responses", AzureOpenAIProvider, "fromResponsesApiResponse"],
    ["xAI Responses", XAIProvider, "convertResponsesResponse"],
  ])("preserves mixed calls in %s", (_name, Provider, method) => {
    const provider = Object.create(Provider.prototype) as Any;
    assertMixedResult(
      provider[method]({
        output: calls.map((call) => ({ ...call, call_id: call.id, type: "function_call" })),
      }),
    );
  });

  it("preserves mixed calls in OpenRouter chat responses", () => {
    const provider = Object.create(OpenRouterProvider.prototype) as Any;
    assertMixedResult(
      provider.convertResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: call })),
            },
          },
        ],
      }),
    );
  });

  it("preserves mixed calls and native argument objects in Pi responses", () => {
    const provider = Object.create(PiProvider.prototype) as Any;
    assertMixedResult(
      provider.convertPiAiResponse({
        stopReason: "toolUse",
        content: [
          { ...calls[0], type: "toolCall" },
          { ...calls[1], arguments: { path: "source.txt" }, type: "toolCall" },
        ],
      }),
    );
  });

  it("rejects truncated Azure chat arguments without dropping a valid streamed sibling", async () => {
    const provider = Object.create(AzureOpenAIProvider.prototype) as Any;
    const response = sse([
      {
        choices: [
          {
            delta: {
              tool_calls: calls.map((call, index) => ({
                index,
                id: call.id,
                type: "function",
                function: call,
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
    assertMixedResult(await provider.fromChatCompletionsStreamResponse(response, {}, Date.now()));
  });

  it("rejects truncated Azure Responses arguments without dropping a valid streamed sibling", async () => {
    const provider = Object.create(AzureOpenAIProvider.prototype) as Any;
    const response = sse(
      calls.map((call, output_index) => ({
        type: "response.output_item.done",
        output_index,
        item: { ...call, call_id: call.id, type: "function_call" },
      })),
    );
    assertMixedResult(await provider.fromResponsesStreamResponse(response, {}, Date.now()));
  });
});
