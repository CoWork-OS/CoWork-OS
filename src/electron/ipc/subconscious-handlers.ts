import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import type {
  SubconsciousHistoryResetResult,
  SubconsciousSettings,
} from "../../shared/subconscious";
import { DEFAULT_SUBCONSCIOUS_SETTINGS } from "../../shared/subconscious";
import type { SubconsciousLoopService } from "../subconscious/SubconsciousLoopService";
import {
  SubconsciousSettingsSchema,
  TargetKeySchema,
  WorkspaceIdSchema,
  validateInput,
} from "../utils/validation";

export function setupSubconsciousHandlers(service: SubconsciousLoopService): void {
  ipcMain.handle(
    IPC_CHANNELS.SUBCONSCIOUS_GET_SETTINGS,
    async (): Promise<SubconsciousSettings> => {
      return service.getSettings();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUBCONSCIOUS_SAVE_SETTINGS,
    async (_event, input: Partial<SubconsciousSettings>): Promise<SubconsciousSettings> => {
      // `phaseModels` was never read; drop it so older clients that still send it validate.
      const { phaseModels: _legacyPhaseModels, ...settings } = (input ||
        {}) as Partial<SubconsciousSettings> & { phaseModels?: unknown };
      const validated = validateInput(
        SubconsciousSettingsSchema,
        {
          ...DEFAULT_SUBCONSCIOUS_SETTINGS,
          ...settings,
          dispatchDefaults: {
            ...DEFAULT_SUBCONSCIOUS_SETTINGS.dispatchDefaults,
            ...settings.dispatchDefaults,
            defaultKinds: {
              ...DEFAULT_SUBCONSCIOUS_SETTINGS.dispatchDefaults.defaultKinds,
              ...settings.dispatchDefaults?.defaultKinds,
            },
          },
          notificationPolicy: {
            ...DEFAULT_SUBCONSCIOUS_SETTINGS.notificationPolicy,
            ...settings.notificationPolicy,
          },
          perExecutorPolicy: {
            ...DEFAULT_SUBCONSCIOUS_SETTINGS.perExecutorPolicy,
            ...settings.perExecutorPolicy,
            codeChangeTask: {
              ...DEFAULT_SUBCONSCIOUS_SETTINGS.perExecutorPolicy.codeChangeTask,
              ...settings.perExecutorPolicy?.codeChangeTask,
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
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_GET_TARGET_DETAIL, async (_event, targetKey: string) =>
    service.getTargetDetail(validateInput(TargetKeySchema, targetKey, "target key")),
  );
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_REFRESH, async () => service.refreshTargets());
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_RUN_NOW, async (_event, targetKey?: string) => {
    const validatedTargetKey =
      targetKey === undefined ? undefined : validateInput(TargetKeySchema, targetKey, "target key");
    return service.runNow(validatedTargetKey);
  });
  ipcMain.handle(IPC_CHANNELS.SUBCONSCIOUS_DISMISS_TARGET, async (_event, targetKey: string) =>
    service.dismissTarget(validateInput(TargetKeySchema, targetKey, "target key")),
  );
  ipcMain.handle(
    IPC_CHANNELS.SUBCONSCIOUS_RESET_HISTORY,
    async (): Promise<SubconsciousHistoryResetResult> => service.resetHistory(),
  );
}
