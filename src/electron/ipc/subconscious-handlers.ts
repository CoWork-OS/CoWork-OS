import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import type {
  ImprovementEligibility,
  ImprovementHistoryResetResult,
  ImprovementLoopSettings,
} from "../../shared/types";
import type {
  SubconsciousHistoryResetResult,
  SubconsciousSettings,
} from "../../shared/subconscious";
import { DEFAULT_SUBCONSCIOUS_SETTINGS } from "../../shared/subconscious";
import {
  clearOwnerEnrollment,
  getImprovementEligibility,
  saveOwnerEnrollmentSignature,
} from "../improvement/ImprovementEligibilityService";
import type { SubconsciousLoopService } from "../subconscious/SubconsciousLoopService";
import {
  ImprovementLoopSettingsSchema,
  SubconsciousSettingsSchema,
  TargetKeySchema,
  UUIDSchema,
  WorkspaceIdSchema,
  validateInput,
} from "../utils/validation";

export function setupSubconsciousHandlers(service: SubconsciousLoopService): void {
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_GET_SETTINGS, async (): Promise<SubconsciousSettings> => {
    return service.getSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.SUBCONSCIOUS_SAVE_SETTINGS,
    async (_event, settings: Partial<SubconsciousSettings>): Promise<SubconsciousSettings> => {
      const validated = validateInput(
        SubconsciousSettingsSchema,
        {
          ...DEFAULT_SUBCONSCIOUS_SETTINGS,
          ...settings,
          phaseModels: {
            ...DEFAULT_SUBCONSCIOUS_SETTINGS.phaseModels,
            ...(settings.phaseModels || {}),
          },
          dispatchDefaults: {
            ...DEFAULT_SUBCONSCIOUS_SETTINGS.dispatchDefaults,
            ...(settings.dispatchDefaults || {}),
            defaultKinds: {
              ...DEFAULT_SUBCONSCIOUS_SETTINGS.dispatchDefaults.defaultKinds,
              ...(settings.dispatchDefaults?.defaultKinds || {}),
            },
          },
          notificationPolicy: {
            ...DEFAULT_SUBCONSCIOUS_SETTINGS.notificationPolicy,
            ...(settings.notificationPolicy || {}),
          },
          perExecutorPolicy: {
            ...DEFAULT_SUBCONSCIOUS_SETTINGS.perExecutorPolicy,
            ...(settings.perExecutorPolicy || {}),
            codeChangeTask: {
              ...DEFAULT_SUBCONSCIOUS_SETTINGS.perExecutorPolicy.codeChangeTask,
              ...(settings.perExecutorPolicy?.codeChangeTask || {}),
            },
          },
        },
        "subconscious settings",
      ) as unknown as SubconsciousSettings;
      return service.saveSettings({
        ...validated,
        perExecutorPolicy: {
          ...validated.perExecutorPolicy,
          codeChangeTask: {
            ...validated.perExecutorPolicy.codeChangeTask,
            requireWorktree: true,
            strictReview: true,
            verificationRequired: true,
          },
        },
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_GET_BRAIN, async () => service.getBrainSummary());
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_LIST_TARGETS, async (_event, workspaceId?: string) => {
    const validatedWorkspaceId =
      workspaceId === undefined
        ? undefined
        : validateInput(WorkspaceIdSchema, workspaceId, "workspace ID");
    return service.listTargets(validatedWorkspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_LIST_RUNS, async (_event, targetKey?: string) => {
    const validatedTargetKey =
      targetKey === undefined
        ? undefined
        : validateInput(TargetKeySchema, targetKey, "target key");
    return service.listRuns(validatedTargetKey);
  });
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_GET_TARGET_DETAIL, async (_event, targetKey: string) =>
    service.getTargetDetail(validateInput(TargetKeySchema, targetKey, "target key")),
  );
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_REFRESH, async () => service.refreshTargets());
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_RUN_NOW, async (_event, targetKey?: string) => {
    const validatedTargetKey =
      targetKey === undefined
        ? undefined
        : validateInput(TargetKeySchema, targetKey, "target key");
    return service.runNow(validatedTargetKey);
  });
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_RETRY_RUN, async (_event, runId: string) =>
    service.retryRun(validateInput(UUIDSchema, runId, "run ID")),
  );
  ipcMain.handle(
    IPC_CHANNELS.SUBCONSCIOUS_REVIEW_RUN,
    async (_event, runId: string, reviewStatus: "accepted" | "dismissed") =>
      service.reviewRun(validateInput(UUIDSchema, runId, "run ID"), reviewStatus),
  );
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_DISMISS_TARGET, async (_event, targetKey: string) =>
    service.dismissTarget(validateInput(TargetKeySchema, targetKey, "target key")),
  );
  ipcMain.handle(
    IPC_CHANNELS.SUBCONSCIOUS_RESET_HISTORY,
    async (): Promise<SubconsciousHistoryResetResult> => service.resetHistory(),
  );
}

