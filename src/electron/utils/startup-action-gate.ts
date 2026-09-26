/** Defers app-window actions until startup has registered its IPC handlers. */
export class StartupActionGate {
  private ready = false;
  private pending: Array<() => void> = [];

  runWhenReady(action: () => void): void {
    if (this.ready) {
      action();
      return;
    }

    this.pending.push(action);
  }

  open(): void {
    if (this.ready) return;
    this.ready = true;

    const pending = this.pending;
    this.pending = [];
    for (const action of pending) action();
  }
}
