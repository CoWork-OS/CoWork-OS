import type { BotWorkResult, BotWorkResultRequest } from "../../shared/bot-work-result";
export interface BotWorkResultState {
  result: BotWorkResult | null;
  loading: boolean;
  error: string | null;
}
/** No persistence; stale replies cannot cross task, workspace, or bot boundaries. */
export class BotWorkResultLoader {
  private generation = 0;
  private disposed = false;
  private state: BotWorkResultState = { result: null, loading: false, error: null };
  private listeners = new Set<() => void>();
  constructor(
    private read: (request: BotWorkResultRequest) => Promise<BotWorkResult>,
    private request: BotWorkResultRequest,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate() {
    this.disposed = false;
  }
  private publish(state: BotWorkResultState) {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  async load() {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.publish({ result: null, loading: true, error: null });
    try {
      const result = await this.read(this.request);
      if (this.disposed || generation !== this.generation) return;
      if (
        result.request.workspaceId !== this.request.workspaceId ||
        result.request.agentRoleId !== this.request.agentRoleId ||
        result.request.taskId !== this.request.taskId
      )
        throw new Error("Result belongs to another work item, bot or workspace.");
      this.publish({ result, loading: false, error: null });
    } catch (cause) {
      if (!this.disposed && generation === this.generation)
        this.publish({
          result: null,
          loading: false,
          error: cause instanceof Error ? cause.message : "Could not load result evidence.",
        });
    }
  }
  dispose() {
    this.disposed = true;
    ++this.generation;
  }
}