export function setupImprovementHandlers(service: SubconsciousLoopService): void {
  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_GET_SETTINGS,
    async (): Promise<ImprovementLoopSettings> => service.getImprovementCompatibilitySettings(),
  );
  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_GET_ELIGIBILITY,
    async (): Promise<ImprovementEligibility> => getImprovementEligibility(),
  );
  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_SAVE_OWNER_ENROLLMENT,
    async (_event, signature: string): Promise<ImprovementEligibility> =>
      saveOwnerEnrollmentSignature(
        validateInput(TargetKeySchema, signature, "owner enrollment signature"),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_CLEAR_OWNER_ENROLLMENT,
    async (): Promise<ImprovementEligibility> => clearOwnerEnrollment(),
  );
  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_SAVE_SETTINGS,
    async (_event, settings: ImprovementLoopSettings): Promise<ImprovementLoopSettings> => {
      const validated = validateInput(
        ImprovementLoopSettingsSchema,
        settings,
        "improvement loop settings",
      );
      const current = service.getSettings();
      service.saveSettings({
        ...current,
        enabled: validated.enabled,
        autoRun: validated.autoRun,
        cadenceMinutes: validated.intervalMinutes,
        dispatchDefaults: {
          ...current.dispatchDefaults,
          autoDispatch: false,
        },
        perExecutorPolicy: {
          ...current.perExecutorPolicy,
          codeChangeTask: {
            ...current.perExecutorPolicy.codeChangeTask,
            requireWorktree: true,
            strictReview: true,
            verificationRequired: true,
          },
        },
      });
      return service.getImprovementCompatibilitySettings();
    },
  );
  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_LIST_CANDIDATES, async (_event, workspaceId?: string) => {
    const validatedWorkspaceId =
      workspaceId === undefined
        ? undefined
        : validateInput(WorkspaceIdSchema, workspaceId, "workspace ID");
    return service.listImprovementCandidates(validatedWorkspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_LIST_RUNS, async (_event, workspaceId?: string) => {
    const validatedWorkspaceId =
      workspaceId === undefined
        ? undefined
        : validateInput(WorkspaceIdSchema, workspaceId, "workspace ID");
    return service.listImprovementCampaigns(validatedWorkspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_REFRESH, async () => {
    const result = await service.refreshTargets();
    return { candidateCount: result.targetCount };
  });
  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_RUN_NEXT, async () => {
    const run = await service.runNow();
    return run ? service.listImprovementCampaigns().find((item) => item.id === run.id) || null : null;
  });
  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_RESET_HISTORY,
    async (): Promise<ImprovementHistoryResetResult> => service.resetImprovementCompatibilityHistory(),
  );
  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_RETRY_RUN, async (_event, runId: string) => {
    const run = await service.retryRun(validateInput(UUIDSchema, runId, "run ID"));
    return run ? service.listImprovementCampaigns().find((item) => item.id === run.id) || null : null;
  });
  ipcMain.handle(IPC_CHANNELS.IMPROVEMENT_DISMISS_CANDIDATE, async (_event, candidateId: string) => {
    const validatedCandidateId = validateInput(TargetKeySchema, candidateId, "candidate ID");
    const target = service.dismissTarget(validatedCandidateId);
    return target ? service.listImprovementCandidates(target.target.workspaceId).find((item) => item.id === candidateId) : undefined;
  });
  ipcMain.handle(
    IPC_CHANNELS.IMPROVEMENT_REVIEW_RUN,
    async (_event, runId: string, reviewStatus: "accepted" | "dismissed") => {
      const run = await service.reviewRun(
        validateInput(UUIDSchema, runId, "run ID"),
        reviewStatus,
      );
      return run ? service.listImprovementCampaigns().find((item) => item.id === run.id) : undefined;
    },
  );
}
