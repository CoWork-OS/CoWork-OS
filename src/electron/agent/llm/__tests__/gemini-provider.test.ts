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
        text:
          "[Image attached: image/png, 0.0MB - this provider does not support inline images. Switch to an image-capable model/provider and resend the image.]",
      },
    ]);
  });
});
