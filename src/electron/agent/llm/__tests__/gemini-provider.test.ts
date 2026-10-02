import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../gemini-provider";

describe("GeminiProvider image handling", () => {
  it("does not send image bytes to Gemini", () => {
    const provider = new GeminiProvider({
      type: "gemini",
      model: "gemini-2.0-flash",
      geminiApiKey: "test-key",
    });

    const converted = (provider as Any).convertMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          {
            type: "image",
            data: "AA==",
            mimeType: "image/png",
            originalSizeBytes: 2,
          },
        ],
      },
    ]);

    expect(converted[0].parts).toEqual([
      { text: "Describe this" },
      {
        text: "[Image attached: image/png, 0.0MB - this provider does not support inline images. Switch to an image-capable model/provider and resend the image.]",
      },
    ]);
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
