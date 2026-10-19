import { describe, expect, it, vi } from "vitest";
import { Methods } from "../protocol";
import { registerWorkSessionMethods } from "../registerWorkSessionMethods";

function setup(contractResult: unknown) {
  const handlers = new Map<string, (client: unknown, params: unknown) => Promise<Any>>();
  const requireScope = vi.fn();
  registerWorkSessionMethods({
    server: { registerMethod: (name: string, handler: Any) => handlers.set(name, handler) } as Any,
    db: {} as Any,
    agentDaemon: {
      getWorkSessionReliabilityService: () => ({}),
      getWorkSessionContractService: () => ({ getForTask: vi.fn(() => contractResult) }),
    } as Any,
    requireScope,
  });
  return {
    requireScope,
    call: (params: unknown) => handlers.get(Methods.WORK_SESSION_CONTRACT_GET)!({}, params),
  };
}

describe("workSession.contract.get", () => {
  it("returns requirements and open waits only, with secrets redacted", async () => {
    const { call, requireScope } = setup({
      contract: {
        requirements: [
          {
            id: "r1",
            description: "Upload with token sk-live-abcdefghijklmnopqrstuvwx",
            status: "pending",
            required: true,
            evidenceIds: ["e1"],
          },
        ],
      },
      aggregate: {
        waitStates: [
          { kind: "approval", reason: "Approve the upload", status: "pending" },
          { kind: "input", reason: "Old question", status: "resolved" },
        ],
      },
    });
    const result = await call({ taskId: "task-1" });
    expect(requireScope).toHaveBeenCalledWith(expect.anything(), "read");
    expect(result).toEqual({
      taskId: "task-1",
      requirements: [{ id: "r1", description: "[redacted]", status: "pending", required: true }],
      pendingWaits: [{ kind: "approval", reason: "Approve the upload" }],
    });
  });

  it("returns empty lists for a task without a contract, and refuses a missing id", async () => {
    const { call } = setup(undefined);
    expect(await call({ taskId: "task-2" })).toEqual({
      taskId: "task-2",
      requirements: [],
      pendingWaits: [],
    });
    await expect(call({})).rejects.toMatchObject({ message: "taskId is invalid" });
  });
});
