import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createXAdapter } from "../x";
import { getXMentionTriggerStatusStore } from "../../../x-mentions/status";

const loadSettingsMock = vi.fn();
const runBirdCommandMock = vi.fn();

vi.mock("../../../settings/x-manager", () => ({
  XSettingsManager: {
    loadSettings: () => loadSettingsMock(),
  },
}));

vi.mock("../../../utils/x-cli", () => ({
  runBirdCommand: (...args: unknown[]) => runBirdCommandMock(...args),
}));

describe("XAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadSettingsMock.mockReturnValue({
      enabled: true,
      authMethod: "browser",
      mentionTrigger: {
        enabled: true,
        commandPrefix: "do:",
        allowedAuthors: ["tomosman"],
        pollIntervalSec: 60,
        fetchCount: 25,
        workspaceMode: "temporary",
      },
    });
    runBirdCommandMock.mockImplementation((_settings: unknown, args: string[]) => {
      if (args[0] === "whoami") {
        return Promise.resolve({ stdout: "@coworkbot", stderr: "", data: { username: "coworkbot" } });
      }
      if (args[0] === "mentions") {
        return Promise.resolve({
          stdout: "",
          stderr: "",
          data: [
            {
              id: "tweet-1",
              text: "@agent do: run the task",
              createdAt: new Date("2026-02-28T08:05:00Z").toISOString(),
              conversationId: "conv-1",
              author: { username: "tomosman" },
            },
          ],
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", data: {} });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("connects, ingests mentions, and suppresses outbound by default", async () => {
    const onMentionCommand = vi.fn().mockResolvedValue({ taskId: "task-1" });
    const onMessage = vi.fn();

    const adapter = createXAdapter({
      enabled: true,
      commandPrefix: "do:",
      allowedAuthors: ["tomosman"],
      pollIntervalSec: 60,
      fetchCount: 25,
      outboundEnabled: false,
      onMentionCommand,
    });
    adapter.onMessage(onMessage);

    await adapter.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(adapter.status).toBe("connected");
    expect(onMentionCommand).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);

    const outboundResult = await adapter.sendMessage({
      chatId: "conv-1",
      text: "This should not post",
    });
    expect(outboundResult.startsWith("x-suppressed-")).toBe(true);

    const status = getXMentionTriggerStatusStore().snapshot();
    expect(status.mode).toBe("native");
    expect(status.acceptedCount).toBeGreaterThan(0);
    expect(status.lastTaskId).toBe("task-1");

    await adapter.disconnect();
  });

  it("retries the same mention after transient handler failure", async () => {
    const onMentionCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ taskId: "task-2" });
    const onMessage = vi.fn();
    const onError = vi.fn();

    const adapter = createXAdapter({
      enabled: true,
      commandPrefix: "do:",
      allowedAuthors: ["tomosman"],
      pollIntervalSec: 60,
      fetchCount: 25,
      outboundEnabled: false,
      onMentionCommand,
    });
    adapter.onMessage(onMessage);
    adapter.onError(onError);

    await adapter.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(onMentionCommand).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(0);
    expect(onError).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onMentionCommand).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
  });
});
