import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { RoutineService } from "../routines/service";
import type {
  RoutineWorkflowApprovalRequest,
  RoutineWorkflowDefinition,
  RoutineWorkflowEventEnvelope,
  RoutineWorkflowTestRequest,
} from "../../shared/routine-workflow";

export function setupRoutineHandlers(routineService: RoutineService): void {
  ipcMain.handle(IPC_CHANNELS.ROUTINE_LIST, async () => {
    return routineService.list();
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_GET, async (_, id: string) => {
    return routineService.get(id);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_LIST_RUNS, async (_, payload?: { routineId?: string; limit?: number }) => {
    return routineService.listRuns(payload?.routineId, payload?.limit);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_CREATE, async (_, input) => {
    return routineService.create(input);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_UPDATE, async (_, payload: { id: string; updates: Any }) => {
    return routineService.update(payload.id, payload.updates);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_REMOVE, async (_, id: string) => {
    return routineService.remove(id);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUN_NOW, async (_, id: string) => {
    return routineService.runNow(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_REGENERATE_API_TOKEN,
    async (_, payload: { routineId: string; triggerId: string }) => {
      return routineService.regenerateApiToken(payload.routineId, payload.triggerId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.ROUTINE_WORKFLOW_CAPABILITIES, async () => {
    return routineService.getWorkflowCapabilities();
  });

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_WORKFLOW_VALIDATE,
    async (_, payload: { workflow: RoutineWorkflowDefinition; allowIncomplete?: boolean }) => {
      return routineService.validateWorkflow(payload.workflow, Boolean(payload.allowIncomplete));
    },
  );

  ipcMain.handle(IPC_CHANNELS.ROUTINE_WORKFLOW_GENERATE, async (_, prompt: string) => {
    return routineService.generateWorkflowDraft(prompt);
  });

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_WORKFLOW_SAVE_DRAFT,
    async (_, payload: { routineId: string; workflow: RoutineWorkflowDefinition }) => {
      return routineService.saveWorkflowDraft(payload.routineId, payload.workflow);
    },
  );

  ipcMain.handle(IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_VERSIONS, async (_, routineId: string) => {
    return routineService.listWorkflowVersions(routineId);
  });

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_WORKFLOW_ACTIVATE,
    async (_, payload: { routineId: string; versionId: string }) => {
      return routineService.activateWorkflowVersion(payload.routineId, payload.versionId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.ROUTINE_WORKFLOW_TEST, async (_, request: RoutineWorkflowTestRequest) => {
    return routineService.testWorkflow(request);
  });

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_RUNS,
    async (_, payload?: { routineId?: string; limit?: number }) => {
      return routineService.listWorkflowRuns(payload?.routineId, payload?.limit);
    },
  );

  ipcMain.handle(IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_STEPS, async (_, runId: string) => {
    return routineService.listWorkflowRunSteps(runId);
  });

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_EVENTS,
    async (_, payload?: { routineId?: string; limit?: number }) => {
      return routineService.listWorkflowEvents(payload?.routineId, payload?.limit);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_EVENT_SAMPLES,
    async (_, payload?: { source?: string; limit?: number }) => {
      return routineService.listWorkflowEventSamples(payload?.source, payload?.limit);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_WORKFLOW_RESPOND_APPROVAL,
    async (_, request: RoutineWorkflowApprovalRequest) => {
      return routineService.respondToWorkflowApproval(request);
    },
  );

  ipcMain.handle(IPC_CHANNELS.ROUTINE_WORKFLOW_RETRY, async (_, runId: string) => {
    return routineService.retryWorkflowRun(runId);
  });

  ipcMain.handle(IPC_CHANNELS.ROUTINE_WORKFLOW_CANCEL, async (_, runId: string) => {
    return routineService.cancelWorkflowRun(runId);
  });

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_WORKFLOW_ENQUEUE_EVENT,
    async (_, envelope: RoutineWorkflowEventEnvelope) => {
      return routineService.enqueueWorkflowEvent(envelope);
    },
  );

  ipcMain.handle(IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_SECRETS, async () => {
    return routineService.listWorkflowSecrets();
  });

  ipcMain.handle(
    IPC_CHANNELS.ROUTINE_WORKFLOW_UPSERT_SECRET,
    async (_, input: { id?: string; name: string; value: string }) => {
      return routineService.upsertWorkflowSecret(input);
    },
  );

  ipcMain.handle(IPC_CHANNELS.ROUTINE_WORKFLOW_REMOVE_SECRET, async (_, id: string) => {
    return routineService.removeWorkflowSecret(id);
  });
}
