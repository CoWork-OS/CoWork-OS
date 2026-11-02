import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskEvent } from "../../shared/types";
import {
  effectiveTaskProposalStatus,
  type TaskProposal,
  type TaskProposalStartOptions,
} from "../../shared/task-proposals";
import { hasHostMethod } from "../host/browser-capabilities";
import {
  getTaskProposalFromEvent,
  mergeTaskProposals,
} from "../components/MainContent/turn-proposals";

export type TaskProposalAction = "start" | "here" | "dismiss";

export interface TaskProposalsState {
  /** Whether this host can act on suggestions (the desktop app). */
  available: boolean;
  /** Every proposal of the task, with expiry applied. */
  proposals: Map<string, TaskProposal>;
  busy: Record<string, TaskProposalAction | undefined>;
  errors: Record<string, string | undefined>;
  start: (proposalId: string, options?: TaskProposalStartOptions) => Promise<void>;
  startAll: (proposalIds: string[]) => Promise<void>;
  doHere: (proposalId: string) => Promise<void>;
  dismiss: (proposalId: string) => Promise<void>;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || "Failed";
}

/**
 * The suggested tasks of one task: loaded once from the host, then kept current from the
 * task's `task_proposal_*` events and from the person's own actions on the card.
 */
export function useTaskProposals(
  taskId: string | undefined,
  events: TaskEvent[],
): TaskProposalsState {
  const available =
    hasHostMethod("listTaskProposals") &&
    typeof window.electronAPI?.listTaskProposals === "function";
  const [loaded, setLoaded] = useState<Map<string, TaskProposal>>(() => new Map());
  const [local, setLocal] = useState<Map<string, TaskProposal>>(() => new Map());
  const [busy, setBusy] = useState<Record<string, TaskProposalAction | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    setLoaded(new Map());
    setLocal(new Map());
    setBusy({});
    setErrors({});
    if (!taskId || !available) return;
    let current = true;
    void window.electronAPI
      .listTaskProposals(taskId)
      .then((list) => {
        if (current && Array.isArray(list)) {
          setLoaded(new Map(list.map((proposal) => [proposal.id, proposal])));
        }
      })
      .catch(() => {
        // Without the list the card still shows proposals from the loaded events.
      });
    return () => {
      current = false;
    };
  }, [taskId, available]);

  const fromEvents = useMemo(() => {
    const found: TaskProposal[] = [];
    for (const event of events) {
      const proposal = getTaskProposalFromEvent(event);
      if (proposal && proposal.taskId === taskId) found.push(proposal);
    }
    return found;
  }, [events, taskId]);

  const proposals = useMemo(() => {
    const merged = mergeTaskProposals(mergeTaskProposals(loaded, fromEvents), local.values());
    const now = Date.now();
    for (const [id, proposal] of merged) {
      const status = effectiveTaskProposalStatus(proposal, now);
      if (status !== proposal.status) merged.set(id, { ...proposal, status });
    }
    return merged;
  }, [loaded, fromEvents, local]);

  const run = useCallback(
    async (
      proposalId: string,
      action: TaskProposalAction,
      perform: () => Promise<Partial<TaskProposal> | void>,
    ) => {
      setBusy((prev) => ({ ...prev, [proposalId]: action }));
      setErrors((prev) => ({ ...prev, [proposalId]: undefined }));
      try {
        const settled = await perform();
        if (settled) {
          setLocal((prev) => {
            const known = proposals.get(proposalId);
            if (!known) return prev;
            const next = new Map(prev);
            next.set(proposalId, { ...known, ...settled, decidedAt: Date.now() });
            return next;
          });
        }
      } catch (error) {
        setErrors((prev) => ({ ...prev, [proposalId]: errorText(error) }));
      } finally {
        setBusy((prev) => ({ ...prev, [proposalId]: undefined }));
      }
    },
    [proposals],
  );

  const start = useCallback(
    (proposalId: string, options?: TaskProposalStartOptions) =>
      run(proposalId, "start", async () => {
        const task = await window.electronAPI.startTaskProposal(proposalId, options);
        return { status: "started", ...(task?.id ? { startedTaskId: task.id } : {}) };
      }),
    [run],
  );

  const startAll = useCallback(
    async (proposalIds: string[]) => {
      if (!taskId || proposalIds.length === 0) return;
      setBusy((prev) => ({
        ...prev,
        ...Object.fromEntries(proposalIds.map((id) => [id, "start" as const])),
      }));
      try {
        const results = await window.electronAPI.startAllTaskProposals(taskId, proposalIds);
        setLocal((prev) => {
          const next = new Map(prev);
          for (const result of results) {
            const known = proposals.get(result.proposalId);
            if (known && result.taskId) {
              next.set(result.proposalId, {
                ...known,
                status: "started",
                startedTaskId: result.taskId,
                decidedAt: Date.now(),
              });
            }
          }
          return next;
        });
        setErrors((prev) => ({
          ...prev,
          ...Object.fromEntries(
            results
              .filter((result) => result.error)
              .map((result) => [result.proposalId, result.error]),
          ),
        }));
      } catch (error) {
        const message = errorText(error);
        setErrors((prev) => ({
          ...prev,
          ...Object.fromEntries(proposalIds.map((id) => [id, message])),
        }));
      } finally {
        setBusy((prev) => ({
          ...prev,
          ...Object.fromEntries(proposalIds.map((id) => [id, undefined])),
        }));
      }
    },
    [taskId, proposals],
  );

  const doHere = useCallback(
    (proposalId: string) =>
      run(proposalId, "here", async () => {
        await window.electronAPI.doTaskProposalHere(proposalId);
        return { status: "done_here" };
      }),
    [run],
  );

  const dismiss = useCallback(
    (proposalId: string) =>
      run(proposalId, "dismiss", async () => {
        await window.electronAPI.dismissTaskProposal(proposalId);
        return { status: "dismissed" };
      }),
    [run],
  );

  return useMemo(
    () => ({ available, proposals, busy, errors, start, startAll, doHere, dismiss }),
    [available, proposals, busy, errors, start, startAll, doHere, dismiss],
  );
}
