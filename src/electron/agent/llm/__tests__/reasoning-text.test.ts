import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fromOpenAICompatibleResponse } from "../openai-compatible";
import {
  OllamaProvider,
  clearOllamaThinkingCacheForTests,
  templateForcesThinking,
} from "../ollama-provider";
import { looksLikeReasoningPreamble, splitReasoningFromText } from "../reasoning-text";
import type { LLMRequest } from "../types";

/**
 * Responses recorded from Ollama 0.35.1 serving qwen3:4b for the prompt
 * "Reply with exactly the word: hello". Streams keep every chunk around the
 * reasoning/answer boundary and drop the middle of the reasoning.
 */
const FIXTURES = path.join(__dirname, "fixtures", "qwen3-reasoning");

function fixtureJson(name: string): Any {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

/** Fold an Ollama /api/chat NDJSON stream into the shape stream:false returns. */
function assembleOllamaStream(name: string): Any {
  const chunks = readFileSync(path.join(FIXTURES, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const last = chunks[chunks.length - 1];
  const content = chunks.map((chunk) => chunk.message?.content ?? "").join("");
  const thinking = chunks.map((chunk) => chunk.message?.thinking ?? "").join("");
  return {
    ...last,
    message: { role: "assistant", content, ...(thinking ? { thinking } : {}) },
  };
}

/** Fold an OpenAI-compatible SSE stream into a chat.completion object. */
function assembleOpenAICompatibleStream(name: string): Any {
  const events = readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n\n")
    .map((event) => event.replace(/^data: /, "").trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
  const deltas = events.map((event) => event.choices?.[0]?.delta ?? {});
  return {
    id: events[0].id,
    object: "chat.completion",
    model: events[0].model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: deltas.map((delta) => delta.content ?? "").join(""),
          reasoning: deltas.map((delta) => delta.reasoning ?? "").join(""),
        },
        finish_reason: events[events.length - 1].choices?.[0]?.finish_reason,
      },
    ],
  };
}

function textOf(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

const REASONING_OPENER = "Hmm, the user just asked me";

describe("splitReasoningFromText", () => {
  it("leaves text without reasoning untouched", () => {
    expect(splitReasoningFromText("  hello\n")).toEqual({ text: "  hello\n", reasoning: "" });
  });

  it("removes leading <think> and <thinking> blocks", () => {
    expect(splitReasoningFromText("<think>plan it</think>\n\nhello")).toEqual({
      text: "hello",
      reasoning: "plan it",
    });
    expect(splitReasoningFromText("<thinking>a</thinking><think>b</think>hi").text).toBe("hi");
  });

  it("treats text before a bare </think> as reasoning the template opened", () => {
    const recorded = fixtureJson("native-think-false.json").message.content;
    const split = splitReasoningFromText(recorded);
    expect(split.text).toBe("hello");
    expect(split.reasoning.startsWith(REASONING_OPENER)).toBe(true);
  });

  it("treats an unclosed leading <think> as reasoning cut off before the answer", () => {
    expect(splitReasoningFromText("<think>still going")).toEqual({
      text: "",
      reasoning: "still going",
    });
  });

  it("keeps think tags that appear inside an answer", () => {
    const answer = "Wrap reasoning in <think> and close it with </think>.";
    expect(splitReasoningFromText(answer).text).toBe(answer);
  });
});

describe("looksLikeReasoningPreamble", () => {
  it.each([
    'We are given a request: "Write',
    "We are given a user request",
    "Okay, I need to improve the draft assistant response",
    "Hmm, the user just asked me to reply",
    "The user wants a haiku",
    "Let me think about this",
    "We need to create a session name",
  ])("flags %j", (value) => {
    expect(looksLikeReasoningPreamble(value)).toBe(true);
  });

  it.each(["Autumn Haiku", "Okay Go concert notes", "Let Me Down Slowly lyrics", "Weekly report"])(
    "accepts %j",
    (value) => {
      expect(looksLikeReasoningPreamble(value)).toBe(false);
    },
  );
});

describe("templateForcesThinking", () => {
  it("detects a template that always opens <think> (recorded qwen3:4b)", () => {
    expect(templateForcesThinking(fixtureJson("show-qwen3-4b.json").template)).toBe(true);
  });

  it("does not flag templates that honor think, or renderer-backed models", () => {
    const hybrid = [
      '{{- if and (ne .Role "assistant") $last }}<|im_start|>assistant',
      "{{ if and $.IsThinkSet (not $.Think) -}}",
      "<think>\n\n</think>\n\n",
      "{{ end -}}",
      "{{- end }}",
    ].join("\n");
    expect(templateForcesThinking(hybrid)).toBe(false);
    expect(templateForcesThinking("{{ .Prompt }}")).toBe(false);
    expect(templateForcesThinking(undefined)).toBe(false);
  });
});

function ollamaRequest(model = "qwen3:4b"): LLMRequest {
  return {
    model,
    maxTokens: 1024,
    system: "You are helpful.",
    messages: [{ role: "user", content: "Reply with exactly the word: hello" }],
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function routeOllama(chat: unknown[], show?: unknown) {
  const queue = [...chat];
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).endsWith("/api/show")) {
      return show
        ? jsonResponse(show)
        : ({ ok: false, status: 404, json: vi.fn() } as unknown as Response);
    }
    return jsonResponse(queue.shift());
  });
}

function sentBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/api/chat"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("OllamaProvider with qwen3 reasoning (recorded responses)", () => {
  afterEach(() => {
    clearOllamaThinkingCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["think disabled, non-streaming", () => fixtureJson("native-think-false.json")],
    ["think disabled, streaming", () => assembleOllamaStream("native-think-false.ndjson")],
    ["thinking field, non-streaming", () => fixtureJson("native-think-default.json")],
    ["thinking field, streaming", () => assembleOllamaStream("native-think-default.ndjson")],
  ])("returns only the answer: %s", async (_label, load) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", routeOllama([load()]));
    const provider = new OllamaProvider({ type: "ollama", model: "qwen3:4b" });

    const response = await provider.createMessage(ollamaRequest());

    expect(textOf(response)).toBe("hello");
    expect(JSON.stringify(response)).not.toContain(REASONING_OPENER);
    expect(response.stopReason).toBe("end_turn");
  });

  it("keeps reasoning cut off by the token limit out of the reply", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const truncated = fixtureJson("native-think-default.json");
    truncated.message = { role: "assistant", content: "<think>Hmm, the user just asked me" };
    truncated.done_reason = "length";
    vi.stubGlobal("fetch", routeOllama([truncated]));
    const provider = new OllamaProvider({ type: "ollama", model: "qwen3:4b" });

    const response = await provider.createMessage(ollamaRequest());

    expect(response.content).toEqual([]);
    expect(response.stopReason).toBe("max_tokens");
  });

  it("leaves thinking on for a model whose template always opens <think>", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = routeOllama(
      [fixtureJson("native-think-default.json")],
      fixtureJson("show-qwen3-4b.json"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "qwen3:4b" });

    const response = await provider.createMessage(ollamaRequest());

    expect(sentBodies(fetchMock)[0]).not.toHaveProperty("think");
    expect(textOf(response)).toBe("hello");
  });

  it("stops sending think:false once a model is seen reasoning in content anyway", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = routeOllama([
      fixtureJson("native-think-false.json"),
      fixtureJson("native-think-default.json"),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "qwen3:4b" });

    await provider.createMessage(ollamaRequest());
    const second = await provider.createMessage(ollamaRequest());

    const [first, next] = sentBodies(fetchMock);
    expect(first).toMatchObject({ think: false });
    expect(next).not.toHaveProperty("think");
    expect(textOf(second)).toBe("hello");
  });
});

describe("fromOpenAICompatibleResponse with qwen3 reasoning (recorded responses)", () => {
  it.each([
    ["reasoning field, non-streaming", () => fixtureJson("compat.json")],
    ["reasoning field, streaming", () => assembleOpenAICompatibleStream("compat.sse")],
    ["reasoning in content, non-streaming", () => fixtureJson("compat-reasoning-none.json")],
  ])("returns only the answer: %s", (_label, load) => {
    const response = fromOpenAICompatibleResponse(load());

    expect(textOf(response)).toBe("hello");
    expect(JSON.stringify(response)).not.toContain(REASONING_OPENER);
    expect(response.stopReason).toBe("end_turn");
  });
});
