import { DreamingRepository } from "./DreamingRepository";
import { DreamingService } from "./DreamingService";
import { MemoryPressureService } from "./MemoryPressureService";
import { TranscriptStore, type TranscriptReadGuard } from "./TranscriptStore";

export interface MemoryNudgeResult {
  triggered: boolean;
  reason: string;
  dreamingRunId?: string;
  candidateCount?: number;
}

export interface MemoryNudgeRequest {
  workspaceId: string;
  workspacePath: string;
  taskId?: string;
  taskPrompt?: string;
  db: ConstructorParameters<typeof DreamingRepository>[0];
  minIntervalMs?: number;
  now?: number;
  readGuard?: TranscriptReadGuard;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const lastNudgeByScope = new Map<string, number>();

function nudgeKey(request: Pick<MemoryNudgeRequest, "workspaceId" | "taskId">): string {
  return `${request.workspaceId}:${request.taskId || "workspace"}`;
}

function hasMemorySignal(text: string): boolean {
  return /\b(remember|correction|actually|instead|follow up|open loop|stale|outdated|preference|always|never|avoid|recurring|daily|weekly)\b/i.test(
    text,
  );
}

export class MemoryNudgeService {
  static resetForTests(): void {
    lastNudgeByScope.clear();
  }

  static async maybeRun(request: MemoryNudgeRequest): Promise<MemoryNudgeResult> {
    const now = request.now ?? Date.now();
    const key = nudgeKey(request);
    const minIntervalMs = Math.max(1, request.minIntervalMs ?? DEFAULT_INTERVAL_MS);
    const last = lastNudgeByScope.get(key) ?? 0;
    if (last > 0 && now - last < minIntervalMs) {
      return { triggered: false, reason: "cooldown" };
    }

    const report = await MemoryPressureService.analyze(request.workspacePath, request.readGuard);
    const pressureInstructions = MemoryPressureService.buildCompactionInstructions(report);
    const recent = request.taskId
      ? await TranscriptStore.loadRecentSpans(
          request.workspacePath,
          request.taskId,
          12,
          request.readGuard,
        )
      : [];
    const recentText = recent
      .map((span) =>
        typeof span.payload === "string" ? span.payload : JSON.stringify(span.payload || {}),
      )
      .join("\n");

    if (!pressureInstructions && !hasMemorySignal(`${request.taskPrompt || ""}\n${recentText}`)) {
      lastNudgeByScope.set(key, now);
      return { triggered: false, reason: "no_memory_signal" };
    }

    lastNudgeByScope.set(key, now);
    const result = await new DreamingService(new DreamingRepository(request.db), {
      now: () => now,
    }).run({
      workspaceId: request.workspaceId,
      workspacePath: request.workspacePath,
      triggerSource: "system",
      sourceTaskId: request.taskId,
      taskPrompt: request.taskPrompt,
      instructions:
        pressureInstructions ||
        "Periodic memory nudge: review recent task evidence for durable preferences, corrections, open loops, recurring tasks, stale facts, or ignored-noise patterns. Create reviewable candidates only.",
      readGuard: request.readGuard,
    });

    return {
      triggered: true,
      reason: pressureInstructions ? "memory_pressure" : "memory_signal",
      dreamingRunId: result.run.id,
      candidateCount: result.candidates.length,
    };
  }
}
