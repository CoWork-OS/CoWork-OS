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

export interface ExternalMemorySyncTurnInput extends ExternalMemoryTurnContext {
  userText?: string;
  assistantText?: string;
  memories?: string[];
}

export interface ExternalMemoryExtractSessionInput extends ExternalMemoryTurnContext {
  transcriptSummary: string;
}

export interface ExternalMemoryProvider {
  id: string;
  isEnabled(): boolean;
  prefetch(context: ExternalMemoryTurnContext): Promise<ExternalMemoryPrefetchResult | null>;
  syncTurn(input: ExternalMemorySyncTurnInput): Promise<void>;
  extractSession(input: ExternalMemoryExtractSessionInput): Promise<void>;
  forget(scope: {
    workspace: Pick<Workspace, "id" | "name">;
    memoryId?: string;
    text?: string;
  }): Promise<void>;
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

  async syncTurn(input: ExternalMemorySyncTurnInput): Promise<void> {
    if (!this.isEnabled() || input.allowExternalAccess === false) return;
    for (const memory of input.memories || []) {
      const content = memory.trim();
      if (!content) continue;
      await SupermemoryService.remember({
        workspace: input.workspace,
        content,
        metadata: {
          taskId: input.taskId,
          sessionId: input.sessionId,
          source: "turn_sync",
        },
        taskId: input.taskId,
        origin: "background",
      });
    }
  }

  async extractSession(input: ExternalMemoryExtractSessionInput): Promise<void> {
    if (!this.isEnabled() || input.allowExternalAccess === false || !input.transcriptSummary.trim())
      return;
    await SupermemoryService.remember({
      workspace: input.workspace,
      content: input.transcriptSummary,
      metadata: {
        taskId: input.taskId,
        sessionId: input.sessionId,
        source: "session_extract",
      },
      taskId: input.taskId,
      origin: "background",
    });
  }

  async forget(scope: {
    workspace: Pick<Workspace, "id" | "name">;
    memoryId?: string;
    text?: string;
  }): Promise<void> {
    if (!this.isEnabled()) return;
    await SupermemoryService.forget({
      workspace: scope.workspace,
      memoryId: scope.memoryId,
      content: scope.text,
    });
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
