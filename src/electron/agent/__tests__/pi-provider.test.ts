/**
 * Tests for PiProvider: constructor validation, model resolution,
 * message conversion, and response conversion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const completeMock = vi.fn();
const getModelsMock = vi.fn(() => [
  {
    id: "claude-sonnet-4-5-20250514",
    name: "Claude Sonnet 4.5",
    reasoning: false,
    contextWindow: 200000,
  },
  { id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
]);
const getProvidersMock = vi.fn(() => ["anthropic", "openai"]);
const loadPiAiModuleMock = vi.fn();

vi.mock("../llm/pi-ai-loader", () => ({
  loadPiAiModule: (...args: Any[]) => loadPiAiModuleMock(...args),
}));

import { PiProvider } from "../llm/pi-provider";
import type { LLMProviderConfig, LLMMessage, LLMResponse } from "../llm/types";

function createConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    type: "pi",
    model: "claude-sonnet-4-5-20250514",
    piProvider: "anthropic",
    piApiKey: "test-key",
    ...overrides,
  };
}

// Access private methods for unit testing
function getPrivate(provider: PiProvider): Any {
  return provider as Any;
}

describe("PiProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPiAiModuleMock.mockResolvedValue({
      getModels: (...args: Any[]) => getModelsMock(...args),
      getProviders: (...args: Any[]) => getProvidersMock(...args),
      complete: (...args: Any[]) => completeMock(...args),
    });
  });

  describe("constructor validation", () => {
    it("should construct successfully with valid config", () => {
      const provider = new PiProvider(createConfig());
      expect(provider.type).toBe("pi");
    });

    it("should throw for unknown backend provider", () => {
      expect(() => new PiProvider(createConfig({ piProvider: "invalid-provider" }))).toThrow(
        /Unknown Pi backend provider: "invalid-provider"/,
      );
    });

    it("should throw when API key is missing", () => {
      expect(() => new PiProvider(createConfig({ piApiKey: "" }))).toThrow(
        /Pi provider requires an API key/,
      );
    });

    it("should throw when API key is undefined", () => {
      expect(() => new PiProvider(createConfig({ piApiKey: undefined }))).toThrow(
        /Pi provider requires an API key/,
      );
    });

    it("should default to anthropic when piProvider is not set", () => {
      const provider = new PiProvider(createConfig({ piProvider: undefined }));
      expect(getPrivate(provider).piProvider).toBe("anthropic");
    });
  });

  describe("resolveModel", () => {
    it("should return model on exact match", async () => {
      const provider = new PiProvider(createConfig());
      const model = await getPrivate(provider).resolveModel("claude-sonnet-4-5-20250514");
      expect(model.id).toBe("claude-sonnet-4-5-20250514");
    });

    it("should throw when model is not found (no partial matching)", async () => {
      const provider = new PiProvider(createConfig());
      await expect(getPrivate(provider).resolveModel("nonexistent-model")).rejects.toThrow(
        /Model "nonexistent-model" not found for provider anthropic/,
      );
    });

    it("should throw for partial model ID match (no fuzzy fallback)", async () => {
      const provider = new PiProvider(createConfig());
      await expect(getPrivate(provider).resolveModel("claude")).rejects.toThrow(
        /Model "claude" not found/,
      );
    });

    it("should list available models in error message", async () => {
      const provider = new PiProvider(createConfig());
      await expect(getPrivate(provider).resolveModel("missing")).rejects.toThrow(
        /claude-sonnet-4-5-20250514/,
      );
      await expect(getPrivate(provider).resolveModel("missing")).rejects.toThrow(/gpt-4o/);
    });
  });

  describe("convertMessagesToPiAi", () => {
    it("should convert a simple user string message", () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [{ role: "user", content: "Hello" }];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      expect(result[0].content).toEqual([{ type: "text", text: "Hello" }]);
    });

    it("should convert an assistant string message with placeholder usage", () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [{ role: "assistant", content: "Hi there" }];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("assistant");
      expect(result[0].content).toEqual([{ type: "text", text: "Hi there" }]);
      expect(result[0].usage.input).toBe(0);
      expect(result[0].usage.output).toBe(0);
      expect(result[0].usage.totalTokens).toBe(0);
    });

    it("should convert tool_use blocks and track tool names", () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "read_file",
              input: { path: "/tmp/test" },
            } as Any,
          ],
        },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("assistant");
      expect(result[0].content[0]).toEqual({
        type: "toolCall",
        id: "call-1",
        name: "read_file",
        arguments: { path: "/tmp/test" },
      });
    });

    it("should populate toolName on tool results from preceding tool calls", () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} } as Any],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "file contents" },
          ] as Any,
        },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      const toolResult = result.find((m: Any) => m.role === "toolResult");
      expect(toolResult).toBeDefined();
      expect(toolResult.toolName).toBe("read_file");
    });

    it("should handle tool results with no matching preceding tool call", () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "orphan-id", content: "data" }] as Any,
        },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      const toolResult = result.find((m: Any) => m.role === "toolResult");
      expect(toolResult.toolName).toBe("");
    });

    it("should convert user array content (text only)", () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Part 1" } as Any,
            { type: "text", text: "Part 2" } as Any,
          ],
        },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      expect(result[0].content).toHaveLength(2);
    });
  });

  describe("convertPiAiResponse", () => {
    it("should convert text response", () => {
      const provider = new PiProvider(createConfig());
      const piResponse = {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        stopReason: "stop",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        api: "openai-completions",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250514",
        timestamp: Date.now(),
      };

      const result: LLMResponse = getPrivate(provider).convertPiAiResponse(piResponse);
      expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(result.stopReason).toBe("end_turn");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("should convert tool call response", () => {
      const provider = new PiProvider(createConfig());
      const piResponse = {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { cmd: "ls" } }],
        stopReason: "toolUse",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        api: "openai-completions",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250514",
        timestamp: Date.now(),
      };

      const result: LLMResponse = getPrivate(provider).convertPiAiResponse(piResponse);
      expect(result.content).toEqual([
        { type: "tool_use", id: "tc-1", name: "bash", input: { cmd: "ls" } },
      ]);
      expect(result.stopReason).toBe("tool_use");
    });

    it("should preserve valid siblings when a tool call has malformed arguments", () => {
      const provider = new PiProvider(createConfig());
      const piResponse = {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc-bad", name: "write_file", arguments: "{" },
          {
            type: "toolCall",
            id: "tc-good",
            name: "read_file",
            arguments: { path: "src/app.ts" },
          },
          { type: "toolCall", id: "tc-array", name: "glob", arguments: "[]" },
          { type: "toolCall", id: "tc-null", name: "noop", arguments: null },
        ],
        stopReason: "toolUse",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        api: "openai-completions",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250514",
        timestamp: Date.now(),
      };

      const result: LLMResponse = getPrivate(provider).convertPiAiResponse(piResponse);
      expect(result.content).toEqual([
        {
          type: "tool_use",
          id: "tc-bad",
          name: "write_file",
          input: {},
          inputError: {
            code: "malformed_json",
            message: "Tool call arguments must be valid JSON.",
          },
        },
        {
          type: "tool_use",
          id: "tc-good",
          name: "read_file",
          input: { path: "src/app.ts" },
        },
        {
          type: "tool_use",
          id: "tc-array",
          name: "glob",
          input: {},
          inputError: {
            code: "invalid_shape",
            message: "Tool call arguments must be a JSON object.",
          },
        },
        {
          type: "tool_use",
          id: "tc-null",
          name: "noop",
          input: {},
          inputError: {
            code: "invalid_shape",
            message: "Tool call arguments must be a JSON object.",
          },
        },
      ]);
      expect(result.stopReason).toBe("tool_use");
    });

    it("should map length stop reason to max_tokens", () => {
      const provider = new PiProvider(createConfig());
      const piResponse = {
        role: "assistant",
        content: [{ type: "text", text: "Truncated" }],
        stopReason: "length",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        api: "openai-completions",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250514",
        timestamp: Date.now(),
      };

      const result: LLMResponse = getPrivate(provider).convertPiAiResponse(piResponse);
      expect(result.stopReason).toBe("max_tokens");
    });

    it("should skip thinking blocks", () => {
      const provider = new PiProvider(createConfig());
      const piResponse = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "Visible" },
        ],
        stopReason: "stop",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        api: "openai-completions",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250514",
        timestamp: Date.now(),
      };

      const result: LLMResponse = getPrivate(provider).convertPiAiResponse(piResponse);
      expect(result.content).toEqual([{ type: "text", text: "Visible" }]);
    });
  });
});
