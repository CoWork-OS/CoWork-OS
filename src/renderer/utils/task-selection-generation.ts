export interface TaskSelectionIdentity {
  scope: "local" | "remote";
  workspaceId: string;
  taskId: string | null;
  deviceId?: string;
  surface: "main" | "side-chat";
}

export interface TaskSelectionGenerationToken {
  identity: TaskSelectionIdentity;
  generation: number;
}

export function normalizeTaskSelectionIdentity(
  identity: TaskSelectionIdentity,
): TaskSelectionIdentity {
  return {
    scope: identity.scope,
    workspaceId: identity.workspaceId.trim(),
    taskId: identity.taskId?.trim() || null,
    surface: identity.surface,
    ...(identity.deviceId?.trim() ? { deviceId: identity.deviceId.trim() } : {}),
  };
}

export function taskSelectionIdentityEquals(
  left: TaskSelectionIdentity | null | undefined,
  right: TaskSelectionIdentity | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.scope === right.scope &&
    left.workspaceId === right.workspaceId &&
    left.taskId === right.taskId &&
    left.surface === right.surface &&
    (left.deviceId ?? "") === (right.deviceId ?? "")
  );
}

/** Small imperative generation fence used by async renderer work. */
export class TaskSelectionGeneration {
  private generation = 0;
  private currentIdentity: TaskSelectionIdentity | null = null;

  switchTo(identity: TaskSelectionIdentity): TaskSelectionGenerationToken {
    this.generation += 1;
    this.currentIdentity = normalizeTaskSelectionIdentity(identity);
    return this.capture();
  }

  capture(): TaskSelectionGenerationToken {
    if (!this.currentIdentity) {
      throw new Error("Cannot capture a task selection before switchTo().");
    }
    return { identity: this.currentIdentity, generation: this.generation };
  }

  getGeneration(): number {
    return this.generation;
  }

  isCurrent(token: TaskSelectionGenerationToken): boolean {
    return (
      token.generation === this.generation &&
      taskSelectionIdentityEquals(token.identity, this.currentIdentity)
    );
  }
}

export function isTaskSelectionCurrent(
  current: TaskSelectionGenerationToken | null | undefined,
  token: TaskSelectionGenerationToken | null | undefined,
): boolean {
  return Boolean(
    current &&
    token &&
    current.generation === token.generation &&
    taskSelectionIdentityEquals(current.identity, token.identity),
  );
}
