import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

// The fixtures stub TaskRepository; keep the persisted-policy read out of their way.
beforeEach(() =>
  vi.spyOn(AgentDaemon.prototype, "getDatabase").mockReturnValue({
    prepare: () => ({ get: () => undefined }),
    transaction: (run: () => unknown) => Object.assign(run, { deferred: run, immediate: run }),
  } as unknown as ReturnType<AgentDaemon["getDatabase"]>),
);
afterEach(() => vi.restoreAllMocks());

const RULE_REQUEST = "Add a behavioral rule: always answer in French.";
/** queueFollowUp's positional textProvenance argument. */
const QUEUED_PROVENANCE_ARG = 14;

function createDaemon(options: { busy: boolean; openAnnotations?: Any[] }) {
  const task = {
    id: "850e8400-e29b-41d4-a716-446655440000",
    title: "Fix the parser",
    prompt: "Fix it.",
    workspaceId: "workspace-1",
    agentConfig: {},
  };
  const workspace = {
    id: "workspace-1",
    name: "Workspace",
    path: "/tmp/workspace",
    permissions: { read: true, write: true, delete: false, network: false, shell: false },
    createdAt: Date.now(),
  };
  const executor = {
    isRunning: options.busy,
    updateTaskAgentConfig: vi.fn(),
    updateWorkspace: vi.fn(),
    queueFollowUp: vi.fn(),
    suppressNextUserMessageEvent: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
  const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
    activeTasks: new Map([[task.id, { executor, lastAccessed: 0, status: "active" }]]),
    taskRepo: { findById: vi.fn().mockReturnValue(task), update: vi.fn(), touch: vi.fn() },
    workspaceRepo: { findById: vi.fn().mockReturnValue(workspace) },
    annotationRepo: {
      listOpenByTask: vi.fn().mockResolvedValue(options.openAnnotations ?? []),
      markAddressing: vi.fn().mockResolvedValue(options.openAnnotations?.length ?? 0),
    },
    setTransientTaskAgentConfig: vi.fn(),
    clearTransientTaskAgentConfig: vi.fn(),
    getEffectiveWorkspaceForTask: vi.fn().mockReturnValue(workspace),
    processOrphanedFollowUps: vi.fn(),
    logEvent: vi.fn(),
  });
  const send = (message: string, followUpOptions?: Any) =>
    AgentDaemon.prototype.sendMessage.call(
      daemon,
      task.id,
      message,
      undefined,
      undefined,
      followUpOptions,
    );
  return { daemon, executor, send };
}

describe("AgentDaemon follow-up text provenance", () => {
  it("hands the executor the user's provenance and typed words", async () => {
    const { executor, send } = createDaemon({ busy: false });
    await send(RULE_REQUEST, { textProvenance: "user_typed" });
    expect(executor.sendMessage.mock.calls[0][3]).toMatchObject({
      textProvenance: "user_typed",
      typedText: RULE_REQUEST,
    });
  });

  it("adds no provenance to an injected follow-up", async () => {
    // How cron, triggers, routines, webhooks and canvas actions call sendMessage.
    const { executor, send } = createDaemon({ busy: false });
    await send(RULE_REQUEST);
    expect(executor.sendMessage.mock.calls[0][3].textProvenance).toBeUndefined();

    const busy = createDaemon({ busy: true });
    await busy.send(RULE_REQUEST, { agentConfigOverride: { allowUserInput: false } });
    expect(busy.executor.queueFollowUp.mock.calls[0][QUEUED_PROVENANCE_ARG]).toBeUndefined();
  });

  it("keeps the provenance on a follow-up queued behind a running turn", async () => {
    const { executor, send } = createDaemon({ busy: true });
    await send(RULE_REQUEST, { textProvenance: "user_typed" });
    expect(executor.queueFollowUp.mock.calls[0][0]).toBe(RULE_REQUEST);
    expect(executor.queueFollowUp.mock.calls[0][QUEUED_PROVENANCE_ARG]).toBe("user_typed");
  });

  it("separates the typed words from annotation context the user did not type", async () => {
    const annotation = {
      id: "annotation-1",
      surfaceType: "web",
      status: "open",
      body: "Fix this heading",
      targetRef: { textQuote: "Edit my behavioral rules" },
    };
    const idle = createDaemon({ busy: false, openAnnotations: [annotation] });
    await idle.send("Fix the heading.", { textProvenance: "user_typed" });
    const [sentMessage, , , sentOptions] = idle.executor.sendMessage.mock.calls[0];
    expect(sentMessage).toContain("Edit my behavioral rules");
    expect(sentOptions).toMatchObject({
      textProvenance: "user_typed",
      typedText: "Fix the heading.",
    });

    // A queued item keeps only the combined text, so it loses the user's provenance.
    const busy = createDaemon({ busy: true, openAnnotations: [annotation] });
    await busy.send("Fix the heading.", { textProvenance: "user_typed" });
    expect(busy.executor.queueFollowUp.mock.calls[0][0]).toContain("Edit my behavioral rules");
    expect(busy.executor.queueFollowUp.mock.calls[0][QUEUED_PROVENANCE_ARG]).toBeUndefined();
  });

  it("passes a queued item's provenance on when the queue drains after the turn", async () => {
    const queue = [
      { message: RULE_REQUEST, textProvenance: "user_typed" },
      { message: "Heartbeat: check the inbox." },
    ];
    const executor = {
      isRunning: false,
      takeNextFollowUpAtTurnBoundary: () => queue.shift(),
      suppressNextUserMessageEvent: vi.fn(),
    };
    const daemon = Object.create(AgentDaemon.prototype) as Any;
    daemon.drainingFollowUps = new Set();
    daemon.logEvent = vi.fn();
    daemon.sendMessage = vi.fn().mockResolvedValue({ queued: false });
    daemon.processOrphanedFollowUps("task", executor);
    await vi.waitFor(() => expect(daemon.sendMessage).toHaveBeenCalledTimes(2));
    expect(daemon.sendMessage.mock.calls[0][4].textProvenance).toBe("user_typed");
    expect(daemon.sendMessage.mock.calls[1][4].textProvenance).toBeUndefined();
  });
});
