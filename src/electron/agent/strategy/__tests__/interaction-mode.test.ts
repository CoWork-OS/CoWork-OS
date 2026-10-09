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
  it.each(["chat", "smart"] as const)(
    "respects %s mode when a question requests source retrieval",
    (mode) => {
      const config = resolveInteractionMode(
        { accessProfileId: "read_only" },
        { mode },
        "Dayanak kayıtlarında emsal bir karar bulabilir misin?",
      );
      expect(config.executionMode).toBe(mode === "chat" ? "chat" : "execute");
      expect(config.accessProfileId).toBe("read_only");
    },
  );
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
  it.each([
    "Just propose a plan, don't implement anything.",
    "Only propose a plan for the refactor.",
    "Review the PR. Do not implement anything.",
    "Explain how to fix the login bug. Don't implement it.",
    "Describe the caching architecture without implementing anything.",
    "Summarize the open issues. Do not modify any files.",
  ])("treats an unscoped no-action request as proposal-only: %s", (prompt) => {
    const result = resolveInteractionMode(undefined, { mode: "smart" }, prompt);
    expect(result.executionMode).toBe("plan");
    expect(result.executionModeSource).toBe("user");
  });
  it.each([
    "Fix the failing test in parser.test.ts. Don't modify files in vendor/.",
    "Implement the /orders endpoint and just explain the tricky parts at the end.",
    "Write the migration, but don't execute it.",
    "Add input validation to the signup form. Do not change any files outside src/forms.",
    "Refactor the logger. Don't change files that are generated.",
    "Update the copy on the pricing page; only review the rest of the page for typos.",
    "Rename the env var everywhere; do not modify files under node_modules.",
  ])("does not lock a scoped prohibition or side request into plan mode: %s", (prompt) => {
    const result = resolveInteractionMode(undefined, { mode: "smart" }, prompt);
    expect(result.executionMode).not.toBe("plan");
    expect(result.executionModeSource).not.toBe("user");
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
  it("preserves the explicit Plan override", () => {
    expect(
      resolveInteractionMode(
        undefined,
        { mode: "smart", executionOverride: "plan" },
        "Explain this approach",
      ).executionMode,
    ).toBe("plan");
  });
  it("folds saved analyze, debug, verified and execute overrides back to Do", () => {
    for (const legacy of ["analyze", "debug", "verified", "execute"]) {
      expect(
        getInteractionModeSelection({
          interactionMode: { mode: "smart", executionOverride: legacy as "plan" },
        }),
      ).toEqual({ mode: "smart" });
      expect(
        getInteractionModeSelection({
          executionMode: legacy as "plan",
          executionModeSource: "user",
        }),
      ).toEqual({ mode: "smart" });
    }
    expect(
      InteractionModeSchema.safeParse({ mode: "smart", executionOverride: "verified" }).success,
    ).toBe(false);
  });
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
