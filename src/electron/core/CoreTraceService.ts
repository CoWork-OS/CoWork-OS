import type {
  CoreTrace,
  CoreTraceEvent,
  CoreTracePhase,
  CoreTraceStatus,
  ListCoreTracesRequest,
} from "../../shared/types";
import { CoreMemoryCandidateRepository } from "./CoreMemoryCandidateRepository";
import { CoreTraceRepository } from "./CoreTraceRepository";

export class CoreTraceService {
  constructor(
    private readonly traceRepo: CoreTraceRepository,
    private readonly candidateRepo: CoreMemoryCandidateRepository,
  ) {}

  startTrace(
    input: Omit<CoreTrace, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): CoreTrace {
    const existing = this.traceRepo.findOpenTrace({
      profileId: input.profileId,
      sourceSurface: input.sourceSurface,
      targetKey: input.targetKey,
      heartbeatRunId: input.heartbeatRunId,
      subconsciousRunId: input.subconsciousRunId,
    });
    if (existing) {
      return existing;
    }
    return this.traceRepo.create(input);
  }

  appendPhaseEvent(
    traceId: string,
    phase: CoreTracePhase,
    eventType: string,
    summary: string,
    details?: Record<string, unknown>,
  ): CoreTraceEvent {
    return this.traceRepo.appendEvent({
      traceId,
      phase,
      eventType,
      summary,
      details,
    });
  }

  attachHeartbeatRun(traceId: string, heartbeatRunId: string): CoreTrace | undefined {
    return this.traceRepo.update(traceId, { heartbeatRunId });
  }

  attachSubconsciousRun(traceId: string, subconsciousRunId: string): CoreTrace | undefined {
    return this.traceRepo.update(traceId, { subconsciousRunId });
  }

  attachTask(traceId: string, taskId: string): CoreTrace | undefined {
    return this.traceRepo.update(traceId, { taskId });
  }

  completeTrace(
    traceId: string,
    status: Exclude<CoreTraceStatus, "running">,
    summary?: string,
  ): CoreTrace | undefined {
    return this.traceRepo.update(traceId, {
      status,
      summary,
      completedAt: Date.now(),
    });
  }

  failTrace(traceId: string, error: string): CoreTrace | undefined {
    return this.traceRepo.update(traceId, {
      status: "failed",
      error,
      completedAt: Date.now(),
    });
  }

  getTrace(id: string) {
    const trace = this.traceRepo.findById(id);
    if (!trace) return undefined;
    return {
      trace,
      events: this.traceRepo.listEvents(id),
      candidates: this.candidateRepo.listForTrace(id),
    };
  }

  list(request: ListCoreTracesRequest = {}) {
    return this.traceRepo.list(request);
  }

  listByProfile(profileId: string, limit?: number) {
    return this.traceRepo.listByProfile(profileId, limit);
  }
}
