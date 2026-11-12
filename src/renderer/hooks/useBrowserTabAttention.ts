import { useEffect, useMemo, useRef } from "react";
import type { Task } from "../../shared/types";
import { isBrowserHost } from "../host/browser-capabilities";
import {
  createTabAttentionController,
  waitingSessionsFromTasks,
  type TabAttentionController,
} from "../host/browser-tab-attention";

const NONE: ReadonlyMap<string, string> = new Map();

export interface BrowserTabAttentionInput {
  /** Sessions the needs-you queue says wait on the user, with the reason to show. */
  queueWaiting: ReadonlyMap<string, string>;
  /** Whether the host has the queue. Without it, the task list decides. */
  fromQueue: boolean;
  tasks: readonly Task[];
}

/**
 * Browser sessions only: shows the sessions waiting on the user in the tab title and
 * favicon. Does nothing at all on desktop.
 */
export function useBrowserTabAttention({
  queueWaiting,
  fromQueue,
  tasks,
}: BrowserTabAttentionInput): void {
  const browser = isBrowserHost();
  const controllerRef = useRef<TabAttentionController | null>(null);
  const waiting = useMemo(() => {
    if (!browser) return NONE;
    return fromQueue ? queueWaiting : waitingSessionsFromTasks(tasks);
  }, [browser, fromQueue, queueWaiting, tasks]);

  useEffect(() => {
    if (!browser) return;
    const controller = createTabAttentionController(document, window);
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [browser]);

  useEffect(() => {
    controllerRef.current?.update(waiting);
  }, [waiting]);
}
