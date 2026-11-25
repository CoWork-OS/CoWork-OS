export interface QuitConfirmationDeps {
  isEnabled: () => boolean;
  /** Tasks that would stop if the app quit now. */
  workingTaskCount: () => number;
  /** Ask the person. True means quit anyway. */
  ask: (workingTaskCount: number) => boolean;
  /** Quits nobody can answer: headless runs, test harness launches, a system shutdown. */
  isUnattended: () => boolean;
}

export interface QuitConfirmation {
  /** For the app's quit request. Once it passes, the rest of that quit is not asked again. */
  confirmQuit(): boolean;
  /**
   * For closing the last window where that quits the app. A pass is remembered briefly so
   * the quit request that follows does not ask a second time.
   */
  confirmClose(): boolean;
}

const CLOSE_PASS_TTL_MS = 5_000;

/**
 * Asks before a quit would stop running tasks. With nothing running, the setting off, or
 * nobody there to answer, it passes without asking.
 */
export function createQuitConfirmation(
  deps: QuitConfirmationDeps,
  now: () => number = Date.now,
): QuitConfirmation {
  let quitPassed = false;
  let closePassedAt: number | null = null;

  const decide = (): boolean => {
    try {
      if (deps.isUnattended() || !deps.isEnabled()) return true;
      const count = deps.workingTaskCount();
      if (count <= 0) return true;
      return deps.ask(count);
    } catch {
      // A broken check must never make the app impossible to quit.
      return true;
    }
  };

  return {
    confirmQuit() {
      if (quitPassed) return true;
      if (closePassedAt !== null && now() - closePassedAt < CLOSE_PASS_TTL_MS) {
        quitPassed = true;
        return true;
      }
      quitPassed = decide();
      return quitPassed;
    },
    confirmClose() {
      if (quitPassed) return true;
      const passed = decide();
      closePassedAt = passed ? now() : null;
      return passed;
    },
  };
}

/** Wording for the question, shared by the dialog and its tests. */
export function quitConfirmationText(workingTaskCount: number): {
  message: string;
  detail: string;
} {
  return {
    message: "Quit CoWork OS while it is working?",
    detail:
      (workingTaskCount === 1
        ? "1 task is still running and will stop."
        : `${workingTaskCount} tasks are still running and will stop.`) +
      " You can turn this question off in Settings > System & Security.",
  };
}
