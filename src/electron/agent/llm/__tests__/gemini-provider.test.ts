import { describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../gemini-provider";

describe("GeminiProvider image handling", () => {
  it("preserves provider-reported implicit cache reads inside the total prompt tokens", () => {
    const provider = new GeminiProvider({
      type: "gemini",
      model: "gemini-2.5-flash",
      geminiApiKey: "test-key",
    });
    const response = (provider as Any).convertResponse({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }],
      usageMetadata: {
        promptTokenCount: 4_096,
        candidatesTokenCount: 10,
        cachedContentTokenCount: 3_072,
      },
    });
    expect(response.usage).toEqual({ inputTokens: 4_096, outputTokens: 10, cachedTokens: 3_072 });
  });

  const imageMessage = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Describe this" },
        {
          type: "image" as const,
          data: "AA==",
          mimeType: "image/png" as const,
          originalSizeBytes: 2,
        },
      ],
    },
  ];

  it("sends image blocks as inlineData parts to vision-capable models", () => {
    for (const model of ["gemini-2.5-flash", "gemini-3-pro-preview", "models/gemini-1.5-pro"]) {
      const provider = new GeminiProvider({ type: "gemini", model, geminiApiKey: "test-key" });
      const converted = (provider as Any).convertMessages(imageMessage, model);
      expect(converted[0].parts, model).toEqual([
        { text: "Describe this" },
        { inlineData: { mimeType: "image/png", data: "AA==" } },
      ]);
    }
  });

  it("keeps the text fallback for text-only models", () => {
    for (const model of ["gemini-1.0-pro", "gemini-pro", "gemma-3-1b-it"]) {
      const provider = new GeminiProvider({ type: "gemini", model, geminiApiKey: "test-key" });
      const converted = (provider as Any).convertMessages(imageMessage, model);
      expect(converted[0].parts[1].text, model).toContain("[Image attached: image/png");
      expect(converted[0].parts[1].inlineData, model).toBeUndefined();
    }
  });

  it("puts image bytes into the generateContent request", async () => {
    const provider = new GeminiProvider({
      type: "gemini",
      model: "gemini-2.5-flash",
      geminiApiKey: "test-key",
    });
    const generateContent = vi.fn().mockResolvedValue({
      response: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }] },
    });
    vi.spyOn((provider as Any).client, "getGenerativeModel").mockReturnValue({ generateContent });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await provider.createMessage({
      model: "gemini-2.5-flash",
      maxTokens: 100,
      system: "",
      messages: imageMessage,
    });

    const request = generateContent.mock.calls[0][0];
    expect(request.contents[0].parts).toContainEqual({
      inlineData: { mimeType: "image/png", data: "AA==" },
    });
  });
});

describe("GeminiProvider restored tool replay", () => {
  it("reconstructs function name and thought signature from serialized tool blocks", () => {
    const provider = Object.create(GeminiProvider.prototype) as Any;
    provider.toolIdToName = new Map();
    provider.toolIdToThoughtSignature = new Map();
    const restored = JSON.parse(
      JSON.stringify([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "gemini_call",
              name: "read_file",
              input: { path: "a.txt" },
              providerMetadata: {
                geminiFunctionName: "read_file",
                geminiThoughtSignature: "sig-1",
              },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "gemini_call", content: "ok" }],
        },
      ]),
    );
    const converted = (provider as Any).convertMessages(restored, "gemini-2.5-pro");
    expect(converted[1].parts[0].functionResponse.name).toBe("read_file");
    expect(converted[0].parts[0].thoughtSignature).toBe("sig-1");
  });
});

describe("GeminiProvider stop reasons", () => {
  it("reports function calls as tool_use even when Gemini says STOP", () => {
    const provider = new GeminiProvider({
      type: "gemini",
      model: "gemini-2.5-pro",
      geminiApiKey: "test-key",
    });

    const response = (provider as Any).convertResponse({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "I'll read the log first." },
              { functionCall: { name: "read_file", args: { path: "app.log" } } },
            ],
          },
        },
      ],
    });

    expect(response.stopReason).toBe("tool_use");
    expect(response.content[1]).toMatchObject({ type: "tool_use", name: "read_file" });
  });

  it("keeps STOP without function calls as end_turn", () => {
    const provider = new GeminiProvider({
      type: "gemini",
      model: "gemini-2.5-pro",
      geminiApiKey: "test-key",
    });

    const response = (provider as Any).convertResponse({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Done." }] } }],
    });

    expect(response.stopReason).toBe("end_turn");
  });
});

describe("GeminiProvider blocked responses", () => {
  it.each(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "OTHER"])(
    "reports finishReason %s as a refusal",
    (finishReason) => {
      const provider = new GeminiProvider({
        type: "gemini",
        model: "gemini-2.5-pro",
        geminiApiKey: "test-key",
      });

      const response = (provider as Any).convertResponse({
        candidates: [{ finishReason, content: { parts: [] } }],
      });

      expect(response.stopReason).toBe("refusal");
    },
  );
});

describe("GeminiProvider tool schema sanitizing", () => {
  it("drops JSON Schema keywords Gemini function declarations reject", () => {
    const provider = new GeminiProvider({
      type: "gemini",
      model: "gemini-2.5-pro",
      geminiApiKey: "test-key",
    });

    const [{ functionDeclarations }] = (provider as Any).convertTools([
      {
        name: "configure",
        description: "Configure the job",
        input_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            env: { type: "object", additionalProperties: { type: "string" } },
            target: {
              oneOf: [
                { type: "string", format: "uri" },
                { type: "integer", format: "int64" },
              ],
            },
            mode: { type: "string", const: "fast", default: "fast" },
            when: { type: "string", format: "date-time", $comment: "ISO time" },
          },
          required: ["target"],
        },
      },
    ]);
    const parameters = functionDeclarations[0].parameters;

    expect(JSON.stringify(parameters)).not.toMatch(
      /additionalProperties|oneOf|\$comment|"const"|"default"|"uri"/,
    );
    expect(parameters.properties.env).toEqual({ type: "object" });
    expect(parameters.properties.target).toEqual({
      anyOf: [{ type: "string" }, { type: "integer", format: "int64" }],
    });
    expect(parameters.properties.mode).toEqual({ type: "string", enum: ["fast"] });
    expect(parameters.properties.when).toEqual({ type: "string", format: "date-time" });
    expect(parameters.required).toEqual(["target"]);
  });
});
