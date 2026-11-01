import { describe, expect, it, vi } from "vitest";

vi.mock("../../llm/usage-telemetry", () => ({
  recordLlmCallSuccess: vi.fn(),
  recordLlmCallError: vi.fn(),
}));

import type { Task, TaskEvent } from "../../../../shared/types";
import { ProgressScoreEngine } from "../../progress-score-engine";
import {
  buildJudgePrompt,
  createModelProgressJudge,
  heuristicJudgement,
  parseJudgeVerdict,
  summarizeEventsForJudge,
} from "../watchdog-progress-judge";

const task = {
  id: "task-1",
  title: "Report",
  prompt: "decorated prompt",
  userPrompt: "Summarise the quarterly sales report",
  workspaceId: "ws-1",
} as Task;

function event(type: string, timestamp: number, payload: Record<string, unknown> = {}): TaskEvent {
  return {
    id: `${type}-${timestamp}`,
    taskId: "task-1",
    timestamp,
    type: "timeline_step_updated",
    legacyType: type,
    payload,
    schemaVersion: 2,
  } as TaskEvent;
}

const loopingEvents = [1, 2, 3, 4].map((index) =>
  event("tool_error", index * 1000, {
    tool: "run_command",
    input: { command: "npm test" },
    error: "exit code 1",
  }),
);

describe("summarizeEventsForJudge", () => {
  it("writes one line per event and drops bulk state and metric telemetry", () => {
    const lines = summarizeEventsForJudge([
      event("conversation_snapshot", 0, { messages: ["huge"] }),
      event("log", 500, { metric: "provider_interruptions_total", value: 1 }),
      event("tool_error", 1000, { tool: "run_command", error: "exit code 1" }),
      event("assistant_message", 2000, { message: "Trying again" }),
    ]);
    expect(lines).toEqual([
      "00:00:01 tool_error run_command — exit code 1",
      "00:00:02 assistant_message — Trying again",
    ]);
  });

  it("keeps only the most recent events", () => {
    const many = Array.from({ length: 50 }, (_, index) => event("tool_call", index * 1000));
    expect(summarizeEventsForJudge(many, 30)).toHaveLength(30);
  });
});

describe("parseJudgeVerdict", () => {
  it("reads the JSON verdict, even wrapped in prose", () => {
    expect(
      parseJudgeVerdict(
        'Here: {"verdict":"drifting","loopingOn":"rerunning npm test","reason":"Same failure four times."}',
      ),
    ).toEqual({
      verdict: "drifting",
      loopingOn: "rerunning npm test",
      reason: "Same failure four times.",
    });
    expect(parseJudgeVerdict('{"verdict":"Progressing","reason":"ok","loopingOn":"x"}')).toEqual({
      verdict: "progressing",
      reason: "ok",
    });
  });

  it("returns null for answers it cannot use", () => {
    expect(parseJudgeVerdict("I think it is fine")).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseJudgeVerdict('{"verdict":')).toBeNull();
  });
});

describe("heuristicJudgement", () => {
  it("calls repeated identical failures with no progress drifting", () => {
    const result = heuristicJudgement(ProgressScoreEngine.assessWindow(loopingEvents));
    expect(result.verdict).toBe("drifting");
    expect(result.judge).toBe("heuristic");
    expect(result.loopingOn).toBe("repeated run_command errors");
  });

  it("calls a window with completed steps progressing", () => {
    const result = heuristicJudgement(
      ProgressScoreEngine.assessWindow([event("step_completed", 1), event("file_modified", 2)]),
    );
    expect(result.verdict).toBe("progressing");
  });
});

describe("createModelProgressJudge", () => {
  it("asks the cheap model with the original request, signals and events", async () => {
    const createMessage = vi.fn(async () => ({
      content: [
        {
          type: "text" as const,
          text: '{"verdict":"drifting","loopingOn":"npm test","reason":"Same failing command."}',
        },
      ],
      stopReason: "end_turn" as const,
    }));
    const judge = createModelProgressJudge({
      resolveModel: () => ({
        provider: { createMessage } as never,
        providerType: "anthropic",
        modelKey: "haiku",
        modelId: "cheap-model",
      }),
    });

    const result = await judge({
      task,
      events: loopingEvents,
      runningForMs: 20 * 60_000,
      driftStrikes: 1,
    });

    expect(result).toMatchObject({
      verdict: "drifting",
      loopingOn: "npm test",
      judge: "model:anthropic/cheap-model",
    });
    const request = (createMessage.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(request.model).toBe("cheap-model");
    const prompt = JSON.stringify(request.messages);
    expect(prompt).toContain("Summarise the quarterly sales report");
    expect(prompt).toContain("loopRiskIndex");
    expect(prompt).toContain("tool_error run_command");
    expect(prompt).toContain("already nudged it 1 time");
  });

  it("falls back to the heuristic when the model fails or gives no verdict", async () => {
    const failing = createModelProgressJudge({
      resolveModel: () => ({
        provider: {
          createMessage: vi.fn(async () => {
            throw new Error("503");
          }),
        } as never,
        providerType: "openai",
        modelKey: "mini",
        modelId: "gpt-mini",
      }),
    });
    await expect(
      failing({ task, events: loopingEvents, runningForMs: 1, driftStrikes: 0 }),
    ).resolves.toMatchObject({ judge: "heuristic", verdict: "drifting" });

    const unconfigured = createModelProgressJudge({
      resolveModel: () => {
        throw new Error("No provider configured");
      },
    });
    await expect(
      unconfigured({
        task,
        events: [event("step_completed", 1)],
        runningForMs: 1,
        driftStrikes: 0,
      }),
    ).resolves.toMatchObject({ judge: "heuristic", verdict: "progressing" });
  });

  it("builds a prompt that marks the request and events as data", () => {
    const prompt = buildJudgePrompt(
      { task, events: loopingEvents, runningForMs: 16 * 60_000, driftStrikes: 0 },
      ProgressScoreEngine.assessWindow(loopingEvents),
    );
    expect(prompt).toMatch(
      /<original_request>\nSummarise the quarterly sales report\n<\/original_request>/,
    );
    expect(prompt).toContain("Running for about 16 minutes.");
    expect(prompt).toContain('<recent_events count="4">');
  });
});
