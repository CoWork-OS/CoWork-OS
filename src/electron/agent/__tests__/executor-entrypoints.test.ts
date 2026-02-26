import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor entrypoint guards", () => {
  it("serializes execute/sendMessage via lifecycle mutex wrappers", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const runExclusive = vi.fn(async (fn: () => Promise<void>) => fn());

    executor.lifecycleMutex = { runExclusive };
    executor.executeUnlocked = vi.fn(async () => undefined);
    executor.sendMessageUnlocked = vi.fn(async () => undefined);

    await executor.execute();
    await executor.sendMessage("hi");

    expect(runExclusive).toHaveBeenCalledTimes(2);
    expect(executor.executeUnlocked).toHaveBeenCalledTimes(1);
    expect(executor.sendMessageUnlocked).toHaveBeenCalledWith("hi", undefined);
  });

  it("routes executeStep through the feature-flagged unified branch", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const step = { id: "s1", description: "do work", status: "pending" };

    executor.useUnifiedTurnLoop = true;
    executor.executeStepUnified = vi.fn(async () => undefined);
    executor.executeStepLegacy = vi.fn(async () => undefined);
    await executor.executeStep(step);
    expect(executor.executeStepUnified).toHaveBeenCalledWith(step);
    expect(executor.executeStepLegacy).not.toHaveBeenCalled();

    executor.useUnifiedTurnLoop = false;
    executor.executeStepUnified = vi.fn(async () => undefined);
    executor.executeStepLegacy = vi.fn(async () => undefined);
    await executor.executeStep(step);
    expect(executor.executeStepLegacy).toHaveBeenCalledWith(step);
    expect(executor.executeStepUnified).not.toHaveBeenCalled();
  });

  it("routes sendMessageUnlocked through the feature-flagged unified branch", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.useUnifiedTurnLoop = true;
    executor.sendMessageUnified = vi.fn(async () => undefined);
    executor.sendMessageLegacy = vi.fn(async () => undefined);
    await executor.sendMessageUnlocked("hello");
    expect(executor.sendMessageUnified).toHaveBeenCalledWith("hello", undefined);
    expect(executor.sendMessageLegacy).not.toHaveBeenCalled();

    executor.useUnifiedTurnLoop = false;
    executor.sendMessageUnified = vi.fn(async () => undefined);
    executor.sendMessageLegacy = vi.fn(async () => undefined);
    await executor.sendMessageUnlocked("hello");
    expect(executor.sendMessageLegacy).toHaveBeenCalledWith("hello", undefined);
    expect(executor.sendMessageUnified).not.toHaveBeenCalled();
  });
});
