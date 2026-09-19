import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeResponseToolMetadata } from "../response-tool-metadata";
import { fromOpenAICompatibleResponse } from "../openai-compatible";
import type { LLMResponse, LLMToolUse } from "../types";
import { OpenAIProvider } from "../openai-provider";
import { LLMProviderFactory } from "../provider-factory";
import { ToolScheduler } from "../../runtime/ToolScheduler";

afterEach(() => vi.restoreAllMocks());

function tool(id: unknown, name: unknown = "read_file"): LLMToolUse {
  return { type: "tool_use", id, name, input: { path: "x" } } as LLMToolUse;
}

describe("provider tool metadata boundary", () => {
  it.each([undefined, null, [], 1, "{}"])("rejects non-object native arguments", (input) => {
    const result = normalizeResponseToolMetadata({
      content: [{ ...tool("call"), input } as LLMToolUse],
      stopReason: "tool_use",
    });
    expect(result.content[0]).toMatchObject({
      id: "call",
      input: {},
      inputError: { code: "invalid_shape" },
    });
  });
  it.each([undefined, null, {}, { content: {} }, { content: [null] }])(
    "rejects malformed response envelopes before dispatch",
    (response) => {
      expect(() => normalizeResponseToolMetadata(response as LLMResponse)).toThrow(
        "Invalid provider response",
      );
    },
  );
  it.each([false, true])(
    "rejects malformed calls before dispatch through the factory (token-cap retry=%s)",
    async (retry) => {
      const createMessage = vi.spyOn(OpenAIProvider.prototype, "createMessage");
      if (retry)
        createMessage.mockRejectedValueOnce(new Error("max_tokens must be lower than 1000"));
      createMessage.mockResolvedValue({
        content: [tool(undefined, "write_file"), tool("valid")],
        stopReason: "tool_use",
      });
      const provider = LLMProviderFactory.createProviderFromConfig({
        type: "openai",
        model: retry ? "metadata-retry-fixture" : "metadata-fixture",
        openaiApiKey: "fixture-key",
      });
      const response = await provider.createMessage({
        model: retry ? "metadata-retry-fixture" : "metadata-fixture",
        maxTokens: 2000,
        messages: [{ role: "user", content: "fixture" }],
        system: "fixture",
      });
      const prepareCall = vi.fn(async (call) => ({
        status: "scheduled" as const,
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: { concurrencyClass: "read_parallel" as const, readOnly: true, idempotent: true },
          run: async () => ({ resultJson: "ok" }),
          finalize: async () => ({
            toolResult: {
              type: "tool_result" as const,
              tool_use_id: call.toolUse.id,
              content: "ok",
            },
          }),
        },
      }));
      const outcome = await new ToolScheduler().executeBatch({
        calls: (response.content as LLMToolUse[]).map((toolUse, index) => ({ toolUse, index })),
        prepareCall,
      });
      expect(createMessage).toHaveBeenCalledTimes(retry ? 2 : 1);
      expect(prepareCall).toHaveBeenCalledTimes(1);
      expect(prepareCall.mock.calls[0][0].toolUse.id).toBe("valid");
      expect(outcome.toolResults).toHaveLength(2);
      expect(outcome.toolResults[0]).toMatchObject({
        tool_use_id: (response.content[0] as LLMToolUse).id,
        is_error: true,
      });
      expect(outcome.toolResults[1]).toMatchObject({ tool_use_id: "valid", content: "ok" });
    },
  );
  it.each([undefined, null, "", "  ", 7])(
    "rejects invalid ID %s without dropping valid siblings",
    (id) => {
      const valid = tool("valid");
      const response: LLMResponse = { content: [tool(id), valid], stopReason: "tool_use" };
      const result = normalizeResponseToolMetadata(response);
      const rejected = result.content[0] as LLMToolUse;
      expect(rejected.id).toMatch(/^rejected_/);
      expect(rejected.inputError?.code).toBe("invalid_shape");
      expect(result.content[1]).toBe(valid);
      expect((response.content[0] as LLMToolUse).id).toBe(id);
      expect(normalizeResponseToolMetadata(result)).toBe(result);
    },
  );

  it.each([undefined, null, "", "  ", 7])(
    "rejects invalid name %s with correlated metadata",
    (name) => {
      const result = normalizeResponseToolMetadata({
        content: [{ ...tool("call"), name } as LLMToolUse],
        stopReason: "tool_use",
      });
      expect(result.content[0]).toMatchObject({
        id: "call",
        name: "invalid_tool_call",
        inputError: { code: "invalid_shape" },
      });
    },
  );

  it("rejects all duplicate IDs so ambiguous sibling calls cannot execute twice", () => {
    const result = normalizeResponseToolMetadata({
      content: [tool("same"), tool("same"), tool("other")],
      stopReason: "tool_use",
    });
    const calls = result.content as LLMToolUse[];
    expect(new Set(calls.map((call) => call.id)).size).toBe(3);
    expect(calls[0].inputError).toBeDefined();
    expect(calls[1].inputError).toBeDefined();
    expect(calls[2].inputError).toBeUndefined();
  });

  it("retains missing function metadata from compatible responses as a rejection", () => {
    const converted = fromOpenAICompatibleResponse({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              { type: "function", id: "missing-function" },
              { type: "function", id: "valid", function: { name: "read_file", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    const calls = normalizeResponseToolMetadata(converted).content as LLMToolUse[];
    expect(calls).toHaveLength(2);
    expect(calls[0].inputError).toBeDefined();
    expect(calls[1]).toMatchObject({ id: "valid", name: "read_file", input: {} });
    expect(calls[1].inputError).toBeUndefined();
  });
});
