import { SupermemoryService } from "./SupermemoryService";
import type { Workspace } from "../../shared/types";

export interface ExternalMemoryTurnContext {
  workspace: Pick<Workspace, "id" | "name">;
  query?: string;
  taskId?: string;
  sessionId?: string;
  /** Automatic external recall/sync is disabled for approval-gated profiles. */
  allowExternalAccess?: boolean;
}

export interface ExternalMemoryPrefetchResult {
  providerId: string;
  context: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalMemoryProvider {
  id: string;
  isEnabled(): boolean;
  prefetch(context: ExternalMemoryTurnContext): Promise<ExternalMemoryPrefetchResult | null>;
}

export class SupermemoryExternalProvider implements ExternalMemoryProvider {
  id = "supermemory";

  isEnabled(): boolean {
    return SupermemoryService.isConfigured();
  }

  async prefetch(context: ExternalMemoryTurnContext): Promise<ExternalMemoryPrefetchResult | null> {
    if (!this.isEnabled() || context.allowExternalAccess === false) return null;
    const profile = await SupermemoryService.buildPromptContext({
      workspace: context.workspace,
      query: context.query || "",
    });
    if (!profile) return null;
    return {
      providerId: this.id,
      context: profile,
    };
  }
}

export class ExternalMemoryProviderRegistry {
  private readonly providers: ExternalMemoryProvider[];

  constructor(providers: ExternalMemoryProvider[] = [new SupermemoryExternalProvider()]) {
    this.providers = providers;
  }

  listEnabled(): ExternalMemoryProvider[] {
    return this.providers.filter((provider) => provider.isEnabled());
  }

  async prefetchAll(context: ExternalMemoryTurnContext): Promise<ExternalMemoryPrefetchResult[]> {
    const results = await Promise.all(
      this.listEnabled().map((provider) => provider.prefetch(context).catch(() => null)),
    );
    return results.filter((result): result is ExternalMemoryPrefetchResult => result !== null);
  }
}
