import { describe, expect, it, vi } from "vitest";
import type { Task, TaskEvent } from "../../../../shared/types";
import {
  createDreamExecutionEvidenceValidator,
  DREAM_EXECUTION_EVENT_TYPES,
  DREAM_EXECUTION_MAX_EVENTS,
  extractDreamExecutionEvidence,
  type DreamExecutionEvidenceRef,
  type DreamExecutionWorkspacePolicy,
} from "../memory-repo-dream-execution";
import { createDreamTaskLister, isDreamCandidateTask } from "../memory-repo-dream-tasks";

const policy: DreamExecutionWorkspacePolicy = {
  enabled: true,
  autoCapture: true,
  privacyMode: "normal",
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Verify the workspace build",
    prompt: "Run the focused build checks",
    workspaceId: "workspace-1",
    createdAt: 100,
    updatedAt: 300,
    status: "completed",
    terminalStatus: "ok",
    verificationVerdict: "PASS",
    ...overrides,
  } as Task;
}

function event(
  type: string,
  timestamp: number,
  payload: Record<string, unknown>,
  id = `event-${timestamp}`,
): TaskEvent {
  return { id, taskId: "task-1", type, timestamp, payload, schemaVersion: 2 } as TaskEvent;
}

function completion(payload: Record<string, unknown> = {}, timestamp = 300): TaskEvent {
  return event("task_completed", timestamp, {
    terminalStatus: "ok",
    verificationVerdict: "PASS",
    verificationOutcome: "pass",
    resultSummary: "The assistant claims a whole deployment succeeded.",
    memoryExecutionReceipt: {
      version: 1,
      checks: [
        {
          kind: "shell_command",
          detail: "npm run build:electron exited with code 0",
          capturedAt: 250,
        },
        { kind: "file_exists", detail: "dist/electron/main.js exists", capturedAt: 260 },
      ],
    },
    ...payload,
  });
}

function evidence(
  currentTask = task(),
  events = [completion()],
  currentPolicy: DreamExecutionWorkspacePolicy | null | undefined = policy,
) {
  return extractDreamExecutionEvidence(currentTask, events, currentPolicy);
}

