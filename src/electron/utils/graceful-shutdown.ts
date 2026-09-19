export interface ShutdownStep {
  name: string;
  run: () => unknown | Promise<unknown>;
  /** Skip this release step if an earlier stop failed or timed out. */
  requiresQuiescence?: boolean;
}

export interface ShutdownRunResult {
  quiescent: boolean;
  failedSteps: readonly string[];
  skippedSteps: readonly string[];
}

interface QuitEvent {
  preventDefault(): void;
}

interface QuitApp {
  on(event: "before-quit", listener: (event: QuitEvent) => void): unknown;
  quit(): void;
}

/**
 * Run bounded shutdown steps in order. A timeout races the step but cannot
 * cancel it, so dependent resource-release steps are skipped after any stop
 * failure or timeout while persistence and other non-dependent steps continue.
 */
export async function runShutdownSteps(
  steps: readonly ShutdownStep[],
  reportError: (step: string, error: unknown) => void,
  stepTimeoutMs = 10_000,
): Promise<ShutdownRunResult> {
  let quiescenceReached = true;
  const failedSteps: string[] = [];
  const skippedSteps: string[] = [];

  for (const step of steps) {
    if (step.requiresQuiescence && !quiescenceReached) {
      skippedSteps.push(step.name);
      continue;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Shutdown step timed out after ${stepTimeoutMs}ms`)),
            stepTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      quiescenceReached = false;
      failedSteps.push(step.name);
      try {
        reportError(step.name, error);
      } catch {
        // Reporting must not prevent later persistence or release decisions.
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { quiescent: quiescenceReached, failedSteps, skippedSteps };
}

/** Electron does not await async event listeners. Hold quit until cleanup settles. */
export function installGracefulShutdown(
  app: QuitApp,
  steps: readonly ShutdownStep[],
  reportError: (step: string, error: unknown) => void,
  stepTimeoutMs = 10_000,
): void {
  let started = false;
  let completed = false;

  app.on("before-quit", (event) => {
    if (completed) return;
    event.preventDefault();
    if (started) return;
    started = true;

    void (async () => {
      await runShutdownSteps(steps, reportError, stepTimeoutMs);
      completed = true;
      app.quit();
    })();
  });
}
