import { describe, expect, it, vi } from "vitest";
import {
  getLatestTaskSnapshotAfterCreate,
  shouldApplyReconciledTaskSnapshot,
} from "../task-create-reconciliation";

describe("getLatestTaskSnapshotAfterCreate", () => {
  it("uses a newer persisted terminal state after task creation", async () => {
    const createdTask = { id: "task-1", status: "pending", updatedAt: 100 };
    const persistedTask = { id: "task-1", status: "failed", updatedAt: 120 };
    const readTask = vi.fn().mockResolvedValue(persistedTask);

    const result = await getLatestTaskSnapshotAfterCreate(createdTask, readTask);

    expect(result).toBe(persistedTask);
    expect(readTask).toHaveBeenCalledWith("task-1");
  });

  it("keeps the creation snapshot when the persisted task is missing or not newer", async () => {
    const createdTask = {
      id: "task-1",
      status: "pending",
      terminalStatus: undefined,
      updatedAt: 100,
    };

    await expect(getLatestTaskSnapshotAfterCreate(createdTask, async () => null)).resolves.toBe(
      createdTask,
    );
    await expect(
      getLatestTaskSnapshotAfterCreate(createdTask, async () => ({
        ...createdTask,
        updatedAt: 99,
      })),
    ).resolves.toBe(createdTask);
  });

  it("uses a changed status when both snapshots share a millisecond timestamp", async () => {
    const createdTask = { id: "task-1", status: "pending", updatedAt: 100 };
    const persistedTask = { id: "task-1", status: "failed", updatedAt: 100 };

    await expect(
      getLatestTaskSnapshotAfterCreate(createdTask, async () => persistedTask),
    ).resolves.toBe(persistedTask);
  });

  it("propagates task read failures so the caller can record the reconciliation error", async () => {
    const createdTask = { id: "task-1", status: "pending", updatedAt: 100 };
    const readError = new Error("database unavailable");

    await expect(
      getLatestTaskSnapshotAfterCreate(createdTask, async () => {
        throw readError;
      }),
    ).rejects.toBe(readError);
  });

  it("applies a changed status when current and reconciled timestamps match", () => {
    expect(
      shouldApplyReconciledTaskSnapshot(
        { status: "pending", updatedAt: 100 },
        { status: "failed", updatedAt: 100 },
      ),
    ).toBe(true);
  });

  it("does not replace a newer current snapshot or an unchanged same-time snapshot", () => {
    const currentTask = { status: "failed", terminalStatus: "error", updatedAt: 100 };

    expect(
      shouldApplyReconciledTaskSnapshot(currentTask, {
        status: "completed",
        terminalStatus: "ok",
        updatedAt: 99,
      }),
    ).toBe(false);
    expect(shouldApplyReconciledTaskSnapshot(currentTask, { ...currentTask })).toBe(false);
  });
});