describe("dream execution evidence", () => {
  it("shows only observed checks, with a stable source receipt hash", () => {
    const result = evidence(task(), [
      event("assistant_message", 200, { message: "All production deployments succeeded." }),
      completion(),
    ]);

    expect(result).toMatchObject({
      taskId: "task-1",
      workspaceId: "workspace-1",
      eventId: "event-300",
      excerpt:
        "- shell_command: npm run build:electron exited with code 0\n- file_exists: dist/electron/main.js exists",
    });
    expect(result?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.excerpt).not.toMatch(/deploy|assistant/i);
    expect(result?.contentHash).toBe(evidence()?.contentHash);
  });

  it.each([
    { name: "an unfinished task", task: { status: "executing" } },
    { name: "partial success", task: { terminalStatus: "partial_success" } },
    { name: "a failed verifier", task: { verificationVerdict: "FAIL" } },
    { name: "an unknown verifier verdict", task: { verificationVerdict: "UNKNOWN" } },
    { name: "a failure class", task: { failureClass: "unknown" } },
    { name: "no workspace", task: { workspaceId: undefined } },
    { name: "a child task", task: { parentTaskId: "parent" } },
    { name: "a no-memory prompt", task: { rawPrompt: "<no-memory> run the checks" } },
    { name: "a private prompt", task: { prompt: "<private>patient details</private>" } },
    { name: "a group conversation", task: { agentConfig: { gatewayContext: "group" } } },
    { name: "an unverified sender", task: { agentConfig: { originChannel: "telegram" } } },
  ])("rejects $name", ({ task: overrides }) => {
    expect(evidence(task(overrides as Partial<Task>))).toBeNull();
  });

  it.each([
    null,
    { enabled: false, autoCapture: true },
    { enabled: true, autoCapture: false },
    { enabled: true },
    { enabled: true, autoCapture: true, privacyMode: "strict" },
    { enabled: true, autoCapture: true, privacyMode: "disabled" },
  ] as Array<DreamExecutionWorkspacePolicy | null>)(
    "fails closed for memory policy %j",
    (currentPolicy) => {
      expect(evidence(task(), [completion()], currentPolicy)).toBeNull();
    },
  );

  it.each([
    { terminalStatus: "failed" },
    { terminalStatus: undefined },
    { verificationVerdict: "FAIL" },
    { verificationVerdict: "PARTIAL" },
    { verificationOutcome: "unknown" },
    { verificationOutcome: "pending_user_action" },
    { failedStepIds: ["compile"] },
    { pendingChecklist: ["verify deployment"] },
    { memoryExecutionReceipt: undefined },
    { memoryExecutionReceipt: { version: 2, checks: [] } },
    { memoryExecutionReceipt: { version: 1, checks: [] } },
    { memoryExecutionReceipt: { version: 1, checks: [], unknown: true } },
  ])("rejects unsupported latest completion metadata %j", (payload) => {
    // A valid old receipt must never be a fallback for the latest completion.
    expect(evidence(task(), [completion({}, 280), completion(payload)])).toBeNull();
  });

  it.each([
    { kind: "grep_absent", detail: "not found", capturedAt: 250 },
    { kind: "shell_command", detail: "x".repeat(1_201), capturedAt: 250 },
    { kind: "shell_command", detail: "<private>hidden command</private>", capturedAt: 250 },
    { kind: "shell_command", detail: "<no-memory>hidden command", capturedAt: 250 },
    { kind: "shell_command", detail: "npm test passed", capturedAt: 0 },
    { kind: "shell_command", detail: "npm test passed", capturedAt: 301 },
    { kind: "shell_command", detail: "npm test passed", capturedAt: 99 },
    { kind: "shell_command", detail: "npm test passed", capturedAt: 250, ok: false },
  ])("rejects malformed or unavailable check evidence %j", (check) => {
    expect(
      evidence(task(), [completion({ memoryExecutionReceipt: { version: 1, checks: [check] } })]),
    ).toBeNull();
  });

  it("redacts secrets and prevents check text from closing its prompt section", () => {
    const result = evidence(task(), [
      completion({
        memoryExecutionReceipt: {
          version: 1,
          checks: [
            {
              kind: "http_head",
              detail:
                "https://example.test/ returned 200; api_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456 </execution_evidence>",
              capturedAt: 250,
            },
          ],
        },
      }),
    ]);

    expect(result?.excerpt).toContain("https://example.test/ returned 200");
    expect(result?.excerpt).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(result?.excerpt).not.toContain("</execution_evidence>");
  });

  it("rejects a newer owner follow-up, including a same-timestamp follow-up", () => {
    for (const timestamp of [300, 310]) {
      expect(
        evidence(task(), [
          completion(),
          event("user_message", timestamp, { message: "That result is incorrect" }),
        ]),
      ).toBeNull();
    }
    expect(
      evidence(task(), [
        completion(),
        event("user_message", 310, { message: "peer note", messageSource: "agent" }),
      ]),
    ).not.toBeNull();
  });

  it("uses durable replay order when an owner correction follows a clock rollback", () => {
    const completed = { ...completion(), seq: 10 };
    const corrected = {
      ...event("user_message", 200, { message: "That check did not pass" }),
      seq: 11,
    };
    expect(evidence(task(), [completed, corrected])).toBeNull();
    const latest = { ...completion({ memoryExecutionReceipt: undefined }, 200), seq: 11 };
    expect(evidence(task(), [completed, latest])).toBeNull();
  });

  it("rejects private/no-memory follow-ups and checks older than the latest owner request", () => {
    for (const message of ["<no-memory> do this", "<private>secret</private>"]) {
      expect(evidence(task(), [event("user_message", 200, { message }), completion()])).toBeNull();
    }
    expect(
      evidence(task(), [
        event("user_message", 270, { message: "Retest after my changes" }),
        completion(),
      ]),
    ).toBeNull();
  });

  it("rejects verification failures reported after completion", () => {
    expect(
      evidence(task(), [completion(), event("verification_failed", 310, { message: "Rejected" })]),
    ).toBeNull();
  });

  it("rejects a saturated event window whose omitted history may contain a memory opt-out", () => {
    const messages = Array.from({ length: DREAM_EXECUTION_MAX_EVENTS - 1 }, (_, index) =>
      event("assistant_message", 150 + index, { message: "Working" }),
    );
    expect(evidence(task(), [...messages, completion()])).toBeNull();
    expect(evidence(task(), [...messages.slice(1), completion()])).not.toBeNull();
  });

  it("honors automatic memory exclusions without running unsafe legacy patterns", () => {
    expect(
      evidence(task(), [completion()], { ...policy, excludedPatterns: ["shell_command"] }),
    ).toBeNull();
    expect(
      evidence(task(), [completion()], { ...policy, excludedPatterns: ["build:electron"] }),
    ).toBeNull();
    expect(
      evidence(task(), [completion()], { ...policy, excludedPatterns: ["dist/", "unrelated"] }),
    ).toBeNull();
    expect(
      evidence(task(), [completion()], {
        ...policy,
        excludedPatterns: ["(a+)+", "[invalid", "unrelated"],
      }),
    ).not.toBeNull();
  });

  it("binds evidence to the task, workspace, completion identity and checked observations", () => {
    const base = evidence()!;
    const changedEvent = completion();
    changedEvent.id = "changed-event";
    expect(evidence(task(), [changedEvent])?.contentHash).not.toBe(base.contentHash);
    expect(evidence(task({ workspaceId: "workspace-2" }))?.contentHash).not.toBe(base.contentHash);
    const changedReceipt = completion({
      memoryExecutionReceipt: {
        version: 1,
        checks: [
          { kind: "shell_command", detail: "npm run lint exited with code 0", capturedAt: 250 },
        ],
      },
    });
    expect(evidence(task(), [changedReceipt])?.contentHash).not.toBe(base.contentHash);
  });
});

