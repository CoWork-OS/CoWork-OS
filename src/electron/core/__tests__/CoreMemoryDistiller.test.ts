import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoreMemoryDistiller } from "../CoreMemoryDistiller";
import { CuratedMemoryService } from "../../memory/CuratedMemoryService";
import { MemoryService } from "../../memory/MemoryService";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";

describe("CoreMemoryDistiller", () => {
  const trace = {
    id: "trace-1",
    profileId: "profile-1",
    workspaceId: "ws-1",
  } as Any;

  const candidate = {
    id: "candidate-1",
    traceId: "trace-1",
    profileId: "profile-1",
    workspaceId: "ws-1",
    scopeKind: "workspace",
    scopeRef: "ws-1",
    candidateType: "preference",
    summary: "Prefer deterministic prompts",
    details: "Observed repeatedly across successful runs.",
    confidence: 0.92,
    status: "accepted",
  } as Any;

  function createDistiller() {
    const createdRun = {
      id: "run-1",
      profileId: "profile-1",
      workspaceId: "ws-1",
      mode: "hot_path",
      sourceTraceCount: 1,
      candidateCount: 1,
      acceptedCount: 0,
      prunedCount: 0,
      status: "running",
      startedAt: Date.now(),
    } as Any;
    return new CoreMemoryDistiller(
      {
        findById: () => trace,
      } as Any,
      {
        listForTrace: () => [candidate],
      } as Any,
      {
        create: () => createdRun,
        update: (_id: string, patch: Any) => ({ ...createdRun, ...patch }),
      } as Any,
      {
        touchDistill: vi.fn(),
      } as Any,
      {} as Any,
      {} as Any,
      {} as Any,
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps preference candidates out of curated hot memory when auto-promotion is disabled", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      autoPromoteToCuratedMemoryEnabled: false,
    } as Any);
    const curatedSpy = vi
      .spyOn(CuratedMemoryService, "upsertDistilledEntry")
      .mockResolvedValue(null);
    const archiveSpy = vi
      .spyOn(MemoryService, "captureCoreMemory")
      .mockResolvedValue({ id: "mem-1" } as Any);

    const distiller = createDistiller();
    await distiller.runHotPath("trace-1");

    expect(curatedSpy).not.toHaveBeenCalled();
    expect(archiveSpy).toHaveBeenCalledOnce();
  });

  it("promotes preference candidates into curated hot memory when auto-promotion is enabled", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      autoPromoteToCuratedMemoryEnabled: true,
    } as Any);
    const curatedSpy = vi.spyOn(CuratedMemoryService, "upsertDistilledEntry").mockResolvedValue({
      id: "curated-1",
    } as Any);
    const archiveSpy = vi
      .spyOn(MemoryService, "captureCoreMemory")
      .mockResolvedValue({ id: "mem-1" } as Any);

    const distiller = createDistiller();
    await distiller.runHotPath("trace-1");

    expect(curatedSpy).toHaveBeenCalledOnce();
    expect(archiveSpy).toHaveBeenCalledOnce();
  });
});
