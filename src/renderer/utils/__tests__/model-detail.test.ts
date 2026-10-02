import { describe, expect, it } from "vitest";
import { getModelDetail } from "../model-detail";

describe("getModelDetail", () => {
  it("drops a repeated model name and a leading 'for'", () => {
    expect(
      getModelDetail({
        displayName: "GPT-6 Astra",
        description: "GPT-6 Astra for ChatGPT subscription access",
      }),
    ).toBe("ChatGPT subscription access");
  });

  it("keeps descriptions that say something else", () => {
    expect(
      getModelDetail({
        displayName: "GPT-6.1 Sol",
        description: "Complex coding and professional work",
      }),
    ).toBe("Complex coding and professional work");
    expect(getModelDetail({ displayName: "Local", description: "" })).toBe("");
  });
});
