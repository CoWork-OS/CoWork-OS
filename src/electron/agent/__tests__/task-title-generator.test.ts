import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory } from "../llm/provider-factory";
import {
  generateTaskTitle,
  generateAndApplyTaskTitle,
  generateTaskTitleFromProvider,
  MAX_GENERATED_TASK_TITLE_LENGTH,
  sanitizeGeneratedTaskTitle,
  shouldGenerateTaskTitle,
} from "../task-title-generator";
import type { Task } from "../../../shared/types";

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

describe("task title persistence", () => {
  function fixture(text: string | Error = "Add two numbers") {
    vi.spyOn(LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "openai",
      modelId: "selected-model",
      modelKey: "selected-model",
      llmProfileUsed: "cheap",
      resolvedModelKey: "selected-model",
      modelSource: "provider_default",
      warnings: [],
    });
    const createMessage = vi.fn(async () => {
      if (text instanceof Error) throw text;
      return { content: [{ type: "text", text }], stopReason: "end_turn" };
    });
    vi.spyOn(LLMProviderFactory, "createProvider").mockReturnValue({ createMessage } as Any);
    const task = {
      id: "task-1",
      title: "what is 2+2? answer in one word",
      prompt: "what is 2+2? answer in one word",
    } as Task;
    const repository = {
      updateTitleIfUnchanged: vi.fn().mockResolvedValue(true),
      findById: vi.fn().mockResolvedValue({ ...task, title: "Add two numbers" }),
    };
    const onTitleUpdated = vi.fn();
    return { task, repository, onTitleUpdated, createMessage };
  }

  it("generates prompt placeholders, respects explicit opt-outs and keeps custom names", () => {
    expect(shouldGenerateTaskTitle("what is 2+2?", "what is 2+2?")).toBe(true);
    expect(shouldGenerateTaskTitle("Math check", "what is 2+2?")).toBe(false);
    expect(shouldGenerateTaskTitle("Math check", "what is 2+2?", true)).toBe(true);
    expect(shouldGenerateTaskTitle("what is 2+2?", "what is 2+2?", false)).toBe(false);
    expect(shouldGenerateTaskTitle("", "")).toBe(false);
  });

  it("persists and broadcasts the generated title using the original placeholder guard", async () => {
    const { task, repository, onTitleUpdated } = fixture();
    await generateAndApplyTaskTitle(task, task.prompt, repository, onTitleUpdated);
    expect(repository.updateTitleIfUnchanged).toHaveBeenCalledWith(
      task.id,
      task.title,
      "Add two numbers",
    );
    expect(onTitleUpdated).toHaveBeenCalledWith(task.id, "Add two numbers");
  });

  it("does not broadcast when a user renamed or deleted the task during generation", async () => {
    const { task, repository, onTitleUpdated } = fixture();
    repository.updateTitleIfUnchanged.mockResolvedValue(false);
    await generateAndApplyTaskTitle(task, task.prompt, repository, onTitleUpdated);
    expect(repository.findById).not.toHaveBeenCalled();
    expect(onTitleUpdated).not.toHaveBeenCalled();
  });

  it("does not broadcast a stale generated name after another rename", async () => {
    const { task, repository, onTitleUpdated } = fixture();
    repository.findById.mockResolvedValue({ ...task, title: "My math notes" });
    await generateAndApplyTaskTitle(task, task.prompt, repository, onTitleUpdated);
    expect(onTitleUpdated).not.toHaveBeenCalled();
  });

  it.each(["", new Error("Provider unavailable")])(
    "retains the placeholder and logs unusable provider output: %s",
    async (output) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { task, repository, onTitleUpdated } = fixture(output);
      await expect(
        generateAndApplyTaskTitle(task, task.prompt, repository, onTitleUpdated),
      ).resolves.toBeUndefined();
      expect(repository.updateTitleIfUnchanged).not.toHaveBeenCalled();
      expect(onTitleUpdated).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    },
  );

  it("keeps persistent bot conversation names", async () => {
    const { task, repository, onTitleUpdated, createMessage } = fixture();
    await generateAndApplyTaskTitle(task, task.prompt, repository, onTitleUpdated, {
      botConversation: true,
    });
    expect(createMessage).not.toHaveBeenCalled();
  });
});
