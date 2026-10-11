/**
 * A deferred render input may still describe the previously selected task while React is
 * busy (several running tasks stream events). Use it only while it belongs to the task the
 * user is looking at; after a task switch, render the current input right away.
 */
export function deferredInputForSelectedTask<T extends { task?: { id?: string } | null }>(
  deferred: T,
  current: T,
): T {
  return deferred.task?.id === current.task?.id ? deferred : current;
}
