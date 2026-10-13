import type { AttentionItem, AttentionSnapshot } from "../../shared/attention";
import type { Task, Workspace } from "../../shared/types";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError, type WebRequestContext } from "../web/WebApplication";

export interface BrowserAttentionSources {
  /** The desktop app's needs-you queue; null until the app has started it. */
  getAttention: () => { snapshot(): Promise<AttentionSnapshot> } | null;
  resolveWorkspace: (
    workspaceId: string,
  ) => Workspace | null | undefined | Promise<Workspace | null | undefined>;
  getTask: (taskId: string) => Task | null | undefined | Promise<Task | null | undefined>;
}

/**
 * The needs-you queue for a paired browser: the same snapshot the desktop app shows,
 * limited to items in workspaces the browser may read. Items read only; every decision is
 * still made through the browser's own approval, question and task methods.
 */
export function createBrowserAttentionDefinitions(
  sources: BrowserAttentionSources,
): BrowserDesktopDefinitions {
  return {
    listAttention: {
      capability: "tasks.read",
      minArgs: 0,
      maxArgs: 0,
      handler: async (_args, context) => {
        assertSession(context);
        const attention = sources.getAttention();
        if (!attention) {
          throw new WebApplicationError(
            "HOST_UNAVAILABLE",
            "The needs-you queue is not running yet.",
            503,
            true,
          );
        }
        const snapshot = await attention.snapshot();
        const readable = new Map<string, Promise<boolean>>();
        const canRead = (workspaceId: string) => {
          let result = readable.get(workspaceId);
          if (!result) {
            result = Promise.resolve(sources.resolveWorkspace(workspaceId)).then((workspace) =>
              Boolean(workspace && workspace.id === workspaceId && workspace.permissions.read),
            );
            readable.set(workspaceId, result);
          }
          return result;
        };
        const visible: AttentionItem[] = [];
        for (const item of snapshot.items) {
          if (await canAccessItem(sources, item, canRead)) visible.push(item);
        }
        return { ...snapshot, items: visible } satisfies AttentionSnapshot;
      },
    },
  };
}

/**
 * An item is visible when its workspace is readable: its own, or its session's. Items that
 * belong to no workspace (due commitments, automation steps) are the user's own, as with
 * notifications.
 */
async function canAccessItem(
  sources: BrowserAttentionSources,
  item: AttentionItem,
  canRead: (workspaceId: string) => Promise<boolean>,
): Promise<boolean> {
  let workspaceId = item.workspaceId;
  if (item.taskId) {
    const task = await sources.getTask(item.taskId);
    if (!task?.workspaceId) return false;
    if (workspaceId && workspaceId !== task.workspaceId) return false;
    workspaceId = task.workspaceId;
  }
  return workspaceId ? canRead(workspaceId) : true;
}

function assertSession(context: WebRequestContext): void {
  if (!context.sessionId || !context.identity.profileId) {
    throw new WebApplicationError("UNAUTHENTICATED", "A paired browser session is required.", 401);
  }
}
