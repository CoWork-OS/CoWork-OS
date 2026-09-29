import { CoreMemoryCandidateRepository, CoreTraceRepository } from "./core-repository-facades";
import type {
  CoreTrace,
  CoreTraceEvent,
  CoreTracePhase,
  CoreTraceStatus,
  ListCoreTracesRequest,
} from "../../shared/types";

export class CoreTraceService {
  constructor(
    private readonly traceRepo: CoreTraceRepository,
    private readonly candidateRepo: CoreMemoryCandidateRepository,
  ) {}

  async startTrace(
    input: Omit<CoreTrace, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): Promise<CoreTrace> {
    const existing = await this.traceRepo.findOpenTrace({
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

  async appendPhaseEvent(
    traceId: string,
    phase: CoreTracePhase,
    eventType: string,
    summary: string,
    details?: Record<string, unknown>,
  ): Promise<CoreTraceEvent> {
    return this.traceRepo.appendEvent({
      traceId,
      phase,
      eventType,
      summary,
      details,
    });
  }

  async attachHeartbeatRun(
    traceId: string,
    heartbeatRunId: string,
  ): Promise<CoreTrace | undefined> {
    return this.traceRepo.update(traceId, { heartbeatRunId });
  }

  async attachSubconsciousRun(
    traceId: string,
    subconsciousRunId: string,
  ): Promise<CoreTrace | undefined> {
    return this.traceRepo.update(traceId, { subconsciousRunId });
  }

  async attachTask(traceId: string, taskId: string): Promise<CoreTrace | undefined> {
    return this.traceRepo.update(traceId, { taskId });
  }

  async completeTrace(
    traceId: string,
    status: Exclude<CoreTraceStatus, "running">,
    summary?: string,
  ): Promise<CoreTrace | undefined> {
    return this.traceRepo.update(traceId, {
      status,
      summary,
      completedAt: Date.now(),
    });
  }

  async failTrace(traceId: string, error: string): Promise<CoreTrace | undefined> {
    return this.traceRepo.update(traceId, {
      status: "failed",
      error,
      completedAt: Date.now(),
    });
  }

  async getTrace(id: string) {
    const trace = await this.traceRepo.findById(id);
    if (!trace) return undefined;
    return {
      trace,
      events: await this.traceRepo.listEvents(id),
      candidates: await this.candidateRepo.listForTrace(id),
    };
  }

  list(request: ListCoreTracesRequest = {}) {
    return this.traceRepo.list(request);
  }

  listByProfile(profileId: string, limit?: number) {
    return this.traceRepo.listByProfile(profileId, limit);
  }
}
