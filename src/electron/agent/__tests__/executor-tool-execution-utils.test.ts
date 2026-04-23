import { describe, expect, it } from "vitest";
import {
  buildUnavailableToolResult,
  buildNormalizedToolResult,
  getToolFailureReason,
  getToolInputValidationError,
  isAdvisoryToolFailureResult,
  isEffectivelyIdempotentToolCall,
  isHardToolFailure,
  normalizeToolFailureReason,
  preflightValidateAndRepairToolInput,
} from "../executor-tool-execution-utils";

describe("isEffectivelyIdempotentToolCall", () => {
  const baseIdempotent = (toolName: string) =>
    ["read_file", "list_directory", "search_files"].includes(toolName);

  it("returns true for inherently idempotent tools", () => {
    expect(
      isEffectivelyIdempotentToolCall({
        toolName: "read_file",
        input: { path: "README.md" },
        isIdempotentTool: baseIdempotent,
      }),
    ).toBe(true);
  });

  it("treats read-only cloud actions as idempotent", () => {
    expect(
      isEffectivelyIdempotentToolCall({
        toolName: "box_action",
        input: { action: "list_folder_items", folder_id: "0" },
        isIdempotentTool: baseIdempotent,
      }),
    ).toBe(true);
  });

  it("does not treat mutating cloud actions as idempotent", () => {
    expect(
      isEffectivelyIdempotentToolCall({
        toolName: "box_action",
        input: { action: "create_folder", parent_id: "0", name: "new" },
        isIdempotentTool: baseIdempotent,
      }),
    ).toBe(false);
  });
});

describe("getToolInputValidationError", () => {
  it("validates count_text/text_metrics input contracts", () => {
    expect(getToolInputValidationError("count_text", {})).toContain("either 'text' or 'path'");
    expect(getToolInputValidationError("text_metrics", { text: "x", path: "a.txt" })).toContain(
      "not both",
    );
    expect(getToolInputValidationError("count_text", { text: "hello" })).toBeNull();
    expect(getToolInputValidationError("text_metrics", { path: "note.txt" })).toBeNull();
  });
});

describe("preflightValidateAndRepairToolInput", () => {
  it("repairs empty search_files query from context", () => {
    const result = preflightValidateAndRepairToolInput({
      toolName: "search_files",
      input: { path: "." },
      contextText: "Inspect connect4 engine and policy implementation details",
    });
    expect(result.error).toBeNull();
    expect(result.repaired).toBe(true);
    expect(result.input.query).toContain("connect4");
  });

  it("blocks search_files with empty query when no repair context is available", () => {
    const result = preflightValidateAndRepairToolInput({
      toolName: "search_files",
      input: { path: "." },
      contextText: "the and for to if then also",
    });
    expect(result.repaired).toBe(false);
    expect(result.repairable).toBe(false);
    expect(result.error).toContain("non-empty");
  });

  it("repairs read_file path from alternate filename field", () => {
    const result = preflightValidateAndRepairToolInput({
      toolName: "read_file",
      input: { filename: "README.md" },
    });
    expect(result.repaired).toBe(true);
    expect(result.error).toBeNull();
    expect(result.input.path).toBe("README.md");
  });

  it("blocks nested src/package.json writes for website scaffold tasks", () => {
    const result = preflightValidateAndRepairToolInput({
      toolName: "write_file",
      input: { path: "src/package.json", content: "{}" },
      contextText: "Create a fully working website simulating the Windows 95 UI.",
    });
    expect(result.error).toContain("nested src/package.json");
    expect(result.repairable).toBe(false);
  });

  it("allows nested package manifests when the task explicitly targets a monorepo", () => {
    const result = preflightValidateAndRepairToolInput({
      toolName: "write_file",
      input: { path: "src/package.json", content: "{}" },
      contextText: "Create a monorepo with a nested package setup for a subpackage.",
    });
    expect(result.error).toBeNull();
  });
});

describe("tool failure normalization", () => {
  it("includes available fallback alternatives in unavailable tool results", () => {
    const result = buildUnavailableToolResult({
      toolName: "create_document",
      toolUseId: "tool-1",
      alternatives: ["write_file"],
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('"alternatives":["write_file"]');
    expect(result.content).toContain("Try one of these available alternatives instead: write_file.");
  });

  it("extracts message from structured error objects", () => {
    const result = {
      success: false,
      error: {
        kind: "runtime",
        message: "Variable x is not defined",
        display: "Traceback...",
      },
    };
    expect(getToolFailureReason(result, "unknown error")).toBe("Variable x is not defined");
  });

  it("falls back to display when structured message is absent", () => {
    const normalized = normalizeToolFailureReason(
      {
        success: false,
        error: {
          kind: "runtime",
          display: "Division by zero",
        },
      },
      "unknown error",
    );
    expect(normalized.message).toBe("Division by zero");
    expect(normalized.kind).toBe("runtime");
  });

  it("does not classify non-blocking vision config failures as hard failures", () => {
    expect(
      isHardToolFailure(
        "read_pdf_visual",
        {
          success: false,
          error: "OpenAI API key not configured.",
          nonBlocking: true,
          recoverableFallback: true,
        },
        "OpenAI API key not configured.",
      ),
    ).toBe(false);
  });

  it("treats non-blocking fallback failures as advisory tool results", () => {
    const normalized = buildNormalizedToolResult({
      toolName: "read_pdf_visual",
      toolUseId: "tool-1",
      result: {
        success: false,
        error: "OpenAI API key not configured.",
        nonBlocking: true,
        recoverableFallback: true,
        fallbackHint: "Use parse_document instead.",
      },
      rawResult: JSON.stringify({
        success: false,
        error: "OpenAI API key not configured.",
        nonBlocking: true,
        recoverableFallback: true,
      }),
      sanitizeToolResult: (_toolName, resultText) => resultText,
      getToolFailureReason,
    });

    expect(isAdvisoryToolFailureResult({ success: false, nonBlocking: true })).toBe(true);
    expect(normalized.resultIsError).toBe(true);
    expect(normalized.toolResult.is_error).toBe(false);
    expect(normalized.toolResult.content).toContain("\"nonBlocking\":true");
  });

  it("compacts computer-use screenshot payloads and attaches companion image content", () => {
    const normalized = buildNormalizedToolResult({
      toolName: "screenshot",
      toolUseId: "tool-visual-1",
      result: {
        captureId: "cap_123",
        imageBase64: "ZmFrZQ==",
        mediaType: "image/png",
        width: 640,
        height: 480,
        scaleFactor: 2,
        action: "screenshot",
        target: {
          appName: "Calculator",
          windowTitle: "",
          windowId: 99,
        },
      },
      rawResult: JSON.stringify({
        captureId: "cap_123",
        imageBase64: "ZmFrZQ==",
        mediaType: "image/png",
      }),
      sanitizeToolResult: (_toolName, resultText) => resultText,
      getToolFailureReason,
    });

    expect(normalized.resultIsError).toBe(false);
    expect(normalized.toolResult.is_error).toBe(false);
    expect(normalized.toolResult.content).toContain('"captureId":"cap_123"');
    expect(normalized.toolResult.content).toContain('"imageAttached":true');
    expect(normalized.toolResult.content).not.toContain("ZmFrZQ==");
    expect(normalized.toolResult.companion_user_content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
    ]);
  });
});
