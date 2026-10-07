import { describe, expect, it, vi } from "vitest";
import { EventTriggerService } from "../EventTriggerService";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(
  createTask = vi.fn().mockResolvedValue({ id: "task" }),
  onTriggerFired?: () => Promise<void>,
) {
  const service = new EventTriggerService({
    createTask,
    getDefaultWorkspaceId: () => "ws",
    onTriggerFired,
  });
  await service.start();
  await service.addTrigger({
    name: "fixture",
    workspaceId: "ws",
    enabled: true,
    source: "channel_message",
    conditions: [],
    action: { type: "create_task", config: { prompt: "fixture" } },
  });
  return { service, createTask };
}
describe("trigger runtime drain", () => {
  it("drains immediate ingress and its post-fire receipt before resolving stop", async () => {
    const started = deferred();
    const finishTask = deferred();
    const receiptStarted = deferred();
    const finishReceipt = deferred();
    const { service } = await setup(
      vi.fn(async () => {
        started.resolve();
        await finishTask.promise;
        return { id: "task" };
      }),
      async () => {
        receiptStarted.resolve();
        await finishReceipt.promise;
      },
    );
    const evaluation = service.evaluateEvent({
      source: "channel_message",
      fields: {},
      timestamp: 1,
    });
    await started.promise;
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    finishTask.resolve();
    await receiptStarted.promise;
    expect(stopped).toBe(false);
    finishReceipt.resolve();
    await evaluation;
    await stopping;
    expect(stopped).toBe(true);
  });
  it("does not start an action when stopped during the routine interceptor", async () => {
    const entered = deferred();
    const release = deferred();
    const { service, createTask } = await setup();
    service.setFireInterceptor(async () => {
      entered.resolve();
      await release.promise;
      return { handled: false };
    });
    const evaluation = service.evaluateEvent({
      source: "channel_message",
      fields: {},
      timestamp: 1,
    });
    await entered.promise;
    const stopping = service.stop();
    release.resolve();
    await stopping;
    await evaluation;
    expect(createTask).not.toHaveBeenCalled();
  });
});
