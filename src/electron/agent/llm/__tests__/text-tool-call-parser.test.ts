import { afterEach, describe, expect, it } from "vitest";

import {
  applyTextToolCallFallback,
  getTextToolCallFallbackStats,
  parseTextToolCalls,
  resetTextToolCallFallbackStatsForTests,
} from "../text-tool-call-parser";
import type { LLMRequest, LLMResponse, LLMTool } from "../types";

const TOOLS: LLMTool[] = [
  {
    name: "read_file",
    description: "Read a file from the workspace. Returns its contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, maxBytes: { type: "number" } },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" }, timeout_ms: { type: "integer" } },
      required: ["command"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_document",
    description: "Create a document.",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
];

function calls(text: string, userText?: string) {
  return parseTextToolCalls(text, TOOLS, { userText });
}

describe("parseTextToolCalls formats", () => {
  it("parses a Hermes/Qwen <tool_call> block and keeps the surrounding prose", () => {
    const result = calls(
      'Let me read it.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "README.md"}}\n</tool_call>',
    );
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0]).toMatchObject({
      type: "tool_use",
      name: "read_file",
      input: { path: "README.md" },
    });
    expect(result.toolUses[0].id).toMatch(/^call_text_/);
    expect(result.remainingText).toBe("Let me read it.");
    expect(result.formats).toEqual(["tool_call_tag"]);
  });

  it("accepts a <tool_call> block whose closing tag was cut off by a stop token", () => {
    const result = calls('<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}');
    expect(result.toolUses.map((call) => call.input)).toEqual([{ path: "a.txt" }]);
    expect(result.remainingText).toBe("");
  });

  it("parses <function=name> with a JSON body (Llama 3.1 custom format)", () => {
    const result = calls('<function=read_file>{"path": "src/index.ts"}</function>');
    expect(result.toolUses[0]).toMatchObject({
      name: "read_file",
      input: { path: "src/index.ts" },
    });
    expect(result.formats).toEqual(["function_tag"]);
  });

  it("parses <function=name><parameter=...> bodies and coerces values by schema type", () => {
    const result = calls(
      [
        "<tool_call>",
        "<function=run_command>",
        "<parameter=command>",
        "ls -la",
        "</parameter>",
        "<parameter=timeout_ms>",
        "5000",
        "</parameter>",
        "</function>",
        "</tool_call>",
      ].join("\n"),
    );
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0]).toMatchObject({
      name: "run_command",
      input: { command: "ls -la", timeout_ms: 5000 },
    });
  });

  it("keeps a numeric-looking value as a string when the schema says string", () => {
    const result = calls("<function=read_file><parameter=path>2024</parameter></function>");
    expect(result.toolUses[0].input).toEqual({ path: "2024" });
  });

  it("parses Llama 3 <|python_tag|> calls with a parameters key", () => {
    const result = calls(
      '<|python_tag|>{"name": "read_file", "parameters": {"path": "notes.md"}}<|eom_id|>',
    );
    expect(result.toolUses[0]).toMatchObject({ name: "read_file", input: { path: "notes.md" } });
    expect(result.formats).toEqual(["python_tag"]);
    expect(result.remainingText).toBe("");
  });

  it("parses Mistral [TOOL_CALLS] arrays", () => {
    const result = calls(
      '[TOOL_CALLS][{"name": "read_file", "arguments": {"path": "a"}}, {"name": "list_tasks", "arguments": {}}]',
    );
    expect(result.toolUses.map((call) => [call.name, call.input])).toEqual([
      ["read_file", { path: "a" }],
      ["list_tasks", {}],
    ]);
    expect(result.formats).toEqual(["mistral_tool_calls"]);
  });

  it("parses the newer Mistral [TOOL_CALLS]name[ARGS]{...} form", () => {
    const result = calls('[TOOL_CALLS]read_file[ARGS]{"path": "b.txt"}');
    expect(result.toolUses[0]).toMatchObject({ name: "read_file", input: { path: "b.txt" } });
  });

  it("parses a bare JSON object that is the whole message", () => {
    const result = calls('  {"name": "read_file", "arguments": {"path": "c.txt"}}  ');
    expect(result.toolUses[0]).toMatchObject({ name: "read_file", input: { path: "c.txt" } });
    expect(result.formats).toEqual(["bare_json"]);
    expect(result.remainingText).toBe("");
  });

  it("accepts an OpenAI-shaped function wrapper", () => {
    const result = calls(
      '{"type": "function", "function": {"name": "read_file", "arguments": "{\\"path\\": \\"d\\"}"}}',
    );
    expect(result.toolUses[0]).toMatchObject({ name: "read_file", input: { path: "d" } });
  });

  it("parses fenced ```json and ```tool_call blocks", () => {
    const json = calls(
      'Checking the file.\n```json\n{"name": "read_file", "arguments": {"path": "e"}}\n```',
    );
    expect(json.toolUses[0]).toMatchObject({ name: "read_file", input: { path: "e" } });
    expect(json.remainingText).toBe("Checking the file.");
    expect(json.formats).toEqual(["fenced_json"]);

    const tagged = calls('```tool_call\n{"name": "list_tasks", "arguments": {}}\n```');
    expect(tagged.toolUses[0]).toMatchObject({ name: "list_tasks", input: {} });
  });

  it("tolerates string-encoded arguments and the input key", () => {
    expect(
      calls('<tool_call>{"name": "read_file", "arguments": "{\\"path\\": \\"f\\"}"}</tool_call>')
        .toolUses[0].input,
    ).toEqual({ path: "f" });
    expect(
      calls('<tool_call>{"name": "read_file", "input": {"path": "g"}}</tool_call>').toolUses[0]
        .input,
    ).toEqual({ path: "g" });
  });

  it("parses multiple calls in one message with unique ids", () => {
    const result = calls(
      [
        '<tool_call>{"name": "read_file", "arguments": {"path": "1"}}</tool_call>',
        '<tool_call>{"name": "read_file", "arguments": {"path": "2"}}</tool_call>',
      ].join("\n"),
    );
    expect(result.toolUses.map((call) => call.input)).toEqual([{ path: "1" }, { path: "2" }]);
    expect(new Set(result.toolUses.map((call) => call.id)).size).toBe(2);
  });

  it("resolves namespaced and aliased tool names to an offered tool", () => {
    expect(
      calls('<tool_call>{"name": "functions.read_file", "arguments": {"path": "h"}}</tool_call>')
        .toolUses[0].name,
    ).toBe("read_file");
    expect(
      calls('<tool_call>{"name": "generate_document", "arguments": {"content": "x"}}</tool_call>')
        .toolUses[0].name,
    ).toBe("create_document");
  });
});

