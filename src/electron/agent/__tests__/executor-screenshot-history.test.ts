import { describe, expect, it } from "vitest";

import { TaskExecutor } from "../executor";
import { OpenAIProvider } from "../llm/openai-provider";
import { toTextToolProtocolMessages } from "../llm/text-tool-protocol";
import type { LLMMessage, LLMToolResult } from "../llm/types";

const STEPS = 10;

function screenshotData(step: number): string {
  return `screenshot-${step}-base64`;
}

/** A computer-use history shaped like the one tool-batch-executor builds per step. */
function buildComputerUseHistory(steps: number): LLMMessage[] {
  const messages: LLMMessage[] = [{ role: "user", content: "Open the settings window." }];
  for (let step = 1; step <= steps; step += 1) {
    const companion = [
      {
        type: "text" as const,
        text: `Latest controlled-window screenshot after click. captureId=${step}.`,
      },
      { type: "image" as const, data: screenshotData(step), mimeType: "image/png" as const },
    ];
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `call-${step}`,
          name: "computer_click",
          input: { x: step, y: step },
        },
      ],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `call-${step}`,
          content: JSON.stringify({ ok: true, captureId: step }),
          companion_user_content: companion,
        },
      ],
    });
    messages.push({ role: "user", content: companion });
  }
  return messages;
}

function sanitizeForRuntime(messages: LLMMessage[]): LLMMessage[] {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  return executor.sanitizeConversationHistoryForRuntime(messages);
}

function imagesIn(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string") {
      found.push(record.data);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return found;
}

function oldScreenshots(): string[] {
  // Each step adds 3 messages; the 8 newest messages cover only the last 3 steps.
  return Array.from({ length: STEPS - 3 }, (_, index) => screenshotData(index + 1));
}

describe("conversation history screenshot compaction", () => {
  it("drops old screenshots nested in tool results from the stored history", () => {
    const sanitized = sanitizeForRuntime(buildComputerUseHistory(STEPS));
    const remaining = new Set(imagesIn(sanitized));

    for (const old of oldScreenshots()) {
      expect(remaining.has(old)).toBe(false);
    }
    expect(remaining.has(screenshotData(STEPS))).toBe(true);

    const oldToolResult = sanitized[2].content as LLMToolResult[];
    expect(oldToolResult[0].type).toBe("tool_result");
    expect(oldToolResult[0].tool_use_id).toBe("call-1");
    expect(oldToolResult[0].companion_user_content).toEqual([
      expect.objectContaining({ type: "text" }),
      {
        type: "text",
        text: "[Image attachment removed from conversation memory: image/png (~1KB)]",
      },
    ]);
  });

  it("sends only recent screenshots in the OpenAI request payload", () => {
    const sanitized = sanitizeForRuntime(buildComputerUseHistory(STEPS));
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.3-codex-spark",
      openaiAccessToken: "header.payload.signature",
      openaiRefreshToken: "refresh-token",
      openaiTokenExpiresAt: Date.now() + 60_000,
    }) as Any;

    const sent = new Set(imagesIn(provider.convertMessagesToPiAi(sanitized)));

    for (const old of oldScreenshots()) {
      expect(sent.has(old)).toBe(false);
    }
    expect(sent.has(screenshotData(STEPS))).toBe(true);
  });

  it("sends only recent screenshots in the text-tool protocol payload", () => {
    const sanitized = sanitizeForRuntime(buildComputerUseHistory(STEPS));

    const sent = new Set(imagesIn(toTextToolProtocolMessages(sanitized)));

    for (const old of oldScreenshots()) {
      expect(sent.has(old)).toBe(false);
    }
    expect(sent.has(screenshotData(STEPS))).toBe(true);
  });
});
