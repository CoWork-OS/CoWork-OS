import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProviderConfig, LLMRequest } from "../types";
import { BedrockProvider } from "../bedrock-provider";

// Keep provider initialization predictable; no profile creds needed

let capturedConverseInput: any = null;

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function (this: any) {
    this.send = vi.fn(async (command: any) => {
      capturedConverseInput = command?.input ?? null;
      return {
        output: {
          message: {
            content: [{ text: "ok" }],
          },
        },
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      };
    });
  }),
  ConverseCommand: vi.fn().mockImplementation(function (input: any) {
    return { input };
  }),
}));

const config: LLMProviderConfig = {
  type: "bedrock",
  model: "us.anthropic.claude-opus-4-6-v1",
  awsRegion: "us-east-1",
};

describe("BedrockProvider", () => {
  beforeEach(() => {
    capturedConverseInput = null;
    vi.clearAllMocks();
  });

  it("rewrites terminal synthetic assistant placeholder into a user message for Bedrock", async () => {
    const provider = new BedrockProvider(config);

    const request: LLMRequest = {
      model: config.model,
      maxTokens: 10,
      system: "system prompt",
      messages: [
        { role: "user", content: "start task" },
        {
          role: "assistant",
          content: [{ type: "text", text: "I understand. Let me continue." }],
        },
      ],
    };

    const response = await provider.createMessage(request);

    expect(response.content).toEqual([{ type: "text", text: "ok" }]);
    expect(capturedConverseInput).toBeDefined();
    expect(capturedConverseInput.messages).toHaveLength(1);
    expect(capturedConverseInput.messages[0]).toMatchObject({
      role: "user",
      content: expect.arrayContaining([
        { text: "start task" },
        { text: "I understand. Let me continue." },
      ]),
    });
  });

  it("does not rewrite terminal assistant messages that contain real assistant content", async () => {
    const provider = new BedrockProvider(config);

    const request: LLMRequest = {
      model: config.model,
      maxTokens: 10,
      system: "system prompt",
      messages: [
        { role: "user", content: "start task" },
        {
          role: "assistant",
          content: [{ type: "text", text: "I completed the step." }],
        },
      ],
    };

    await provider.createMessage(request);

    expect(capturedConverseInput).toBeDefined();
    expect(capturedConverseInput.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ text: "I completed the step." }],
    });
  });

  it("merges consecutive user turns and keeps valid tool_result blocks aligned", async () => {
    const provider = new BedrockProvider(config);

    const request: LLMRequest = {
      model: config.model,
      maxTokens: 10,
      system: "system prompt",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
        { role: "user", content: "<cowork_memory_recall>\ncontext\n</cowork_memory_recall>" },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: '{"ok":true}',
            },
          ],
        },
      ],
    };

    await provider.createMessage(request);

    expect(capturedConverseInput).toBeDefined();
    expect(capturedConverseInput.messages).toHaveLength(3);
    expect(capturedConverseInput.messages[1].role).toBe("user");
    expect(capturedConverseInput.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolResult: expect.objectContaining({ toolUseId: "tool_1", status: "success" }),
        }),
      ]),
    );
    expect(capturedConverseInput.messages[1].content.some((block: any) => !!block.text)).toBe(
      false,
    );
    expect(capturedConverseInput.messages[2].role).toBe("user");
    expect(capturedConverseInput.messages[2].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "<cowork_memory_recall>\ncontext\n</cowork_memory_recall>",
        }),
      ]),
    );
  });

  it("rewrites orphan tool_result blocks into text to keep transcript valid", async () => {
    const provider = new BedrockProvider(config);

    const request: LLMRequest = {
      model: config.model,
      maxTokens: 10,
      system: "system prompt",
      messages: [
        { role: "user", content: "start task" },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "missing_tool_use",
              content: '{"error":"orphan"}',
              is_error: true,
            },
          ],
        },
      ],
    };

    await provider.createMessage(request);

    expect(capturedConverseInput).toBeDefined();
    const lastContent = capturedConverseInput.messages[2].content;
    expect(lastContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "[Recovered prior tool output omitted to preserve valid tool-call sequencing.]",
        }),
      ]),
    );
    expect(lastContent.some((block: any) => !!block.toolResult)).toBe(false);
  });

  it("rewrites assistant tool_use blocks when next user turn does not provide immediate tool_result", async () => {
    const provider = new BedrockProvider(config);

    const request: LLMRequest = {
      model: config.model,
      maxTokens: 10,
      system: "system prompt",
      messages: [
        { role: "user", content: "start task" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_missing_result",
              name: "read_file",
              input: { path: "a.ts" },
            },
          ],
        },
        { role: "user", content: "no tool results here" },
      ],
    };

    await provider.createMessage(request);

    expect(capturedConverseInput).toBeDefined();
    const assistantContent = capturedConverseInput.messages[1].content;
    expect(assistantContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "[Recovered prior tool request omitted to preserve valid tool-call sequencing.]",
        }),
      ]),
    );
    expect(assistantContent.some((block: any) => !!block.toolUse)).toBe(false);
  });

  it("normalizes Bedrock model tokens by stripping date/version suffixes", () => {
    const provider = new BedrockProvider(config) as any;

    expect(provider.extractModelToken("anthropic.claude-haiku-4-5-20250514")).toBe(
      "claude-haiku-4-5",
    );
    expect(
      provider.extractModelToken(
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
      ),
    ).toBe("claude-3-5-sonnet");
  });

  it("prefers the matching inference profile family instead of the first available profile", async () => {
    const provider = new BedrockProvider(config) as any;

    provider.getClaudeInferenceProfiles = vi.fn().mockResolvedValue([
      {
        id: "us.anthropic.claude-3-sonnet-v1:0",
        type: "SYSTEM_DEFINED",
        modelArns: [
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
        ],
      },
      {
        id: "us.anthropic.claude-haiku-4-5-v1:0",
        type: "SYSTEM_DEFINED",
        modelArns: [
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20250514-v1:0",
        ],
      },
    ]);

    const resolved = await provider.resolveInferenceProfileFallback(
      "anthropic.claude-haiku-4-5-20250514",
    );

    expect(resolved).toBe("us.anthropic.claude-haiku-4-5-v1:0");
  });
});
