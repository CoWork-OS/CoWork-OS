import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImprovementEligibility } from "../../../shared/types";
import { IPC_CHANNELS } from "../../../shared/types";

const {
  registeredHandlers,
  mockGetImprovementEligibility,
  mockSaveOwnerEnrollmentSignature,
  mockClearOwnerEnrollment,
} = vi.hoisted(() => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockGetImprovementEligibility = vi.fn();
  const mockSaveOwnerEnrollmentSignature = vi.fn();
  const mockClearOwnerEnrollment = vi.fn();
  return {
    registeredHandlers,
    mockGetImprovementEligibility,
    mockSaveOwnerEnrollmentSignature,
    mockClearOwnerEnrollment,
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

vi.mock("../../improvement/ImprovementEligibilityService", () => ({
  getImprovementEligibility: mockGetImprovementEligibility,
  saveOwnerEnrollmentSignature: mockSaveOwnerEnrollmentSignature,
  clearOwnerEnrollment: mockClearOwnerEnrollment,
}));

import { setupImprovementHandlers, setupSubconsciousHandlers } from "../subconscious-handlers";

type ImprovementEligibilityOverrides = Omit<Partial<ImprovementEligibility>, "checks"> & {
  checks?: Partial<ImprovementEligibility["checks"]>;
};

function makeEligibility(overrides: ImprovementEligibilityOverrides = {}): ImprovementEligibility {
  const { checks: checkOverrides, ...eligibilityOverrides } = overrides;
  return {
    eligible: false,
    reason: "missing",
    enrolled: false,
    ...eligibilityOverrides,
    checks: {
      unpackagedApp: false,
      canonicalRepo: false,
      ownerEnrollment: false,
      ownerProofPresent: false,
      ...checkOverrides,
    },
  };
}

describe("subconscious improvement IPC handlers", () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
  });

  it("merges partial check overrides without dropping default flags", () => {
    expect(
      makeEligibility({
        checks: {
          unpackagedApp: true,
        },
      }),
    ).toMatchObject({
      checks: {
        unpackagedApp: true,
        canonicalRepo: false,
        ownerEnrollment: false,
        ownerProofPresent: false,
      },
    });
  });

  it("forwards owner enrollment IPC calls to the eligibility service", async () => {
    const compatibilityService = {
      getImprovementEligibility: vi.fn(() => makeEligibility({ reason: "compatibility" })),
    } as unknown as Parameters<typeof setupImprovementHandlers>[0];

    const currentEligibility = makeEligibility();
    const savedEligibility = makeEligibility({
      eligible: true,
      enrolled: true,
      reason: "saved",
      checks: {
        unpackagedApp: true,
        canonicalRepo: true,
        ownerEnrollment: true,
        ownerProofPresent: true,
      },
    });
    const clearedEligibility = makeEligibility({ reason: "cleared" });

    mockGetImprovementEligibility.mockReturnValue(currentEligibility);
    mockSaveOwnerEnrollmentSignature.mockReturnValue(savedEligibility);
    mockClearOwnerEnrollment.mockReturnValue(clearedEligibility);

    setupImprovementHandlers(compatibilityService);

    const getHandler = registeredHandlers.get(
      IPC_CHANNELS.IMPROVEMENT_GET_ELIGIBILITY,
    ) as () => Promise<ImprovementEligibility>;
    const saveHandler = registeredHandlers.get(IPC_CHANNELS.IMPROVEMENT_SAVE_OWNER_ENROLLMENT) as (
      _event: unknown,
      signature: string,
    ) => Promise<ImprovementEligibility>;
    const clearHandler = registeredHandlers.get(
      IPC_CHANNELS.IMPROVEMENT_CLEAR_OWNER_ENROLLMENT,
    ) as () => Promise<ImprovementEligibility>;

    await expect(getHandler()).resolves.toEqual(currentEligibility);
    await expect(saveHandler(null, "signed-proof")).resolves.toEqual(savedEligibility);
    await expect(clearHandler()).resolves.toEqual(clearedEligibility);

    expect(mockGetImprovementEligibility).toHaveBeenCalledTimes(1);
    expect(mockSaveOwnerEnrollmentSignature).toHaveBeenCalledWith("signed-proof");
    expect(mockClearOwnerEnrollment).toHaveBeenCalledTimes(1);
    expect(compatibilityService.getImprovementEligibility).not.toHaveBeenCalled();
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

  it("rejects invalid improvement cadence settings", async () => {
    const saveSettings = vi.fn();
    const service = {
      getSettings: vi.fn(() => ({
        enabled: true,
        autoRun: true,
        cadenceMinutes: 60,
        dispatchDefaults: { autoDispatch: false, defaultKinds: {} },
        perExecutorPolicy: {
          task: { enabled: true },
          suggestion: { enabled: true },
          notify: { enabled: true },
          codeChangeTask: {
            enabled: true,
            requireWorktree: true,
            strictReview: true,
            verificationRequired: true,
          },
        },
      })),
      saveSettings,
      getImprovementCompatibilitySettings: vi.fn(),
    };

    setupImprovementHandlers(service as Any);

    const handler = registeredHandlers.get(IPC_CHANNELS.IMPROVEMENT_SAVE_SETTINGS) as (
      _event: unknown,
      settings: Any,
    ) => Promise<Any>;

    await expect(
      handler(null, {
        enabled: true,
        autoRun: true,
        includeDevLogs: true,
        intervalMinutes: 0,
        variantsPerCampaign: 1,
        maxConcurrentCampaigns: 1,
        maxConcurrentImprovementExecutors: 1,
        maxQueuedImprovementCampaigns: 1,
        maxOpenCandidatesPerWorkspace: 1,
        requireWorktree: false,
        requireRepoChecks: false,
        enforcePatchScope: false,
        maxPatchFiles: 1,
        reviewRequired: false,
        judgeRequired: false,
        promotionMode: "merge",
        evalWindowDays: 1,
        replaySetSize: 1,
        campaignTimeoutMinutes: 1,
        campaignTokenBudget: 1,
        campaignCostBudget: 0,
      }),
    ).rejects.toThrow();
  });
});
