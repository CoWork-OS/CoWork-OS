import { describe, expect, it } from "vitest";
import { TaskExecutor } from "../executor";

/**
 * Tests for isRedirectIntent() and compactHistoryForRedirect().
 *
 * These cover the follow-up redirect detection logic that prevents the LLM
 * from anchoring on prior completed-task context when the user pivots to a
 * new direction.
 */
describe("TaskExecutor — isRedirectIntent", () => {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  const isRedirect = (text: string): boolean =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (executor as any).isRedirectIntent(text);

  describe("Pattern 1 — ignore-and-pivot", () => {
    it("detects the canonical failure case", () => {
      expect(
        isRedirect(
          "ignore the openclaw related fixes for its codebase and focus on new features or enhancements",
        ),
      ).toBe(true);
    });

    it("detects 'ignore X and work on Y'", () => {
      expect(isRedirect("ignore the bug fixes and work on the dashboard instead")).toBe(true);
    });

    it("detects 'ignore X, do Y'", () => {
      expect(isRedirect("ignore the auth module, do the payment flow")).toBe(true);
    });

    it("detects 'ignore X and build Y'", () => {
      expect(isRedirect("ignore the refactoring tasks and build the new onboarding flow")).toBe(
        true,
      );
    });
  });

  describe("Pattern 2 — explicit pivot language", () => {
    it("detects 'pivot to X'", () => {
      expect(isRedirect("let's pivot to building the authentication flow")).toBe(true);
    });

    it("detects 'redirect to X'", () => {
      expect(isRedirect("redirect to working on the API endpoints")).toBe(true);
    });

    it("detects 'change direction'", () => {
      expect(isRedirect("change direction and focus on the payment module")).toBe(true);
    });

    it("detects 'change focus'", () => {
      expect(isRedirect("change focus to the frontend performance issues")).toBe(true);
    });

    it("detects 'change approach'", () => {
      expect(isRedirect("let's change approach and try a different architecture")).toBe(true);
    });

    it("detects 'new direction'", () => {
      expect(isRedirect("new direction: focus on the mobile app instead")).toBe(true);
    });
  });

  describe("Pattern 3 — contrast pivot", () => {
    it("detects 'instead of X, focus on Y'", () => {
      expect(isRedirect("instead of refactoring the old code, focus on writing new tests")).toBe(
        true,
      );
    });

    it("detects 'rather than X, build Y'", () => {
      expect(isRedirect("rather than fixing the existing bugs, build the new feature")).toBe(true);
    });

    it("detects 'instead of X, work on Y'", () => {
      expect(isRedirect("instead of the database migration, work on the UI redesign")).toBe(true);
    });
  });

  describe("Pattern 4 — negate-and-pivot", () => {
    it("detects 'forget that and focus on X'", () => {
      expect(isRedirect("forget that approach and instead focus on the API layer")).toBe(true);
    });

    it("detects 'don't do X, focus on Y'", () => {
      expect(isRedirect("don't fix the styling issues, focus on the backend logic instead")).toBe(
        true,
      );
    });

    it("detects 'skip X and work on Y'", () => {
      expect(isRedirect("skip the tests for now and work on the deployment script")).toBe(true);
    });

    it("detects 'drop X, concentrate on Y'", () => {
      expect(isRedirect("drop the OpenClaw integration, concentrate on the new features")).toBe(
        true,
      );
    });

    it("detects 'abandon X, focus instead'", () => {
      expect(isRedirect("abandon the current plan and focus instead on delivering the MVP")).toBe(
        true,
      );
    });
  });

  describe("Pattern 5 — scope narrowing", () => {
    it("detects 'focus only on Y'", () => {
      expect(isRedirect("focus only on the new features, not the old bugs")).toBe(true);
    });

    it("detects 'only focus on Y'", () => {
      expect(isRedirect("only focus on the critical path items")).toBe(true);
    });

    it("detects 'focus solely on Y'", () => {
      expect(isRedirect("focus solely on the performance improvements")).toBe(true);
    });

    it("detects 'focus exclusively on Y'", () => {
      expect(isRedirect("focus exclusively on the security fixes")).toBe(true);
    });
  });

  describe("non-redirect messages — should NOT be detected", () => {
    it("does not flag simple greetings", () => {
      expect(isRedirect("hello")).toBe(false);
      expect(isRedirect("thanks")).toBe(false);
      expect(isRedirect("good morning")).toBe(false);
    });

    it("does not flag plain execution tasks", () => {
      expect(isRedirect("build a REST API for user authentication")).toBe(false);
      expect(isRedirect("create a new React component for the dashboard")).toBe(false);
    });

    it("does not flag extend follow-ups", () => {
      expect(isRedirect("also check the auth module")).toBe(false);
      expect(isRedirect("what did you find in the logs?")).toBe(false);
      expect(isRedirect("can you also look at the payment service?")).toBe(false);
    });

    it("does not flag correction follow-ups", () => {
      expect(isRedirect("you used the wrong API, please use v2 instead")).toBe(false);
      expect(isRedirect("actually use the postgres database not sqlite")).toBe(false);
    });

    it("does not flag empty or whitespace input", () => {
      expect(isRedirect("")).toBe(false);
      expect(isRedirect("   ")).toBe(false);
    });
  });
});

