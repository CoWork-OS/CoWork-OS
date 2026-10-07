import type { BotWorkPage, BotWorkQuery } from "../../shared/types";

interface State {
  page: BotWorkPage | null;
  loading: boolean;
  error: string | null;
}
/** Suppresses stale responses on scope changes/unmount and deduplicates page updates. */
export class BotWorkLoader {
  private generation = 0;
  private disposed = false;
  private state: State = { page: null, loading: true, error: null };
  constructor(
    private query: (query: BotWorkQuery) => Promise<BotWorkPage>,
    private scope: BotWorkQuery,
    private publish: (state: State) => void,
  ) {}
  async load(append = false): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const previous = append ? this.state.page : null;
    this.state = { page: previous, loading: true, error: null };
    this.publish(this.state);
    try {
      const page = await this.query({
        ...this.scope,
        cursor: append ? previous?.nextCursor : undefined,
      });
      if (this.disposed || generation !== this.generation) return;
      if (
        page.workspaceId !== this.scope.workspaceId ||
        page.agentRoleId !== this.scope.agentRoleId ||
        page.view !== this.scope.view
      )
        throw new Error("Work response belongs to another bot or workspace.");
      const items = new Map(
        [...(previous?.items ?? []), ...page.items].map((item) => [item.id, item]),
      );
      this.state = { page: { ...page, items: [...items.values()] }, loading: false, error: null };
    } catch (cause) {
      if (this.disposed || generation !== this.generation) return;
      this.state = {
        page: previous,
        loading: false,
        error: cause instanceof Error ? cause.message : "Could not load bot work.",
      };
    }
    this.publish(this.state);
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
  }
}
