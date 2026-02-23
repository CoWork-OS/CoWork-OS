export type ExecutorLogEventFn = (type: string, payload: any) => void;

/**
 * Thin adapter used by TaskExecutor so event emission can be routed through
 * one contract point while we modularize execution internals.
 */
export class ExecutorEventEmitter {
  constructor(private readonly logEvent: ExecutorLogEventFn) {}

  emit(type: string, payload: any): void {
    this.logEvent(type, payload);
  }
}
