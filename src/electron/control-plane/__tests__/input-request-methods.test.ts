import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDaemon } from "../../agent/daemon";
import { DatabaseManager } from "../../database/schema";
import type { ControlPlaneServer } from "../server";
import { ErrorCodes, Methods } from "../protocol";
import { registerTaskAndWorkspaceMethods } from "../handlers";

type RegisteredMethod = (
  client: { hasScope(scope: string): boolean },
  params?: unknown,
) => Promise<unknown>;

describe("Control Plane structured input methods", () => {
  let tempDir: string;
  let manager: DatabaseManager;
  let methods: Map<string, RegisteredMethod>;
  const admin = { hasScope: (scope: string) => scope === "admin" };
  const reader = { hasScope: (scope: string) => scope === "read" };
  const requestId = "492efedb-4aa1-4bf2-8e72-5d6268c86e8f";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-control-input-"));
    manager = new DatabaseManager({ dbPath: path.join(tempDir, "test.db") });
    methods = new Map();
  });

  afterEach(() => {
    manager?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function register(agentDaemon: Record<string, unknown>) {
    registerTaskAndWorkspaceMethods(
      {
        registerMethod: (method: string, handler: RegisteredMethod) => methods.set(method, handler),
      } as unknown as ControlPlaneServer,
      {
        agentDaemon: {
          ...agentDaemon,
          getWorkSessionReliabilityService: () => ({}),
        } as unknown as AgentDaemon,
        dbManager: { getDatabase: () => manager.getDatabase() } as never,
      },
    );
  }

  it("registers advertised listing with bounded pagination and task/status filters", async () => {
    const inputRequests = [{ id: requestId, status: "pending" }];
    const listInputRequests = vi.fn().mockResolvedValue(inputRequests);
    register({ listInputRequests });

    await expect(
      methods.get(Methods.INPUT_REQUEST_LIST)!(admin, {
        taskId: " task-1 ",
        status: " pending ",
        limit: 1000.9,
        offset: -2,
      }),
    ).resolves.toEqual({ inputRequests });
    expect(listInputRequests).toHaveBeenCalledWith({
      taskId: "task-1",
      status: "pending",
      limit: 500,
      offset: 0,
    });
  });

  it("requires admin scope for both listing and response", async () => {
    const listInputRequests = vi.fn();
    const respondToInputRequest = vi.fn();
    register({ listInputRequests, respondToInputRequest });

    for (const method of [Methods.INPUT_REQUEST_LIST, Methods.INPUT_REQUEST_RESPOND]) {
      await expect(methods.get(method)!(reader, {})).rejects.toMatchObject({
        code: ErrorCodes.UNAUTHORIZED,
      });
    }
    expect(listInputRequests).not.toHaveBeenCalled();
    expect(respondToInputRequest).not.toHaveBeenCalled();
  });

  it.each(["handled", "duplicate", "not_found", "in_progress"])(
    "delegates validated responses to daemon revision/idempotency handling and returns %s",
    async (status) => {
      const result = { status, requestId };
      const respondToInputRequest = vi.fn().mockResolvedValue(result);
      register({ respondToInputRequest });
      const response = {
        requestId,
        status: "submitted",
        answers: { shell_access: { optionLabel: "Continue without shell" } },
      };

      await expect(methods.get(Methods.INPUT_REQUEST_RESPOND)!(admin, response)).resolves.toEqual(
        result,
      );
      expect(respondToInputRequest).toHaveBeenCalledExactlyOnceWith(response);
    },
  );

  it.each([
    null,
    { requestId: "not-a-uuid", status: "submitted" },
    { requestId, status: "approved" },
    { requestId, status: "submitted", answers: { "invalid-key": { optionLabel: "Allow" } } },
    { requestId, status: "submitted", answers: { decision: { optionLabel: "" } } },
  ])("rejects malformed responses before calling the daemon: %j", async (response) => {
    const respondToInputRequest = vi.fn();
    register({ respondToInputRequest });

    await expect(
      methods.get(Methods.INPUT_REQUEST_RESPOND)!(admin, response),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    expect(respondToInputRequest).not.toHaveBeenCalled();
  });
});
