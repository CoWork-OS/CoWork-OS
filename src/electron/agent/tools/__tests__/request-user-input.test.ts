import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../registry";

const validQuestions = [
  {
    header: "Surface",
    id: "integration_surface",
    question: "Where should this ship first?",
    options: [
      { label: "Desktop + API (Recommended)", description: "Use both app and control-plane." },
      { label: "Desktop only", description: "Ship app UI first." },
    ],
  },
];

describe("ToolRegistry request_user_input", () => {
  it("accepts valid payload in plan mode and returns submitted response", async () => {
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue({ agentConfig: { executionMode: "plan" } }),
      requestUserInput: vi.fn().mockResolvedValue({
        requestId: "req-1",
        status: "submitted",
        answers: { integration_surface: { optionLabel: "Desktop + API (Recommended)" } },
      }),
    };
    const fakeThis = { daemon, taskId: "task-1" } as Any;

    const result = await (ToolRegistry as Any).prototype.requestUserInput.call(fakeThis, {
      questions: validQuestions,
    });

    expect(daemon.requestUserInput).toHaveBeenCalledWith("task-1", { questions: validQuestions });
    expect(result).toEqual({
      requestId: "req-1",
      status: "submitted",
      answers: { integration_surface: { optionLabel: "Desktop + API (Recommended)" } },
    });
  });

  it("rejects request_user_input outside plan or debug mode", async () => {
    const fakeThis = {
      taskId: "task-2",
      daemon: {
        getTaskById: vi.fn().mockResolvedValue({ agentConfig: { executionMode: "execute" } }),
        requestUserInput: vi.fn(),
      },
    } as Any;

    await expect(
      (ToolRegistry as Any).prototype.requestUserInput.call(fakeThis, { questions: validQuestions }),
    ).rejects.toThrow(/only available in plan or debug mode/i);
  });

  it("accepts valid payload in debug mode", async () => {
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue({ agentConfig: { executionMode: "debug" } }),
      requestUserInput: vi.fn().mockResolvedValue({
        requestId: "req-dbg",
        status: "submitted",
        answers: { integration_surface: { optionLabel: "Desktop + API (Recommended)" } },
      }),
    };
    const fakeThis = { daemon, taskId: "task-dbg" } as Any;

    const result = await (ToolRegistry as Any).prototype.requestUserInput.call(fakeThis, {
      questions: validQuestions,
    });

    expect(daemon.requestUserInput).toHaveBeenCalledWith("task-dbg", { questions: validQuestions });
    expect(result.status).toBe("submitted");
  });

  it("normalizes imperfect payloads into valid request_user_input schema", async () => {
    const fakeThis = {
      taskId: "task-3",
      daemon: {
        getTaskById: vi.fn().mockResolvedValue({ agentConfig: { executionMode: "plan" } }),
        requestUserInput: vi.fn().mockResolvedValue({
          requestId: "req-3",
          status: "submitted",
          answers: {},
        }),
      },
    } as Any;

    await (ToolRegistry as Any).prototype.requestUserInput.call(fakeThis, {
      questions: [
        {
          header: "This header is too long for the limit",
          id: "NotSnakeCase",
          question: "What should we optimize first?",
          options: ["Speed", "Quality", "Cost"],
        },
        {
          header: "Another",
          id: "NotSnakeCase",
          question: "How fast should we ship?",
          options: [
            { label: "This week" },
            { label: "This month", description: "Balance quality and speed." },
            { label: "Next quarter", description: "Prioritize stability." },
            { label: "Much later", description: "Out of scope in v1." },
          ],
        },
        {
          header: "Third",
          id: "third_choice",
          question: "Pick rollout scope",
          options: [{ label: "Pilot" }, { label: "Broad release" }],
        },
        {
          header: "Fourth",
          id: "ignored_overflow",
          question: "Should be ignored due to 1..3 limit",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    });

    expect(fakeThis.daemon.requestUserInput).toHaveBeenCalledTimes(1);
    const normalizedPayload = fakeThis.daemon.requestUserInput.mock.calls[0][1];
    expect(Array.isArray(normalizedPayload.questions)).toBe(true);
    expect(normalizedPayload.questions).toHaveLength(3);
    expect(normalizedPayload.questions[0].header.length).toBeLessThanOrEqual(12);
    expect(normalizedPayload.questions[0].id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(normalizedPayload.questions[1].id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(normalizedPayload.questions[0].options.length).toBeGreaterThanOrEqual(2);
    expect(normalizedPayload.questions[0].options.length).toBeLessThanOrEqual(3);
    expect(normalizedPayload.questions[1].options.length).toBeLessThanOrEqual(3);
    expect(normalizedPayload.questions[0].options[0].label).toContain("(Recommended)");
  });
});