describe("parseTextToolCalls rejections", () => {
  it("never accepts a tool that was not offered", () => {
    const text = '<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>';
    const result = calls(text);
    expect(result.toolUses).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ name: "delete_everything", reason: "unknown_tool" }),
    ]);
    expect(result.remainingText).toBe(text);
  });

  it("ignores malformed JSON", () => {
    const text = '<tool_call>{"name": "read_file", "arguments": {"path": "x",}}</tool_call>';
    const result = calls(text);
    expect(result.toolUses).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("malformed_json");
    expect(result.remainingText).toBe(text);
  });

  it("ignores string arguments that are not valid JSON objects", () => {
    expect(
      calls('<tool_call>{"name": "read_file", "arguments": "path=x"}</tool_call>').toolUses,
    ).toEqual([]);
    expect(
      calls('<tool_call>{"name": "read_file", "arguments": [1]}</tool_call>').toolUses,
    ).toEqual([]);
  });

  it("rejects calls missing a required argument", () => {
    const result = calls('<tool_call>{"name": "read_file", "arguments": {}}</tool_call>');
    expect(result.toolUses).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("missing_required");
  });

  it("rejects the whole block when any call in it is unknown", () => {
    const result = calls(
      '[TOOL_CALLS][{"name": "read_file", "arguments": {"path": "a"}}, {"name": "nope", "arguments": {}}]',
    );
    expect(result.toolUses).toEqual([]);
  });

  it("caps the number of calls accepted from one message", () => {
    const text = Array.from(
      { length: 5 },
      (_, index) =>
        `<tool_call>{"name": "read_file", "arguments": {"path": "${index}"}}</tool_call>`,
    ).join("\n");
    const result = parseTextToolCalls(text, TOOLS, { maxCalls: 3 });
    expect(result.toolUses).toHaveLength(3);
    expect(result.rejected.filter((entry) => entry.reason === "call_limit")).toHaveLength(2);
  });

  it("returns nothing when no tools were offered", () => {
    const result = parseTextToolCalls(
      '<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>',
      [],
    );
    expect(result.toolUses).toEqual([]);
  });
});

