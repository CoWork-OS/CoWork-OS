import { describe, expect, it, vi } from "vitest";
import { PrincipalCapabilityMiddleware } from "../PrincipalCapabilityMiddleware";
import type { SessionMembershipService } from "../../workspaces/SessionMembershipService";

function createMiddleware() {
  const authorizeTaskAction = vi.fn((taskId: string) => {
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
  it("filters before applying the requested offset and reports visible totals", () => {
    const { middleware, authorizeTaskAction } = createMiddleware();
    const rows = [{ id: "hidden-1" }, { id: "visible-1" }, { id: "hidden-2" }, { id: "visible-2" }];
    const loadPage = vi.fn((_: number, offset: number) => (offset === 0 ? rows : []));

    const result = middleware.filterAndPaginateTasks(loadPage, "view", "guest-1", 1, 1);

    expect(result).toEqual({ tasks: [{ id: "visible-2" }], total: 2 });
    expect(authorizeTaskAction).toHaveBeenCalledTimes(4);
  });

  it("keeps the local-owner fast path on the repository page", () => {
    const { middleware } = createMiddleware();
    const loadPage = vi.fn(() => [{ id: "task-1" }]);

    const result = middleware.filterAndPaginateTasks(loadPage, "view", "local-1", 25, 10);

    expect(result).toEqual({ tasks: [{ id: "task-1" }] });
    expect(loadPage).toHaveBeenCalledWith(25, 10);
  });
});
