import { IPC_CHANNELS } from "../../shared/types";
import {
  createAnswerSurfaceIpcHandlers,
  type AnswerSurfaceIpcDeps,
} from "../../electron/answer-surfaces/answer-surface-operations";
import type { HostCapabilityName } from "../../shared/host-api/contracts";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";

/**
 * Answer surfaces in the browser host: the same operations as the desktop IPC, so an
 * answer keeps its control values and photos in either view. `taskExists` must also
 * check that this browser session may read the task's workspace.
 */
export function createBrowserAnswerSurfaceDefinitions(
  deps: AnswerSurfaceIpcDeps,
): BrowserDesktopDefinitions {
  const operations = createAnswerSurfaceIpcHandlers(deps);
  const define = (channel: string, capability: HostCapabilityName) => ({
    capability,
    // Saving is a last-writer-wins upsert of UI state, safe to repeat, so it does not
    // take an operation receipt: a slider would otherwise spend the session's budget.
    mutation: false,
    minArgs: 1,
    maxArgs: 1,
    handler: ([raw]: unknown[]) => operations[channel](raw),
  });
  return {
    getAnswerSurfaceState: define(IPC_CHANNELS.ANSWER_SURFACE_GET_STATE, "tasks.read"),
    saveAnswerSurfaceState: define(IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE, "tasks.followUp"),
    resolveAnswerImages: define(IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES, "tasks.read"),
  };
}
