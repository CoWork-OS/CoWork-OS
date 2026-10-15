import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../anthropic-provider";
import { AnthropicCompatibleProvider } from "../anthropic-compatible-provider";
import { AzureAnthropicProvider } from "../azure-anthropic-provider";
import type { LLMMessage, LLMProvider, LLMRequest } from "../types";
import { appendAssistantResponseToConversation } from "../../executor-loop-utils";
import { assertNormalizedTurnTranscript } from "../../runtime/turn-transcript-normalizer";
import { ANTHROPIC_TURN_CONTEXT_BETA } from "../anthropic-turn-context";

let baseURL: string;
let server: Server;
let rejectControls = false;
let rejectTurnContext = false;
const bodies: Any[] = [];
const headers: Any[] = [];
const responseContents: Any[][] = [];

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const { default: SDK } = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  return {
    default: class FixtureAnthropic extends SDK {
      constructor(options: Any) {
        super({ ...options, baseURL, maxRetries: 0 });
      }
    },
  };
});

const routes = [
  "Claude API",
  "Claude subscription token",
  "Azure Anthropic",
  "Anthropic-compatible",
] as const;
function provider(route: (typeof routes)[number]): LLMProvider {
  if (route === "Azure Anthropic")
    return new AzureAnthropicProvider({
      type: "azure-anthropic",
      model: "claude-sonnet-4-6",
      azureAnthropicApiKey: "fixture-key",
      azureAnthropicEndpoint: baseURL,
    });
  if (route === "Anthropic-compatible")
    return new AnthropicCompatibleProvider({
      type: "anthropic-compatible",
      providerName: route,
      apiKey: "fixture-key",
      baseUrl: baseURL,
      defaultModel: "claude-sonnet-4-6",
    });
  return new AnthropicProvider({
    type: "anthropic",
    model: "claude-sonnet-4-6",
    anthropicApiKey:
      route === "Claude subscription token" ? "sk-ant-oat01-fixture-token" : "fixture-key",
  });
}
function request(context: string): LLMRequest {
  return {
    model: "claude-sonnet-4-6",
    maxTokens: 64,
    system: `Stable instructions\n\n${context}`,
    systemBlocks: [
      { text: "Stable instructions", scope: "session", cacheable: true },
      { text: context, scope: "turn", cacheable: false },
    ],
    messages: [{ role: "user", content: "Read the fixture" }],
    promptCache: { mode: "anthropic_auto", ttl: "1h", explicitRecentMessages: 3 },
  };
}

