import { describe, expect, it } from "vitest";
import { resolveInteractionMode } from "../interaction-mode";
import { getInteractionModeSelection } from "../../../../shared/interaction-mode";
import {
  InteractionModeSchema,
  TaskMessageSchema,
  AgentConfigSchema,
} from "../../../utils/validation";
import { sanitizeTaskMessageParams } from "../../../control-plane/sanitize";

describe("interactive mode contract", () => {
  it.each(["/goal implement this", "/review", "/custom-skill run"])(
    "rejects Chat action shortcut %s",
    (prompt) => {
      expect(() => resolveInteractionMode(undefined, { mode: "chat" }, prompt)).toThrow(
        "Switch to Smart",
      );
      expect(() => resolveInteractionMode(undefined, { mode: "smart" }, prompt)).not.toThrow();
    },
  );
  it("allows ordinary absolute paths in Chat", () => {
    expect(
      resolveInteractionMode(undefined, { mode: "chat" }, "/tmp/file.txt explain this")
        .executionMode,
    ).toBe("chat");
  });
  it("does not mistake a scoped compatibility constraint for a proposal-only request", () => {
    expect(
      resolveInteractionMode(
        undefined,
        { mode: "smart" },
        "Implement the feature in src/Login.tsx without changing the public API.",
      ).executionMode,
    ).toBe("execute");
  });
  it("clears stale planning when Smart receives an implementation request", () => {
    const result = resolveInteractionMode(
      { executionMode: "plan", conversationMode: "task" },
      { mode: "smart" },
      "Implement the login form in src/Login.tsx",
    );
    expect(result.executionMode).toBe("execute");
    expect(result.executionModeSource).toBe("strategy");
  });
  it("keeps proposal-only requests non-mutating", () => {
    const result = resolveInteractionMode(
      undefined,
      { mode: "smart" },
      "Analyze the bug in src/Login.tsx and only propose a solution. Do not implement it.",
    );
    expect(["plan", "analyze"]).toContain(result.executionMode);
  });
  it("does not promote Chat for an execution request", () => {
    const result = resolveInteractionMode(
      { accessProfileId: "read_only" },
      { mode: "chat" },
      "Run npm install and edit src/Login.tsx",
    );
    expect(result).toMatchObject({
      executionMode: "chat",
      conversationMode: "chat",
      executionModeSource: "user",
      accessProfileId: "read_only",
    });
  });
  it.each(["plan", "analyze", "debug", "verified", "execute"] as const)(
    "preserves the explicit %s override",
    (executionOverride) => {
      expect(
        resolveInteractionMode(
          undefined,
          { mode: "smart", executionOverride },
          "Explain this approach",
        ).executionMode,
      ).toBe(executionOverride);
    },
  );
  it("does not infer permission to rewrite ambiguous legacy modes", () => {
    expect(getInteractionModeSelection({ executionMode: "plan" })).toBeUndefined();
    expect(
      getInteractionModeSelection({ executionMode: "plan", executionModeSource: "user" }),
    ).toEqual({ mode: "smart", executionOverride: "plan" });
  });
  it("validates the same preference for creation, local and remote follow-ups", () => {
    const interactionMode = { mode: "smart", executionOverride: "plan" } as const;
    const message = {
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      message: "Continue",
      interactionMode,
    };
    expect(AgentConfigSchema.parse({ interactionMode }).interactionMode).toEqual(interactionMode);
    expect(TaskMessageSchema.parse(message).interactionMode).toEqual(interactionMode);
    expect(sanitizeTaskMessageParams(message).interactionMode).toEqual(interactionMode);
  });
  it("rejects contradictory Chat overrides and unknown values", () => {
    expect(
      InteractionModeSchema.safeParse({ mode: "chat", executionOverride: "execute" }).success,
    ).toBe(false);
    expect(() =>
      sanitizeTaskMessageParams({
        taskId: "task",
        message: "Hi",
        interactionMode: { mode: "unknown" },
      }),
    ).toThrow();
  });
});
