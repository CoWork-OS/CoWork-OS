import { describe, expect, it, vi } from "vitest";
import { authorizeProtectedCredentialResolution } from "../protected-credential-authorization";

describe("authorizeProtectedCredentialResolution", () => {
  it("requires approval on the task for a task-bound request", async () => {
    const authorizeTask = vi.fn(async () => {
      throw new Error("Principal cannot approve this task.");
    });
    await expect(
      authorizeProtectedCredentialResolution({
        taskId: "task-1",
        principalId: "local-owner",
        localPrincipalId: "local-owner",
        authorizeTask,
      }),
    ).rejects.toThrow("cannot approve");
    expect(authorizeTask).toHaveBeenCalledWith("task-1");
  });

  it("lets only the local owner resolve a request bound to no task", async () => {
    const authorizeTask = vi.fn(async () => undefined);
    await expect(
      authorizeProtectedCredentialResolution({
        taskId: undefined,
        principalId: "local-owner",
        localPrincipalId: "local-owner",
        authorizeTask,
      }),
    ).resolves.toBeUndefined();
    await expect(
      authorizeProtectedCredentialResolution({
        taskId: undefined,
        principalId: "invited-viewer",
        localPrincipalId: "local-owner",
        authorizeTask,
      }),
    ).rejects.toThrow("Only the local owner");
    expect(authorizeTask).not.toHaveBeenCalled();
  });
});