describe("parseTextToolCalls code examples and prose", () => {
  it("does not parse a fenced example when the text is an explanation", () => {
    const text =
      'Here is an example of the format:\n```json\n{"name": "read_file", "arguments": {"path": "a"}}\n```\nReplace the path with yours.';
    expect(calls(text).toolUses).toEqual([]);
  });

  it("does not parse fenced or bare JSON when the user asked how to call a tool", () => {
    const fenced = '```json\n{"name": "read_file", "arguments": {"path": "a"}}\n```';
    expect(calls(fenced, "How do I call read_file from the agent?").toolUses).toEqual([]);
    const bare = '{"name": "read_file", "arguments": {"path": "a"}}';
    expect(calls(bare, "What is the JSON format for a tool call?").toolUses).toEqual([]);
  });

  it("does not parse a tag introduced as an example on the same line", () => {
    const text =
      'For example: <tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>';
    expect(calls(text).toolUses).toEqual([]);
  });

  it("does not parse tags inside non-tool code fences or inline code", () => {
    const fenced =
      '```python\nprint(\'<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>\')\n```';
    expect(calls(fenced).toolUses).toEqual([]);
    const inline =
      'Use `<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>` to read.';
    expect(calls(inline).toolUses).toEqual([]);
  });

  it("does not treat prose mentioning a tag as a call", () => {
    const result = calls("The <tool_call> tag wraps each call, and <function=name> names it.");
    expect(result.toolUses).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("does not parse JSON embedded in prose", () => {
    const text =
      'The config is {"name": "read_file", "arguments": {"path": "a"}} and nothing else.';
    expect(calls(text).toolUses).toEqual([]);
  });

  it("does not parse a tag introduced by an example line ending in a colon", () => {
    const text =
      'Here is an example of the syntax:\n<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>';
    expect(calls(text).toolUses).toEqual([]);
  });

  it("still parses a real call when the message also contains an unrelated code block", () => {
    const text = [
      "The function currently looks like this:",
      "```ts",
      "export const a = 1;",
      "```",
      'I will open the file. <tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>',
    ].join("\n");
    const result = calls(text);
    expect(result.toolUses.map((call) => call.input)).toEqual([{ path: "a.ts" }]);
    expect(result.remainingText).toContain("export const a = 1;");
    expect(result.remainingText).not.toContain("<tool_call>");
  });

  it("does not let markup inside argument strings start another call", () => {
    const result = calls(
      '<tool_call>{"name": "create_document", "arguments": {"content": "Use <tool_call> tags and ``` fences"}}</tool_call>',
    );
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].input).toEqual({ content: "Use <tool_call> tags and ``` fences" });
  });

  it("does not parse ordinary JSON answers", () => {
    expect(calls('{"name": "Ada", "age": 36}').toolUses).toEqual([]);
    expect(calls('```json\n{"status": "ok"}\n```').toolUses).toEqual([]);
  });
});

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "qwen2.5:7b",
    maxTokens: 512,
    system: "",
    messages: [{ role: "user", content: "Read README.md" }],
    tools: TOOLS,
    ...overrides,
  };
}

describe("applyTextToolCallFallback", () => {
  afterEach(() => resetTextToolCallFallbackStatsForTests());

  const textResponse: LLMResponse = {
    content: [
      {
        type: "text",
        text: 'Reading.\n<tool_call>{"name": "read_file", "arguments": {"path": "README.md"}}</tool_call>',
      },
    ],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 2 },
  };

  it("turns text tool calls into tool_use blocks with stopReason tool_use", () => {
    const result = applyTextToolCallFallback(textResponse, request(), {
      providerType: "ollama",
      model: "qwen2.5:7b",
      mode: "native_tools",
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "text", text: "Reading." },
      expect.objectContaining({
        type: "tool_use",
        name: "read_file",
        input: { path: "README.md" },
      }),
    ]);
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(getTextToolCallFallbackStats()).toMatchObject({
      recoveredResponses: 1,
      recoveredCalls: 1,
    });
  });

  it("never parses text when the response already has native tool calls", () => {
    const native: LLMResponse = {
      content: [
        ...textResponse.content,
        { type: "tool_use", id: "call_1", name: "list_tasks", input: {} },
      ],
      stopReason: "tool_use",
    };
    expect(
      applyTextToolCallFallback(native, request(), {
        providerType: "ollama",
        model: "m",
        mode: "native_tools",
      }),
    ).toBe(native);
  });

  it("leaves responses alone when no tools were offered or tool use was disabled", () => {
    const context = { providerType: "ollama", model: "m", mode: "native_tools" as const };
    expect(applyTextToolCallFallback(textResponse, request({ tools: [] }), context)).toBe(
      textResponse,
    );
    expect(applyTextToolCallFallback(textResponse, request({ toolChoice: "none" }), context)).toBe(
      textResponse,
    );
  });
});