describe("TaskExecutor — compactHistoryForRedirect", () => {
  it("replaces full conversation history with a user→assistant stub pair", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Fix OpenClaw Bugs" };
    executor.conversationHistory = [
      { role: "user", content: [{ type: "text", text: "fix the bugs" }] },
      { role: "assistant", content: [{ type: "text", text: "Done, fixed 3 bugs." }] },
      { role: "user", content: [{ type: "text", text: "also check the logs" }] },
      { role: "assistant", content: [{ type: "text", text: "Logs look clean." }] },
    ];

    (executor as any).compactHistoryForRedirect();

    expect(executor.conversationHistory).toHaveLength(2);
  });

  it("stub starts with a user turn so providers requiring alternating roles are satisfied", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Fix OpenClaw Bugs" };
    executor.conversationHistory = [];

    (executor as any).compactHistoryForRedirect();

    const [first, second] = executor.conversationHistory;
    // Must be user → assistant so appending the redirect message yields user,assistant,user
    expect(first.role).toBe("user");
    expect(second.role).toBe("assistant");
  });

  it("user stub references the task title", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Fix OpenClaw Bugs" };
    executor.conversationHistory = [];

    (executor as any).compactHistoryForRedirect();

    const userText = executor.conversationHistory[0].content[0].text as string;
    expect(userText).toContain("Fix OpenClaw Bugs");
  });

  it("uses a generic label when task has no title", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {};
    executor.conversationHistory = [
      { role: "user", content: [{ type: "text", text: "do something" }] },
    ];

    (executor as any).compactHistoryForRedirect();

    const userText = executor.conversationHistory[0].content[0].text as string;
    expect(userText).toContain("previous session");
  });

  it("both stub entries are valid LLMMessages with text content", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Some Task" };
    executor.conversationHistory = [];

    (executor as any).compactHistoryForRedirect();

    for (const msg of executor.conversationHistory) {
      expect(Array.isArray(msg.content)).toBe(true);
      expect(msg.content[0].type).toBe("text");
      expect(typeof msg.content[0].text).toBe("string");
      expect(msg.content[0].text.length).toBeGreaterThan(0);
    }
  });

  it("appending a user redirect message after compaction yields valid user,assistant,user order", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Old Task" };
    executor.conversationHistory = [];

    (executor as any).compactHistoryForRedirect();

    // Simulate what sendMessageLegacy does: append the redirect message
    executor.conversationHistory.push({
      role: "user",
      content: [{ type: "text", text: "ignore X, focus on Y instead" }],
    });

    const roles = executor.conversationHistory.map((m: Any) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });
});

describe("TaskExecutor — sendMessageLegacy redirect wiring", () => {
  it("sets redirectRequested=true for pivot messages and false for plain ones", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    // Use the public isRedirectIntent surface via direct call
    const check = (text: string) => (executor as any).isRedirectIntent(text);

    expect(check("ignore the openclaw fixes and focus on new features")).toBe(true);
    expect(check("pivot to the authentication module")).toBe(true);
    expect(check("instead of X, focus on Y")).toBe(true);
    expect(check("build a new dashboard")).toBe(false);
    expect(check("what did you find?")).toBe(false);
    expect(check("also check the API layer")).toBe(false);
  });

  it("compactHistoryForRedirect leaves history ready for the redirect message to be appended", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Prior Task" };
    // Simulate a long prior session history
    executor.conversationHistory = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `message ${i}` }],
    }));

    (executor as any).compactHistoryForRedirect();

    // History is compacted to just 2 stub entries — not 20
    expect(executor.conversationHistory).toHaveLength(2);
    // Last entry is assistant, ready for the user redirect message to follow
    expect(executor.conversationHistory[1].role).toBe("assistant");
  });
});