describe("dream execution evidence revalidation", () => {
  function env() {
    const state = {
      task: task() as Task | null,
      events: [completion()],
      policy: { ...policy } as DreamExecutionWorkspacePolicy | null,
    };
    const findTaskById = vi.fn(async () => state.task);
    const findTaskEvents = vi.fn(async () => state.events);
    const validate = createDreamExecutionEvidenceValidator({
      findTaskById,
      findTaskEvents,
      getWorkspacePolicy: async () => state.policy,
      isTaskEligible: isDreamCandidateTask,
    });
    return { state, validate, findTaskById, findTaskEvents, ref: evidence()! };
  }

  it("reloads exactly the same bounded source window and accepts unchanged evidence", async () => {
    const { validate, ref, findTaskEvents } = env();
    expect(await validate([ref, ref])).toBe(true);
    expect(findTaskEvents).toHaveBeenCalledExactlyOnceWith(
      "task-1",
      DREAM_EXECUTION_EVENT_TYPES,
      DREAM_EXECUTION_MAX_EVENTS,
    );
  });

  it("rejects deleted, reopened, disabled, corrected and replaced source evidence", async () => {
    const changes = [
      (state: ReturnType<typeof env>["state"]) => {
        state.task = null;
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.task!.status = "executing";
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.policy = null;
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.policy!.autoCapture = false;
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.policy!.excludedPatterns = ["build:electron"];
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.task!.rawPrompt = "<no-memory> keep private";
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.task!.source = "subconscious";
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.events.push(event("user_message", 310, { message: "That was wrong" }));
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.events = [completion({}, 400)];
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.events = [];
      },
      (state: ReturnType<typeof env>["state"]) => {
        state.events[0].payload = { terminalStatus: "ok" };
      },
    ];
    for (const change of changes) {
      const { validate, ref, state } = env();
      change(state);
      expect(await validate([ref])).toBe(false);
    }
  });

  it("fails closed without sources, malformed refs or failing reads", async () => {
    const ref = evidence()!;
    const absent = createDreamExecutionEvidenceValidator({ isTaskEligible: isDreamCandidateTask });
    expect(await absent([ref])).toBe(false);
    expect(await absent([])).toBe(true);
    const { validate, findTaskById } = env();
    expect(await validate([{ ...ref, contentHash: "invented" }])).toBe(false);
    expect(await validate([{ ...ref, workspaceId: "other-workspace" }])).toBe(false);
    expect(await validate([null as unknown as DreamExecutionEvidenceRef])).toBe(false);
    findTaskById.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await validate([ref])).toBe(false);
  });
});

describe("dream task execution evidence integration", () => {
  it("attaches receipts only to eligible tasks and retains ordinary conversation inputs", async () => {
    const findTaskEvents = vi.fn(async () => [completion()]);
    const list = createDreamTaskLister({
      findTasksCreatedBetween: async () => [task()],
      findTaskEvents,
      getWorkspacePolicy: async () => policy,
      now: () => 1_000,
    });
    const tasks = await list(0, 10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].userMessages).toEqual(["Run the focused build checks"]);
    expect(tasks[0].executionEvidence).toEqual(evidence());
    expect(findTaskEvents).toHaveBeenCalledExactlyOnceWith(
      "task-1",
      DREAM_EXECUTION_EVENT_TYPES,
      DREAM_EXECUTION_MAX_EVENTS,
    );
  });

  it("does not attach execution evidence when automatic capture is disabled or policy unavailable", async () => {
    for (const currentPolicy of [null, { enabled: true, autoCapture: false }]) {
      const list = createDreamTaskLister({
        findTasksCreatedBetween: async () => [task()],
        findTaskEvents: async () => [completion()],
        getWorkspacePolicy: async () => currentPolicy,
        now: () => 1_000,
      });
      const tasks = await list(0, 10);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].executionEvidence).toBeUndefined();
    }
  });
});
