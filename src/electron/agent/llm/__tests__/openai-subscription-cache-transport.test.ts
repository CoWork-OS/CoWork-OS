import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider, resetPromptCacheRejectionsForTests } from "../openai-provider";
import type { LLMMessage, LLMRequest } from "../types";

let baseUrl: string;
let server: Server;
let rejectCacheKey = false;
const requests: Array<{ body: Any; headers: IncomingHttpHeaders }> = [];
// Synthetic JWT test data: the SDK reads its account claim before making a request.
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "cache-test-account" } })).toString("base64url")}.test`;

vi.mock("../openai-oauth", () => ({
  OpenAIOAuth: {
    getApiKeyFromTokens: async () => ({ apiKey: token, newTokens: null }),
  },
}));

vi.mock("../pi-ai-loader", () => ({
  loadPiAiModule: async () => {
    // Exercise the installed SDK's serialization and SSE usage parsing, not a
    // mocked complete() implementation. Only its destination is a local fixture.
    const sdk = await import("@earendil-works/pi-ai/compat");
    return {
      getModels: () => [{ ...sdk.getModels("openai-codex")[0], id: "gpt-5.4", baseUrl }],
      complete: sdk.complete,
    };
  },
}));

function makeRequest(turnContext: string, messages: LLMMessage[]): LLMRequest {
  return {
    model: "gpt-5.4",
    maxTokens: 64,
    system: `Stable instructions\n\n${turnContext}`,
    systemBlocks: [
      { text: "Stable instructions", scope: "session", cacheable: true },
      { text: turnContext, scope: "turn", cacheable: false },
    ],
    messages,
    tools: [
      {
        name: "lookup",
        description: "Read the fixture",
        input_schema: { type: "object", properties: {} },
      },
    ],
    promptCache: {
      mode: "openai_key",
      ttl: "1h",
      explicitRecentMessages: 3,
      cacheKey: "subscription-cache-test",
    },
  };
}

function createProvider() {
  return new OpenAIProvider({
    type: "openai",
    model: "gpt-5.4",
    openaiAccessToken: token,
    openaiRefreshToken: "test-refresh",
    openaiTokenExpiresAt: Date.now() + 60_000,
  });
}

describe("ChatGPT subscription prompt caching through the installed transport", () => {
  beforeEach(async () => {
    resetPromptCacheRejectionsForTests();
    requests.length = 0;
    rejectCacheKey = false;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(
        (req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString(),
      );
      requests.push({ body, headers: req.headers });
      if (rejectCacheKey && body.prompt_cache_key) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unsupported parameter: prompt_cache_key" } }));
        return;
      }
      const item = {
        type: "message",
        id: "msg_fixture",
        role: "assistant",
        phase: "final_answer",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      };
      const response = {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 4_096,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 3_072, cache_write_tokens: 128 },
        },
      };
      const events = [
        { type: "response.created", response: { id: response.id, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("preserves the wire history and routing key as context changes and reports cache reads/writes once", async () => {
    const provider = createProvider();
    const history: LLMMessage[] = [
      { role: "user", content: "Read the fixture" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_fixture|fc_fixture", name: "lookup", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_fixture|fc_fixture",
            content: "Fixture output",
          },
        ],
      },
    ];
    const request = makeRequest("Current time: first", history);
    const snapshot = structuredClone(request);
    const first = await provider.createMessage(request);
    await provider.createMessage(
      makeRequest("Current time: second", [
        ...history,
        { role: "assistant", content: first.content },
        { role: "user", content: "Summarize the fixture" },
      ]),
    );

    expect(request).toEqual(snapshot);
    expect(requests).toHaveLength(2);
    const [a, b] = requests.map(({ body }) => body);
    expect(a.instructions).toBe("Stable instructions");
    expect(b.instructions).toBe(a.instructions);
    expect(a.input.slice(0, -1)).toEqual(b.input.slice(0, a.input.length - 1));
    expect(a.input[0].content[0].text).toBe("Read the fixture");
    expect(a.input.at(-2)).toMatchObject({
      type: "function_call_output",
      call_id: "call_fixture",
      output: "Fixture output",
    });
    for (const [index, { body, headers }] of requests.entries()) {
      expect(body.prompt_cache_key).toBe("subscription-cache-test");
      expect(headers["session-id"]).toBe(body.prompt_cache_key);
      expect(body).not.toHaveProperty("prompt_cache_options");
      expect(body).not.toHaveProperty("prompt_cache_retention");
      expect(body.store).toBe(false);
      expect(body.input.at(-1)).toEqual({
        role: "developer",
        content: [
          { type: "input_text", text: `Current time: ${index === 0 ? "first" : "second"}` },
        ],
      });
    }
    expect(first.usage).toEqual({
      inputTokens: 4_096,
      outputTokens: 2,
      cachedTokens: 3_072,
      cacheWriteTokens: 128,
    });
  });

  it("remembers a real transport key rejection while retaining every instruction on retries", async () => {
    rejectCacheKey = true;
    const request = makeRequest("Only inspect the fixture", [{ role: "user", content: "Check" }]);
    await createProvider().createMessage(request);
    await createProvider().createMessage(request);

    expect(requests).toHaveLength(3);
    expect(requests[0].body.prompt_cache_key).toBe("subscription-cache-test");
    for (const { body, headers } of requests.slice(1)) {
      expect(body).not.toHaveProperty("prompt_cache_key");
      expect(headers["session-id"]).toBeUndefined();
      expect(body.instructions).toBe(request.system);
      expect(body.input).toHaveLength(1);
    }
  });
});
