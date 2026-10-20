import { describe, expect, it, vi } from "vitest";
import { PrincipalCapabilityMiddleware } from "../PrincipalCapabilityMiddleware";
import type { SessionMembershipService } from "../../workspaces/workspaces-repository-facades";

function createMiddleware() {
  const authorizeTaskAction = vi.fn(async (taskId: string) => {
    if (taskId.startsWith("visible")) {
      return { contextId: "context-1", actor: { principalId: "guest-1", role: "viewer" } };
    }
    throw new Error("Principal is not a member");
  });
  const memberships = {
    getLocalPrincipal: () => ({ principalId: "local-1", displayName: "Local" }),
    authorizeTaskAction,
  } as unknown as SessionMembershipService;
  const middleware = new PrincipalCapabilityMiddleware({} as never, memberships);
  return { middleware, authorizeTaskAction };
}

describe("PrincipalCapabilityMiddleware", () => {
  it("filters before applying the requested offset and reports visible totals", async () => {
    const { middleware, authorizeTaskAction } = createMiddleware();
    const rows = [{ id: "hidden-1" }, { id: "visible-1" }, { id: "hidden-2" }, { id: "visible-2" }];
    const loadPage = vi.fn((_: number, offset: number) => (offset === 0 ? rows : []));

    const result = await middleware.filterAndPaginateTasks(loadPage, "view", "guest-1", 1, 1);

    expect(result).toEqual({ tasks: [{ id: "visible-2" }], total: 2 });
    expect(authorizeTaskAction).toHaveBeenCalledTimes(4);
  });

  it("keeps the local-owner fast path on the repository page", async () => {
    const { middleware } = createMiddleware();
    const loadPage = vi.fn(() => [{ id: "task-1" }]);

    const result = await middleware.filterAndPaginateTasks(loadPage, "view", "local-1", 25, 10);

    expect(result).toEqual({ tasks: [{ id: "task-1" }] });
    expect(loadPage).toHaveBeenCalledWith(25, 10);
  });

  it("awaits an asynchronous page loader for the local owner", async () => {
    const { middleware, authorizeTaskAction } = createMiddleware();
    const loadPage = vi.fn(async () => [{ id: "owner-task" }]);
    await expect(
      middleware.filterAndPaginateTasks(loadPage, "view", "local-1", 2, 5),
    ).resolves.toEqual({ tasks: [{ id: "owner-task" }] });
    expect(loadPage).toHaveBeenCalledWith(2, 5);
    expect(authorizeTaskAction).not.toHaveBeenCalled();
  });

  it("continues across hidden asynchronous pages before applying the visible offset", async () => {
    const { middleware } = createMiddleware();
    const rows = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `hidden-${i}` })),
      { id: "visible-1" },
      { id: "visible-2" },
      { id: "visible-3" },
    ];
    const loadPage = vi.fn(async (limit: number, offset: number) =>
      rows.slice(offset, offset + limit),
    );
    await expect(
      middleware.filterAndPaginateTasks(loadPage, "view", "guest-1", 1, 1),
    ).resolves.toEqual({ tasks: [{ id: "visible-2" }], total: 3 });
    expect(loadPage).toHaveBeenCalledWith(100, 100);
  });

  it("preserves local missing-task reads without authorizing a nonexistent task", async () => {
    const { middleware, authorizeTaskAction } = createMiddleware();
    await expect(middleware.authorizeTaskRead("missing", "local-1")).resolves.toBeUndefined();
    expect(authorizeTaskAction).not.toHaveBeenCalled();
  });

  it("scans beyond a full 500-row hidden page", async () => {
    const { middleware } = createMiddleware();
    const rows = [
      ...Array.from({ length: 500 }, (_, i) => ({ id: `hidden-${i}` })),
      { id: "visible-1" },
      { id: "visible-2" },
    ];
    const loadPage = vi.fn(async (limit: number, offset: number) =>
      rows.slice(offset, offset + limit),
    );
    const result = await middleware.filterAndPaginateTasks(loadPage, "view", "guest-1", 501, 1);
    expect(result.tasks).toEqual([{ id: "visible-2" }]);
    expect(loadPage).toHaveBeenCalledWith(500, 500);
  });

  it("propagates asynchronous loader failures", async () => {
    const { middleware } = createMiddleware();
    await expect(
      middleware.filterAndPaginateTasks(
        async () => {
          throw new Error("storage unavailable");
        },
        "view",
        "guest-1",
        1,
        0,
      ),
    ).rejects.toThrow("storage unavailable");
  });

  it("awaits guest denials before a task read can proceed", async () => {
    const { middleware, authorizeTaskAction } = createMiddleware();
    authorizeTaskAction.mockImplementation(async () => {
      throw new Error("Revoked membership");
    });
    await expect(middleware.authorizeTaskRead("visible-1", "guest-1")).rejects.toThrow(
      "Revoked membership",
    );
  });
});
