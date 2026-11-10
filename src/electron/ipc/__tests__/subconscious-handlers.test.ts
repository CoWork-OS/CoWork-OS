import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/types";

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import { setupSubconsciousHandlers } from "../subconscious-handlers";

describe("subconscious IPC handlers", () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
  });

  it("forces strict code-change safety flags when saving subconscious settings", async () => {
    const saveSettings = vi.fn((value) => value);
    setupSubconsciousHandlers({
      getSettings: vi.fn(),
      saveSettings,
    } as Any);

    const handler = registeredHandlers.get(IPC_CHANNELS.SUBCONSCIOUS_SAVE_SETTINGS) as (
      _event: unknown,
      settings: Any,
    ) => Promise<Any>;

    await handler(null, {
      enabled: true,
      autoRun: true,
      cadenceMinutes: 60,
      enabledTargetKinds: ["workspace"],
      phaseModels: {},
      dispatchDefaults: { autoDispatch: false, defaultKinds: {} },
      artifactRetentionDays: 30,
      maxHypothesesPerRun: 3,
      perExecutorPolicy: {
        task: { enabled: true },
        suggestion: { enabled: true },
        notify: { enabled: true },
        codeChangeTask: {
          enabled: true,
          requireWorktree: false,
          strictReview: false,
          verificationRequired: false,
        },
      },
    });

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        perExecutorPolicy: expect.objectContaining({
          codeChangeTask: expect.objectContaining({
            requireWorktree: true,
            strictReview: true,
            verificationRequired: true,
          }),
        }),
      }),
    );
  });
});
