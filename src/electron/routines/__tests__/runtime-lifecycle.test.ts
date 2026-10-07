import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineService } from "../service";
import type { RoutineWorkflowRepository } from "../routine-repository-facades";
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cowork-runtime-test" } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("routine runtime shutdown", () => {
  let db: Database.Database;
  let service: RoutineService;
  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(":memory:");
    service = new RoutineService({
      db,
      getCronService: () => null,
      getEventTriggerService: () => null,
      loadHooksSettings: () => ({
        enabled: false,
        token: "",
        path: "/hooks",
        maxBodyBytes: 1000,
        presets: [],
        mappings: [],
      }),
      saveHooksSettings: vi.fn(),
    });
  });
  afterEach(async () => {
    await service.stopWorkflowRuntime();
    db.close();
    vi.useRealTimers();
  });
  function repository() {
    return (service as unknown as { workflowRepository: RoutineWorkflowRepository })
      .workflowRepository;
  }
  it("does not create timers when stopped while startup recovery is awaiting storage", async () => {
    const ready = deferred<void>();
    vi.spyOn(repository(), "requeueProcessingEvents").mockReturnValue(ready.promise);
    const starting = service.startWorkflowRuntime();
    const stopping = service.stopWorkflowRuntime();
    ready.resolve();
    await starting;
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cannot resume the inbox after asynchronous recovery settles during shutdown", async () => {
    const ready = deferred<Awaited<ReturnType<RoutineWorkflowRepository["listRecoverableRuns"]>>>();
    vi.spyOn(repository(), "listRecoverableRuns").mockReturnValue(ready.promise);
    const claim = vi.spyOn(repository(), "claimNextEvent");
    await service.startWorkflowRuntime();
    const stopping = service.stopWorkflowRuntime();
    ready.resolve([]);
    await stopping;
    await vi.advanceTimersByTimeAsync(2000);
    expect(claim).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns an event claimed during shutdown to the durable inbox without executing it", async () => {
    const ready = deferred<Awaited<ReturnType<RoutineWorkflowRepository["claimNextEvent"]>>>();
    vi.spyOn(repository(), "listRecoverableRuns").mockResolvedValue([]);
    vi.spyOn(repository(), "claimNextEvent").mockReturnValue(ready.promise);
    const update = vi.spyOn(repository(), "updateEvent").mockResolvedValue(null as never);
    await service.startWorkflowRuntime();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = service.stopWorkflowRuntime();
    ready.resolve({ id: "claimed" } as Awaited<
      ReturnType<RoutineWorkflowRepository["claimNextEvent"]>
    >);
    await stopping;
    expect(update).toHaveBeenCalledWith("claimed", { status: "pending" });
  });
});
