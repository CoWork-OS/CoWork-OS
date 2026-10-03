import { describe, expect, it } from "vitest";

import { isContextCapacityError, parseContextOverflowTokenCounts } from "../executor-helpers";

describe("isContextCapacityError", () => {
  it.each([
    ["Anthropic, bare", "prompt is too long: 210000 tokens > 200000 maximum"],
    [
      "Anthropic, API error body",
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
    ],
    [
      "Anthropic, input plus max_tokens",
      "input length and `max_tokens` exceed context limit: 198000 + 8192 > 200000, decrease input length or `max_tokens` and try again",
    ],
    [
      "Bedrock",
      "ValidationException: The model returned the following errors: Input is too long for requested model.",
    ],
    [
      "Gemini",
      "The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).",
    ],
    ["llama.cpp", "the request exceeds the available context size, try increasing it"],
    [
      "OpenAI",
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    ],
    ["xAI", "This model's maximum prompt length is 131072 but the request contains 150000 tokens."],
    [
      "Mistral",
      "Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length",
    ],
  ])("treats %s overflow as a context-capacity error", (_label, message) => {
    expect(isContextCapacityError(message)).toBe(true);
    expect(isContextCapacityError(new Error(message))).toBe(true);
  });

  it.each([
    [
      "Anthropic output cap",
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 70000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-5"}}',
    ],
    [
      "OpenAI output cap",
      "max_tokens is too large: 70000. This model supports at most 16384 completion tokens, whereas you provided 70000.",
    ],
    ["rate limit", "429 Rate limit exceeded, please retry"],
    ["empty", ""],
  ])("does not treat %s as a context-capacity error", (_label, message) => {
    expect(isContextCapacityError(message)).toBe(false);
  });
});

describe("parseContextOverflowTokenCounts", () => {
  it.each([
    ["prompt is too long: 210000 tokens > 200000 maximum", { requested: 210000, limit: 200000 }],
    [
      "input length and `max_tokens` exceed context limit: 198000 + 8192 > 200000",
      { requested: 206192, limit: 200000 },
    ],
    [
      "The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).",
      { requested: 1100000, limit: 1048576 },
    ],
    [
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      { requested: 130000, limit: 128000 },
    ],
    [
      "This model's maximum prompt length is 131072 but the request contains 150000 tokens.",
      { requested: 150000, limit: 131072 },
    ],
    [
      "Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length",
      { requested: 40000, limit: 32768 },
    ],
  ])("reads the counts from %s", (message, expected) => {
    expect(parseContextOverflowTokenCounts(new Error(message))).toEqual(expected);
  });

  it("returns null when the error carries no counts", () => {
    expect(parseContextOverflowTokenCounts("Input is too long for requested model.")).toBeNull();
  });
});
