import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory } from "../llm/provider-factory";
import {
  generateTaskTitle,
  generateTaskTitleFromProvider,
  MAX_GENERATED_TASK_TITLE_LENGTH,
  sanitizeGeneratedTaskTitle,
} from "../task-title-generator";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sanitizeGeneratedTaskTitle", () => {
  it("removes model formatting and title labels", () => {
    expect(sanitizeGeneratedTaskTitle('Title: "Review package.json"')).toBe("Review package.json");
  });

  it("keeps generated names within the sidebar-friendly length and word limits", () => {
    const title = sanitizeGeneratedTaskTitle(
      "Investigate the authentication regression across the production deployment pipeline",
    );

    expect(title.length).toBeLessThanOrEqual(MAX_GENERATED_TASK_TITLE_LENGTH);
    expect(title.split(/\s+/).length).toBeLessThanOrEqual(6);
    expect(title).not.toBe("");
    expect(title).not.toContain("...");
  });

  it("rejects refusal or commentary responses", () => {
    expect(sanitizeGeneratedTaskTitle("Sorry, I cannot generate a title for this request.")).toBe(
      "",
    );
  });
});

describe("generateTaskTitleFromProvider", () => {
  it("sends only a bounded title request without tools", async () => {
    const createMessage = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Fix login flow" }],
      stopReason: "end_turn" as const,
    }));

    const title = await generateTaskTitleFromProvider(
      { createMessage },
      "selected-model",
      "Please investigate the login regression and fix the failing tests.",
    );

    expect(title).toBe("Fix login flow");
    expect(createMessage).toHaveBeenCalledOnce();
    const request = createMessage.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: "selected-model",
      maxTokens: 32,
      signal: expect.any(AbortSignal),
    });
    expect(request.tools).toBeUndefined();
    expect(request.messages[0].content[0].text).toContain("login regression");
  });

  it("times out independently of the main task request", async () => {
    const provider = {
      createMessage: vi.fn(() => new Promise<never>(() => {})),
    };

    await expect(
      generateTaskTitleFromProvider(provider, "selected-model", "Name this request", {
        timeoutMs: 5,
      }),
    ).rejects.toThrow("timed out");
  });
});

describe("generateTaskTitle", () => {
  it("uses the selected task model and provider override path", async () => {
    const resolveSelection = vi
      .spyOn(LLMProviderFactory, "resolveTaskModelSelection")
      .mockReturnValue({
        providerType: "openai",
        modelId: "gpt-selected",
        modelKey: "gpt-selected",
        llmProfileUsed: "cheap",
        resolvedModelKey: "gpt-selected",
        modelSource: "explicit_override",
        warnings: [],
      });
    const createProvider = vi.spyOn(LLMProviderFactory, "createProvider").mockReturnValue({
      createMessage: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "Review API errors" }],
        stopReason: "end_turn" as const,
      })),
    } as Any);

    await expect(
      generateTaskTitle("Investigate the API errors", {
        providerType: "openai",
        modelKey: "gpt-selected",
      }),
    ).resolves.toBe("Review API errors");

    expect(resolveSelection).toHaveBeenCalledWith(
      { providerType: "openai", modelKey: "gpt-selected" },
      { allowProviderOverride: true, allowModelOverride: true },
    );
    expect(createProvider).toHaveBeenCalledWith({ type: "openai", model: "gpt-selected" });
  });
});
