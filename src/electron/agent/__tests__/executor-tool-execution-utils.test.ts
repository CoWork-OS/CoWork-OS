import { describe, expect, it } from "vitest";
import {
  buildUnavailableToolResult,
  buildNormalizedToolResult,
  compactNetworkToolResultForLocalModel,
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

  it("uses HTTP status details when a request tool returns no explicit error", () => {
    expect(
      getToolFailureReason(
        {
          success: false,
          status: 404,
          statusText: "Not Found",
          body: "missing",
        },
        "unknown error",
      ),
    ).toBe("HTTP 404 Not Found");
  });

  it("uses non-generic status text for status-zero request failures", () => {
    expect(
      getToolFailureReason(
        {
          success: false,
          status: 0,
          statusText: "Request timed out",
        },
        "unknown error",
      ),
    ).toBe("Request timed out");
  });

  it("reports non-zero normal run_command termination as an exit code", () => {
    expect(
      getToolFailureReason(
        {
          success: false,
          terminationReason: "normal",
          exitCode: 2,
        },
        "unknown error",
      ),
    ).toBe("exit code 2");
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

  it("classifies desktop geolocation provider failures as hard failures", () => {
    expect(
      isHardToolFailure(
        "get_current_location",
        {
          success: false,
          error:
            "Desktop geolocation timed out. Do not retry get_current_location in this task.",
        },
        "Desktop geolocation timed out. Do not retry get_current_location in this task.",
      ),
    ).toBe(true);
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

  it("compacts large network JSON results for local models while preserving source facts", () => {
    const releases = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      node_id: `node-${index}`,
      tag_name: `v1.${index}`,
      name: `Release ${index}`,
      html_url: `https://github.com/example/project/releases/tag/v1.${index}`,
      published_at: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      body: `Important release notes ${index}\n${"feature detail ".repeat(500)}`,
      author: {
        login: "maintainer",
        avatar_url: "https://avatars.example/maintainer.png",
      },
    }));
    const rawResult = JSON.stringify({
      success: true,
      url: "https://api.github.com/repos/example/project/releases?per_page=100",
      status: 200,
      headers: {
        "content-type": "application/json",
        link: '<https://api.github.com/repositories/1/releases?page=2>; rel="next", <https://api.github.com/repositories/1/releases?page=5>; rel="last"',
        server: "github.com",
      },
      body: JSON.stringify(releases, null, 2),
      contentLength: 120000,
    });

    const compacted = compactNetworkToolResultForLocalModel({
      toolName: "http_request",
      result: {},
      rawResult,
    });

    expect(compacted.length).toBeLessThan(4_000);
    expect(compacted).toContain("_cowork_compacted_for_local_model");
    expect(compacted).toContain("https://api.github.com/repos/example/project/releases");
    expect(compacted).toContain("v1.0");
    expect(compacted).toContain("published_at");
    expect(compacted).toContain("rel=\\\"last\\\"");
    expect(compacted).not.toContain("avatar_url");
    expect(compacted).toContain("omittedItems");
  });

  it("uses local-model network compaction only when requested", () => {
    const largeReadme = `# Project\n\n${"Details about the project.\n".repeat(5000)}`;
    const rawResult = JSON.stringify({
      success: true,
      url: "https://raw.githubusercontent.com/example/project/main/README.md",
      status: 200,
      body: largeReadme,
      contentLength: largeReadme.length,
    });

    const normal = buildNormalizedToolResult({
      toolName: "http_request",
      toolUseId: "tool-normal",
      result: { success: true },
      rawResult,
      sanitizeToolResult: (_toolName, resultText) => resultText,
      getToolFailureReason,
    });
    const compacted = buildNormalizedToolResult({
      toolName: "http_request",
      toolUseId: "tool-local",
      result: { success: true },
      rawResult,
      sanitizeToolResult: (_toolName, resultText) => resultText,
      getToolFailureReason,
      compactForLocalModel: true,
    });

    expect(normal.toolResult.content.length).toBeGreaterThan(compacted.toolResult.content.length);
    expect(compacted.toolResult.content).toContain("_cowork_compacted_for_local_model");
    expect(compacted.toolResult.content).toContain("https://raw.githubusercontent.com/example/project/main/README.md");
  });
});
