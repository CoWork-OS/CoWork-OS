import { describe, expect, it, vi } from "vitest";
import type { DecisionProvider, JevResponse } from "../../decisions";
import {
  buildJevToolReviewRequest,
  reviewToolCallWithJev,
  shouldObserveJevToolCall,
} from "../harness";

function response(values: Partial<Record<string, number>> = {}): JevResponse {
  const answer = (id: string) => ({
    type: "noul" as const,
    noul: values[id] ?? 0.1,
  });
  return {
    model: "jev-latest",
    answers: {
      task_aligned: answer("taskAligned"),
      sensitive_export: answer("sensitiveExport"),
      consequential_change: answer("consequentialChange"),
      state_sufficient: answer("stateSufficient"),
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function provider(decision: JevResponse | Error): DecisionProvider {
  return {
    decide: vi.fn(async () => {
      if (decision instanceof Error) throw decision;
      return decision;
    }),
    testConnection: vi.fn(),
    health: vi.fn(),
  } as unknown as DecisionProvider;
}

describe("Jev optional harness", () => {
  it("only selects consequential or external calls for observation", () => {
    expect(shouldObserveJevToolCall("read_file", null, "none")).toBe(false);
    expect(shouldObserveJevToolCall("web_fetch", "network_access", "none")).toBe(false);
    expect(shouldObserveJevToolCall("run_command", "run_command", "medium")).toBe(true);
    expect(shouldObserveJevToolCall("write_file", "workspace_write", "low")).toBe(true);
    expect(shouldObserveJevToolCall("mcp_salesforce_update", "external_service", "high")).toBe(
      true,
    );
    expect(shouldObserveJevToolCall("browser_snapshot", "network_access", "none")).toBe(false);
    expect(shouldObserveJevToolCall("browser_click", "network_access", "medium")).toBe(true);
  });

  it("builds bounded, untrusted state without forwarding credential values", () => {
    const request = buildJevToolReviewRequest({
      model: "jev-latest",
      taskPrompt: "Review the deployment task",
      toolName: "http_request",
      toolCallId: "call-123",
      approvalType: "data_export",
      sideEffectLevel: "high",
      toolInput: {
        apiKey: "secret-api-key",
        nested: { password: "secret-password" },
        longText: "x".repeat(500),
      },
    });

    const serialized = JSON.stringify(request.state);
    expect(serialized).toContain("untrusted");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[TRUNCATED]");
    expect(serialized).toContain('"assessmentIncomplete":false');
    expect(serialized).toContain('"contextTruncated":true');
    expect(serialized).not.toContain("secret-api-key");
    expect(serialized).not.toContain("secret-password");
  });

  it("does not force uncertainty solely because the task prompt is bounded", async () => {
    const result = await reviewToolCallWithJev({
      provider: provider(
        response({
          taskAligned: 0.95,
          sensitiveExport: 0.02,
          consequentialChange: 0.1,
          stateSufficient: 0.92,
        }),
      ),
      model: "jev-latest",
      taskPrompt: "Create the requested files and verify them. ".repeat(20),
      toolName: "write_file",
      toolInput: { path: "notes.md", content: "hello" },
      approvalType: "workspace_write",
      sideEffectLevel: "low",
    });

    expect(result.status).toBe("benign");
    expect(result.reasonCodes).toEqual([]);
  });

  it("returns an advisory assessment and preserves the request digest", async () => {
    const decisionProvider = provider(
      response({
        taskAligned: 0.95,
        sensitiveExport: 0.05,
        consequentialChange: 0.15,
        stateSufficient: 0.9,
      }),
    );

    const result = await reviewToolCallWithJev({
      provider: decisionProvider,
      model: "jev-latest",
      taskPrompt: "Run the requested check",
      toolName: "run_command",
      toolInput: { command: "git status" },
      approvalType: "run_command",
      sideEffectLevel: "medium",
    });

    expect(result.status).toBe("benign");
    expect(result.reasonCodes).toEqual([]);
    expect(result.stateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.answers?.stateSufficient).toBe(0.9);
    expect(decisionProvider.decide).toHaveBeenCalledTimes(1);
    expect(decisionProvider.decide).toHaveBeenCalledWith(
      expect.objectContaining({ model: "jev-latest", questions: expect.any(Object) }),
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it("marks concern and uncertainty without turning them into a block", async () => {
    const result = await reviewToolCallWithJev({
      provider: provider(
        response({
          taskAligned: 0.2,
          sensitiveExport: 0.9,
          consequentialChange: 0.9,
          stateSufficient: 0.8,
        }),
      ),
      model: "jev-latest",
      toolName: "mcp_external_action",
      toolInput: { record: "redacted" },
    });

    expect(result.status).toBe("concerning");
    expect(result.reasonCodes).toEqual([
      "task_drift",
      "possible_sensitive_export",
      "consequential_change",
    ]);

    const uncertain = await reviewToolCallWithJev({
      provider: provider(
        response({
          taskAligned: 0.9,
          stateSufficient: 0.2,
        }),
      ),
      model: "jev-latest",
      toolName: "run_command",
      toolInput: { command: "git status" },
    });
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.reasonCodes).toContain("state_incomplete");
  });

  it("fails open for execution when the decision provider is unavailable", async () => {
    const result = await reviewToolCallWithJev({
      provider: provider(new Error("upstream unavailable")),
      model: "jev-latest",
      toolName: "delete_file",
      toolInput: { path: "draft.txt" },
    });

    expect(result.status).toBe("unavailable");
    expect(result.reasonCodes).toEqual(["provider_error"]);
    expect(result.error).toBe("Jev observation unavailable.");
  });
});
