/**
 * Tests for canvas_push HTML fallback behavior
 * Validates the fallback logic that extracts or generates HTML when content is missing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskExecutor } from "../executor";
import type { LLMToolUse } from "../llm";

function createExecutorWithStubs() {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  executor.task = {
    id: "task-1",
    title: "Test Task",
    prompt: "Build a dashboard",
  };
  executor.lastUserMessage = "Please build a dashboard";
  executor.daemon = {
    logEvent: vi.fn(),
  };

  executor.extractHtmlFromText = vi.fn();
  executor.generateCanvasHtml = vi.fn();

  return executor as TaskExecutor & {
    daemon: { logEvent: ReturnType<typeof vi.fn> };
    extractHtmlFromText: ReturnType<typeof vi.fn>;
    generateCanvasHtml: ReturnType<typeof vi.fn>;
  };
}

function createToolUse(input: Record<string, Any>): LLMToolUse {
  return {
    type: "tool_use",
    id: "tool-1",
    name: "canvas_push",
    input,
  };
}

describe("TaskExecutor canvas_push fallback", () => {
  let executor: ReturnType<typeof createExecutorWithStubs>;

  beforeEach(() => {
    executor = createExecutorWithStubs();
    vi.clearAllMocks();
  });

  it("does nothing when canvas_push already has content", async () => {
    const content = createToolUse({
      session_id: "session-1",
      content: "<html><body>Existing</body></html>",
    });

    await (executor as Any).handleCanvasPushFallback(content, "assistant text");

    expect(executor.extractHtmlFromText).not.toHaveBeenCalled();
    expect(executor.generateCanvasHtml).not.toHaveBeenCalled();
    expect(content.input.content).toContain("Existing");
    expect(executor.daemon.logEvent).not.toHaveBeenCalled();
  });

  it("uses extracted HTML when content is missing", async () => {
    const content = createToolUse({ session_id: "session-1" });
    executor.extractHtmlFromText.mockReturnValue("<html><body>Extracted</body></html>");
    executor.generateCanvasHtml.mockResolvedValue("<html><body>Generated</body></html>");

    await (executor as Any).handleCanvasPushFallback(content, "assistant text");

    expect(executor.extractHtmlFromText).toHaveBeenCalledWith("assistant text");
    expect(executor.generateCanvasHtml).not.toHaveBeenCalled();
    expect(content.input.content).toContain("Extracted");
    expect(executor.daemon.logEvent).toHaveBeenCalledWith("task-1", "parameter_inference", {
      tool: "canvas_push",
      inference: "Recovered HTML from assistant text",
    });
  });

  it("generates HTML when extraction fails", async () => {
    const content = createToolUse({ session_id: "session-1" });
    executor.extractHtmlFromText.mockReturnValue(null);
    executor.generateCanvasHtml.mockResolvedValue("<html><body>Generated</body></html>");

    await (executor as Any).handleCanvasPushFallback(content, "assistant text");

    expect(executor.extractHtmlFromText).toHaveBeenCalledWith("assistant text");
    expect(executor.generateCanvasHtml).toHaveBeenCalledWith("Please build a dashboard");
    expect(content.input.content).toContain("Generated");
    expect(executor.daemon.logEvent).toHaveBeenCalledWith("task-1", "parameter_inference", {
      tool: "canvas_push",
      inference: "Auto-generated HTML from latest user request",
    });
  });

  it("skips fallback for non-HTML targets", async () => {
    const content = createToolUse({
      session_id: "session-1",
      filename: "styles.css",
    });
    executor.extractHtmlFromText.mockReturnValue("<html><body>Extracted</body></html>");
    executor.generateCanvasHtml.mockResolvedValue("<html><body>Generated</body></html>");

    await (executor as Any).handleCanvasPushFallback(content, "assistant text");

    expect(executor.extractHtmlFromText).not.toHaveBeenCalled();
    expect(executor.generateCanvasHtml).not.toHaveBeenCalled();
    expect(content.input.content).toBeUndefined();
    expect(executor.daemon.logEvent).not.toHaveBeenCalled();
  });
});
