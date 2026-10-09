import { describe, expect, it, vi } from "vitest";
import { DaemonPactHost, networkContextOf, type PactDaemonLike } from "../daemon-host";

function daemonLike(overrides: Partial<PactDaemonLike> = {}): PactDaemonLike {
  return {
    requestApproval: vi.fn(async () => true),
    openPactAuthorizationWait: vi.fn(async () => "input-1"),
    settlePactAuthorizationWait: vi.fn(async () => undefined),
    logEvent: vi.fn(),
    isTaskWaitingForInput: vi.fn(async () => true),
    getWorkspaceForPact: vi.fn(() => undefined),
    getEffectiveWorkspaceForTask: vi.fn(() => undefined),
    ...overrides,
  };
}

describe("DaemonPactHost", () => {
  it("asks for an explicit, one-time approval with no standing or automatic approval", async () => {
    const daemon = daemonLike();
    const host = new DaemonPactHost(daemon);
    await host.requestLocalApproval("task-1", "Send a change", {}, { requireExplicit: true });
    await host.requestLocalApproval("task-1", "Ask a question", {}, { requireExplicit: false });
    expect(daemon.requestApproval).toHaveBeenNthCalledWith(
      1,
      "task-1",
      "external_service",
      "Send a change",
      {},
      { requireExplicitApproval: true, allowAutoApprove: false, noStandingApproval: true },
    );
    expect(daemon.requestApproval).toHaveBeenNthCalledWith(
      2,
      "task-1",
      "external_service",
      "Ask a question",
      {},
      { requireExplicitApproval: false, allowAutoApprove: true, noStandingApproval: false },
    );
  });

  it("resolves a resumed wait's rules from its task, and nothing when the task is gone", async () => {
    const taskWorkspace = {
      id: "ws-1",
      path: "/tmp/ws-1",
      permissions: { network: true, accessDomainRules: [{ pattern: "**.shop.example" }] },
    } as never;
    const daemon = daemonLike({
      getEffectiveWorkspaceForTask: vi.fn((taskId: string) =>
        taskId === "task-1" ? taskWorkspace : undefined,
      ),
    });
    const host = new DaemonPactHost(daemon);
    await expect(host.networkContextForWorkspace("ws-1", "task-1")).resolves.toEqual(
      networkContextOf(taskWorkspace),
    );
    expect(daemon.getWorkspaceForPact).not.toHaveBeenCalled();
    await expect(host.networkContextForWorkspace("ws-1", "task-gone")).resolves.toBeNull();
  });

  it("treats a workspace without permissions as having no network", () => {
    expect(networkContextOf({ id: "ws", path: "/tmp/ws" } as never)?.networkEnabled).toBe(false);
  });
});
