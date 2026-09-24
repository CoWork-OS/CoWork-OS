export async function getLatestTaskSnapshotAfterCreate<
  T extends { id: string; updatedAt: number; status: unknown; terminalStatus?: unknown },
>(createdTask: T, readTask: (taskId: string) => Promise<T | null>): Promise<T> {
  const persistedTask = await readTask(createdTask.id);
  if (!persistedTask) return createdTask;
  if (persistedTask.updatedAt < createdTask.updatedAt) return createdTask;
  if (
    persistedTask.updatedAt === createdTask.updatedAt &&
    persistedTask.status === createdTask.status &&
    persistedTask.terminalStatus === createdTask.terminalStatus
  ) {
    return createdTask;
  }
  return persistedTask;
}

export function shouldApplyReconciledTaskSnapshot<
  T extends { updatedAt: number; status: unknown; terminalStatus?: unknown },
>(currentTask: T, reconciledTask: T): boolean {
  if (reconciledTask.updatedAt !== currentTask.updatedAt) {
    return reconciledTask.updatedAt > currentTask.updatedAt;
  }

  return (
    reconciledTask.status !== currentTask.status ||
    reconciledTask.terminalStatus !== currentTask.terminalStatus
  );
}
