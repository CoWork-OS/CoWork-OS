import type Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../approval-policy", async (original) => ({
  ...(await original<typeof import("../approval-policy")>()),
  approvalPromptsDisabled: () => true,
}));
import { AgentDaemon } from "../daemon";
import { approvalRequestRevisionHash } from "../approval-revision";
import { ApprovalStore, InputRequestStore } from "../../database/repositories";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";

const suite = nativeSqliteAvailable ? describe : describe.skip;

/**
 * `cowork approve <id> --remote` (control plane `approval.respond`) and the other approval-queue
 * surfaces answer an inline approval through the card its tool is waiting on.
 */
suite("approval responses for an inline approval card", () => {
  let db: Database.Database, approvals: ApprovalStore, inputs: InputRequestStore;
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    db.exec(
      "CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT,type TEXT,description TEXT,details TEXT,status TEXT,requested_at INTEGER,resolved_at INTEGER,resolved_by_principal_id TEXT,resolved_by_role TEXT);CREATE TABLE input_requests(id TEXT PRIMARY KEY,task_id TEXT,questions TEXT,status TEXT,answers TEXT,requested_at INTEGER,resolved_at INTEGER);CREATE TABLE approval_input_links(input_id TEXT PRIMARY KEY,approval_id TEXT UNIQUE,task_id TEXT,revision_hash TEXT);",
    );
    approvals = new ApprovalStore(db);
    inputs = new InputRequestStore(db);
  });
  afterEach(() => db.close());

  async function waitingRunCommand() {
    const task = {
      id: "task",
      status: "executing",
      agentConfig: { accessProfileId: "ask_for_approval" },
    };
    const runtime = { recordPermissionSuccess: vi.fn(), recordPermissionDenial: vi.fn() };
    const daemon = {
      approvalRepo: approvals,
      inputRequestRepo: inputs,
      pendingApprovals: new Map(),
      pendingInputRequests: new Map(),
      taskRepo: { findById: () => task },
      requestUserInput: AgentDaemon.prototype.requestUserInput,
      requestAssistantApproval: AgentDaemon.prototype["requestAssistantApproval"],
      respondToInputRequest: AgentDaemon.prototype.respondToInputRequest,
      respondToApprovalThroughLinkedInput:
        AgentDaemon.prototype["respondToApprovalThroughLinkedInput"],
      isApprovalAuthorityCurrent: async () => true,
      evaluatePermissionRequest: async () => ({
        evaluation: {
          decision: "ask",
          reason: { type: "mode", mode: "default", summary: "Review" },
        },
        promptDetails: { scope: { kind: "tool", toolName: "run_command" } },
        trackingKey: "exact",
        authorizationKey: "exact",
        runtime,
      }),
      persistApprovalActionRule: vi.fn(),
      resumeTaskAfterDurableWait: vi.fn(),
      logEvent: vi.fn(),
      updateTask: (_id: string, patch: Any) => Object.assign(task, patch),
    } as Any;
    const result = AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task",
      "run_command",
      "Run git status",
      { tool: "run_command", command: "git status" },
      { allowAutoApprove: false },
    );
    let settled = false;
    void result.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(daemon.pendingInputRequests.size).toBe(1));
    const input = inputs.findAllPending()[0];
    const approval = approvals.findById(inputs.getApprovalBinding(input.id)!.approvalId)!;
    const respond = (approved: boolean, revisionHash = approvalRequestRevisionHash(approval)) =>
      AgentDaemon.prototype.respondToApproval.call(
        daemon,
        approval.id,
        approved,
        undefined,
        undefined,
        revisionHash,
      );
    const loggedTypes = () => daemon.logEvent.mock.calls.map((call: Any[]) => call[1]);
    const recovered = () =>
      daemon.logEvent.mock.calls.some((call: Any[]) => call[2]?.recoveredAfterRestart);
    return {
      daemon,
      runtime,
      result,
      input,
      approval,
      respond,
      loggedTypes,
      recovered,
      settled: () => settled,
    };
  }

  it.each([true, false])(
    "a remote decision resolves the live waiting tool (approve=%s)",
    async (approve) => {
      const f = await waitingRunCommand();
      expect(approvals.findById(f.approval.id)?.status).toBe("pending");

      expect(await f.respond(approve)).toBe("handled");
      expect(await f.result).toBe(approve);

      expect(inputs.findById(f.input.id)).toMatchObject({
        status: "submitted",
        answers: { approval_decision: { optionLabel: approve ? "Allow once" : "Deny" } },
      });
      expect(approvals.findById(f.approval.id)?.status).toBe(approve ? "approved" : "denied");
      expect(f.runtime.recordPermissionSuccess).toHaveBeenCalledTimes(approve ? 1 : 0);
      expect(f.loggedTypes()).toEqual(
        expect.arrayContaining([
          "input_request_resolved",
          approve ? "approval_granted" : "approval_denied",
        ]),
      );
      expect(f.daemon.logEvent).toHaveBeenCalledWith("task", "log", {
        type: "approval_response",
        approvalId: f.approval.id,
        requestId: f.input.id,
        action: approve ? "allow_once" : "deny_once",
        answer: approve ? "Allow once" : "Deny",
      });
      // Never the restart-recovery grant that left the tool waiting until its timeout.
      expect(f.recovered()).toBe(false);
      expect(f.daemon.persistApprovalActionRule).not.toHaveBeenCalled();
      expect(f.daemon.resumeTaskAfterDurableWait).not.toHaveBeenCalled();
      // The decision is final: a repeated response changes nothing.
      expect(await f.respond(!approve)).toBe("not_found");
      expect(approvals.findById(f.approval.id)?.status).toBe(approve ? "approved" : "denied");
    },
  );

  it("refuses a stale revision hash and keeps the tool waiting for a current answer", async () => {
    const f = await waitingRunCommand();

    expect(await f.respond(true, "0".repeat(64))).toBe("not_found");
    await Promise.resolve();
    expect(f.settled()).toBe(false);
    expect(f.daemon.pendingInputRequests.size).toBe(1);
    expect(inputs.findById(f.input.id)?.status).toBe("pending");
    expect(approvals.findById(f.approval.id)?.status).toBe("pending");
    expect(f.loggedTypes()).not.toContain("approval_granted");

    expect(await f.respond(true)).toBe("handled");
    expect(await f.result).toBe(true);
  });

  it("refuses a revised approval even with the hash shown before the revision", async () => {
    const f = await waitingRunCommand();
    db.prepare("UPDATE approvals SET description='Run something else' WHERE id=?").run(
      f.approval.id,
    );

    expect(await f.respond(true)).toBe("not_found");
    expect(inputs.findById(f.input.id)?.status).toBe("pending");
    expect(f.recovered()).toBe(false);
    expect(f.daemon.pendingInputRequests.size).toBe(1);
  });

  it("refuses once the card was answered in the app, without a second grant", async () => {
    const f = await waitingRunCommand();
    await AgentDaemon.prototype.respondToInputRequest.call(f.daemon, {
      requestId: f.input.id,
      status: "submitted",
      answers: { approval_decision: { optionLabel: "Deny" } },
    });

    expect(await f.respond(true)).toBe("not_found");
    expect(await f.result).toBe(false);
    expect(approvals.findById(f.approval.id)?.status).toBe("denied");
    expect(f.recovered()).toBe(false);
    expect(f.daemon.persistApprovalActionRule).not.toHaveBeenCalled();
  });

  it("does not grant a card whose waiter is gone", async () => {
    const f = await waitingRunCommand();
    f.daemon.pendingInputRequests.clear();

    expect(await f.respond(true)).toBe("not_found");
    expect(approvals.findById(f.approval.id)?.status).toBe("pending");
    expect(inputs.findById(f.input.id)?.status).toBe("pending");
    expect(f.recovered()).toBe(false);
    expect(f.daemon.resumeTaskAfterDurableWait).not.toHaveBeenCalled();
  });

  it("does not let a channel answer a card it never displayed", async () => {
    const f = await waitingRunCommand();

    expect(
      await AgentDaemon.prototype.respondToApproval.call(
        f.daemon,
        f.approval.id,
        true,
        undefined,
        undefined,
        approvalRequestRevisionHash(f.approval),
        { channelId: "channel", decisionId: "decision" } as Any,
      ),
    ).toBe("not_found");
    expect(inputs.findById(f.input.id)?.status).toBe("pending");
    expect(approvals.findById(f.approval.id)?.status).toBe("pending");
  });
});
