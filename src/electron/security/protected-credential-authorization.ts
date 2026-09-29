/**
 * Who may fulfill or deny a protected credential request. A request bound to a task needs
 * the `approve` capability on that task; a request bound to no task belongs to the local
 * owner. Never a no-op: every request resolves through one of the two checks.
 */
export async function authorizeProtectedCredentialResolution(input: {
  taskId: string | undefined;
  principalId: string;
  localPrincipalId: string;
  authorizeTask: (taskId: string) => Promise<unknown>;
}): Promise<void> {
  if (input.taskId) {
    await input.authorizeTask(input.taskId);
    return;
  }
  if (input.principalId !== input.localPrincipalId) {
    throw new Error("Only the local owner can resolve this credential request.");
  }
}
