/** What earlier steps did, for steps that record how the shutdown went (DB6). */
export interface ShutdownContext {
  /** No earlier step failed or timed out. */
  quiescent: boolean;
  failedSteps: readonly string[];
}

export interface ShutdownStep {
  name: string;
  run: (context: ShutdownContext) => unknown | Promise<unknown>;
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
  on(event: "window-all-closed", listener: () => void): unknown;
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
        Promise.resolve().then(() =>
          step.run({ quiescent: quiescenceReached, failedSteps: [...failedSteps] }),
        ),
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
  let finalQuitScheduled = false;

  // A native quit can fall back to window-all-closed after an asynchronous
  // before-quit deferral. Once cleanup has finished, preserve the explicit quit
  // request instead of leaving the macOS app alive with closed storage.
  app.on("window-all-closed", () => {
    if (!completed || finalQuitScheduled) return;
    finalQuitScheduled = true;
    setImmediate(() => app.quit());
  });

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

interface ClosableWindow {
  isDestroyed(): boolean;
  close(): void;
  once(event: "closed", listener: () => void): unknown;
}

/**
 * Close windows during shutdown and wait until they are gone (at most `timeoutMs`).
 * Closing runs the renderer's hide/unload handlers, which save state such as the
 * open composer draft, while main-process storage is still open.
 */
export async function closeWindowsForShutdown(
  windows: readonly ClosableWindow[],
  timeoutMs = 5_000,
): Promise<void> {
  const open = windows.filter((window) => !window.isDestroyed());
  if (open.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(
      open.map(
        (window) =>
          new Promise<void>((resolve) => {
            window.once("closed", () => resolve());
            window.close();
          }),
      ),
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}