describe("Anthropic cache controls through real HTTP transports", () => {
  beforeEach(async () => {
    bodies.length = 0;
    headers.length = 0;
    responseContents.length = 0;
    rejectControls = false;
    rejectTurnContext = false;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      headers.push(req.headers);
      if (rejectTurnContext && body.messages.some((message: Any) => message.clear_at)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "messages.1.clear_at: Extra inputs are not permitted",
            },
          }),
        );
        return;
      }
      if (rejectControls && JSON.stringify(body).includes('"cache_control"')) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "cache_control is not supported" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: body.model,
          content: responseContents.shift() || [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 25,
            output_tokens: 5,
            cache_read_input_tokens: 2_048,
            cache_creation_input_tokens: 128,
            cache_creation: { ephemeral_1h_input_tokens: 128 },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    baseURL = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each(routes)(
    "preserves a stable cache breakpoint, live context, and inclusive usage on %s",
    async (route) => {
      const p = provider(route);
      const input = request("First turn guidance");
      const snapshot = structuredClone(input);
      const first = await p.createMessage(input);
      await p.createMessage(request("Updated turn guidance"));
      expect(input).toEqual(snapshot);
      expect(bodies).toHaveLength(2);
      expect(bodies[0].system[0]).toEqual({
        type: "text",
        text: "Stable instructions",
        cache_control: { type: "ephemeral", ttl: "1h" },
      });
      expect(bodies[1].system[0]).toEqual(bodies[0].system[0]);
      expect(bodies[1].messages).toEqual(bodies[0].messages);
      expect(bodies[1].system[1]).toEqual({ type: "text", text: "Updated turn guidance" });
      expect(bodies[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(first.usage).toEqual({
        inputTokens: 2_201,
        outputTokens: 5,
        cachedTokens: 2_048,
        cacheWriteTokens: 128,
        cacheWriteTtl: "1h",
      });
    },
  );

  it.each(["Claude API", "Azure Anthropic"] as const)(
    "bounds both cache fallbacks and remembers rejected controls on %s",
    async (route) => {
      rejectControls = true;
      const p = provider(route);
      const input = request("Retain this instruction on every retry");
      await p.createMessage(input);
      await p.createMessage(input);
      expect(bodies).toHaveLength(4);
      for (const body of bodies.slice(2)) {
        expect(JSON.stringify(body)).not.toContain('"cache_control"');
        expect(body.system[1].text).toBe("Retain this instruction on every retry");
        expect(body.messages[0].content).toBe("Read the fixture");
      }
    },
  );

  it.each(routes)(
    "keeps prior scoped context and signed thinking across tool turns, persistence, and changed context on %s",
    async (route) => {
      const input = request("First context");
      input.model = "claude-opus-5-5";
      input.tools = [
        {
          name: "read_file",
          description: "Read fixture",
          input_schema: { type: "object", properties: {} },
        },
      ];
      responseContents.push(
        [
          { type: "thinking", thinking: "Read the fixture", signature: "signed-fixture-1" },
          { type: "tool_use", id: "tool-1", name: "read_file", input: {} },
        ],
        [
          { type: "thinking", thinking: "Use the results", signature: "signed-fixture-2" },
          { type: "text", text: "Done" },
        ],
      );
      const first = await provider(route).createMessage(input);
      appendAssistantResponseToConversation(input.messages, first, 0);
      input.messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "fixture" }],
      });
      const history = JSON.parse(
        JSON.stringify(assertNormalizedTurnTranscript(input.messages)),
      ) as LLMMessage[];
      const next = {
        ...request("Second context"),
        model: input.model,
        tools: input.tools,
        messages: history,
      };
      const second = await provider(route).createMessage(next);
      appendAssistantResponseToConversation(history, second, 0);
      history.push({ role: "user", content: "Continue" });
      await provider(route).createMessage({
        ...next,
        ...request("Third context"),
        model: input.model,
        tools: input.tools,
        messages: JSON.parse(JSON.stringify(history)),
      });

      expect(bodies).toHaveLength(3);
      expect(bodies[0].system).toHaveLength(1);
      expect(bodies[1].system).toEqual(bodies[0].system);
      expect(bodies[2].system).toEqual(bodies[0].system);
      expect(bodies[1].messages.slice(0, 2)).toEqual(bodies[0].messages);
      expect(bodies[2].messages.slice(0, 5)).toEqual(bodies[1].messages);
      expect(bodies[1].messages[2].content[0].signature).toBe("signed-fixture-1");
      expect(bodies[2].messages[5].content[0].signature).toBe("signed-fixture-2");
      expect(
        bodies[2].messages
          .filter((message: Any) => message.role === "system")
          .map((message: Any) => message.content[0].text),
      ).toEqual(["First context", "Second context", "Third context"]);
      expect(
        headers.every((header) => header["anthropic-beta"].includes(ANTHROPIC_TURN_CONTEXT_BETA)),
      ).toBe(true);
      if (route === "Claude subscription token") {
        expect(headers[0]["anthropic-beta"]).toContain("oauth-2025-04-20");
        expect(headers[0]["anthropic-beta"]).toContain("claude-code-20250219");
        expect(headers[0].authorization).toBe("Bearer sk-ant-oat01-fixture-token");
      }
    },
  );

  it.each(routes)(
    "persists context without reasoning and never marks scoped context as cacheable on %s",
    async (route) => {
      const input = {
        ...request("Transient guidance"),
        model: "claude-opus-5-5",
        promptCache: { mode: "anthropic_explicit", ttl: "5m", explicitRecentMessages: 50 },
      } as LLMRequest;
      const first = await provider(route).createMessage(input);
      expect(first.reasoning).toBeUndefined();
      expect(first.providerContext?.text).toBe("Transient guidance");
      appendAssistantResponseToConversation(input.messages, first, 0);
      input.messages.push({ role: "user", content: "Next" });
      await provider(route).createMessage({
        ...input,
        messages: JSON.parse(JSON.stringify(input.messages)),
      });
      const body = bodies[1];
      expect(body.messages.filter((message: Any) => message.role === "system")).toHaveLength(2);
      for (const message of body.messages.filter((message: Any) => message.role === "system")) {
        expect(message.clear_at).toBe("next_user_message");
        expect(JSON.stringify(message)).not.toContain("cache_control");
      }
      expect(body.messages[0].content.at(-1).cache_control).toBeDefined();
      expect(JSON.stringify(body).split('"cache_control"').length - 1).toBeLessThanOrEqual(4);
    },
  );

  it.each(routes)(
    "falls back once from scoped context and remembers rejection on %s",
    async (route) => {
      rejectTurnContext = true;
      const p = provider(route);
      const input = { ...request("Required current instruction"), model: "claude-opus-5-5" };
      const first = await p.createMessage(input);
      await p.createMessage(input);
      expect(bodies).toHaveLength(3);
      expect(first.providerContext).toBeUndefined();
      for (const body of bodies.slice(1)) {
        expect(body.system.map((part: Any) => part.text)).toEqual([
          "Stable instructions",
          "Required current instruction",
        ]);
        expect(body.messages).toEqual([{ role: "user", content: "Read the fixture" }]);
      }
      expect(headers[1]["anthropic-beta"] || "").not.toContain(ANTHROPIC_TURN_CONTEXT_BETA);
    },
  );

  it.each(["Claude API", "Azure Anthropic"] as const)(
    "handles both scoped-context and cache-control rejection with bounded retries on %s",
    async (route) => {
      rejectTurnContext = true;
      rejectControls = true;
      const p = provider(route);
      const input = { ...request("Required on all retries"), model: "claude-opus-5-5" };
      await p.createMessage(input);
      await p.createMessage(input);
      expect(bodies).toHaveLength(5);
      expect(JSON.stringify(bodies.at(-1))).not.toContain("cache_control");
      expect(bodies.at(-1).system.map((part: Any) => part.text)).toEqual([
        "Stable instructions",
        "Required on all retries",
      ]);
    },
  );

  it.each(["Claude API", "Azure Anthropic"] as const)(
    "keeps scoped-context layout consistent when only cache controls are rejected on %s",
    async (route) => {
      rejectControls = true;
      const p = provider(route);
      const input = { ...request("Live context"), model: "claude-opus-5-5" };
      const first = await p.createMessage(input);
      appendAssistantResponseToConversation(input.messages, first, 0);
      input.messages.push({ role: "user", content: "Next" });
      await p.createMessage(input);
      expect(bodies).toHaveLength(4);
      expect(first.providerContext).toBeDefined();
      expect(JSON.stringify(bodies[2])).not.toContain("cache_control");
      expect(bodies[2].system.map((part: Any) => part.text)).toEqual(["Stable instructions"]);
      expect(bodies[3].messages.filter((message: Any) => message.role === "system")).toHaveLength(
        2,
      );
      expect(bodies[3].messages.slice(0, 2)).toEqual(bodies[2].messages);
    },
  );
});
