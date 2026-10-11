import { useCallback, useEffect, useRef, useState } from "react";
import { hasHostMethod } from "../../host/browser-capabilities";
import { describePurgeCounts } from "./memory-knowledge-model";
import type { MemoryClearSummary, WorkspaceMemorySettings } from "./memory-settings-model";

export interface WorkspaceMemoryStats {
  compressionTokensLast24h?: number;
  compressionDailyTokenBudget?: number;
}

export interface WorkspaceMemorySettingsState {
  sessions: Array<{ id: string; title: string; parentTaskId: string | null }>;
  settings: WorkspaceMemorySettings | null;
  stats: WorkspaceMemoryStats | null;
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  clearing: boolean;
  clearSummary: MemoryClearSummary | null;
  reload: () => void;
  save: (updates: Partial<WorkspaceMemorySettings>) => Promise<void>;
  clear: (taskId?: string) => Promise<void>;
}

const CLEAR_CONFIRM =
  "Are you sure you want to clear all memories for this workspace? This cannot be undone.";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The selected workspace's memory settings (MemoryService): loaded per workspace, with
 * replies from a previously selected workspace ignored.
 */
export function useWorkspaceMemorySettings(
  workspaceId: string,
  options: {
    onError: (message: string) => void;
    onSettingsChanged?: () => void;
    confirm?: (message: string) => boolean;
  },
): WorkspaceMemorySettingsState {
  const [settings, setSettings] = useState<WorkspaceMemorySettings | null>(null);
  const [sessions, setSessions] = useState<WorkspaceMemorySettingsState["sessions"]>([]);
  const [stats, setStats] = useState<WorkspaceMemoryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearSummary, setClearSummary] = useState<MemoryClearSummary | null>(null);
  const active = useRef(workspaceId);
  active.current = workspaceId;
  const generation = useRef(0);
  const callbacks = useRef(options);
  callbacks.current = options;

  const load = useCallback(async () => {
    if (!workspaceId) return;
    const current = ++generation.current;
    const isCurrent = () => current === generation.current && active.current === workspaceId;
    try {
      setLoading(true);
      setLoadError(null);
      const [loaded, loadedStats, scope] = await Promise.all([
        window.electronAPI.getMemorySettings(workspaceId),
        hasHostMethod("getMemoryStats")
          ? window.electronAPI.getMemoryStats(workspaceId).catch(() => null)
          : null,
        hasHostMethod("getMemoryClearScope")
          ? window.electronAPI.getMemoryClearScope(workspaceId)
          : null,
      ]);
      if (!isCurrent()) return;
      setSettings(loaded);
      setSessions(scope?.tasks || []);
      setStats(loadedStats);
    } catch (error) {
      if (isCurrent()) setLoadError(errorText(error, "Failed to load memory settings."));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setSettings(null);
    setStats(null);
    setSaving(false);
    setClearing(false);
    setClearSummary(null);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const save = async (updates: Partial<WorkspaceMemorySettings>) => {
    if (!settings || !workspaceId) return;
    try {
      setSaving(true);
      await window.electronAPI.saveMemorySettings({ workspaceId, settings: updates });
      const saved = await window.electronAPI.getMemorySettings(workspaceId);
      if (active.current !== workspaceId) return;
      setSettings(saved);
      callbacks.current.onSettingsChanged?.();
    } catch (error) {
      if (active.current === workspaceId)
        callbacks.current.onError(errorText(error, "Failed to save memory settings."));
    } finally {
      if (active.current === workspaceId) setSaving(false);
    }
  };

  const clear = async (taskId?: string) => {
    if (!workspaceId) return;
    const confirm = callbacks.current.confirm ?? ((message: string) => window.confirm(message));
    try {
      setClearing(true);
      if (!hasHostMethod("getMemoryClearScope"))
        throw new Error(
          "Update the app runtime to preview the affected sessions before clearing memory.",
        );
      const scope = await window.electronAPI.getMemoryClearScope(workspaceId);
      if (active.current !== workspaceId) return;
      const session = taskId ? scope.tasks.find((task) => task.id === taskId) : undefined;
      if (taskId && !session)
        throw new Error("This session is no longer in the selected workspace.");
      const message = session
        ? `Permanently clear memory attributed to “${session.title}” and its agents? Task history and deliverables stay available. Future messages in this session will stay out of memory.`
        : `${CLEAR_CONFIRM}\n\nAffected sessions (${scope.tasks.length}, including agents):\n${scope.tasks.map((task) => `• ${task.title} (${task.id.slice(0, 8)})`).join("\n")}\n\nTask history and deliverables stay available. Use the session selector to clear only one workflow.`;
      if (!confirm(message) || active.current !== workspaceId) return;
      setClearSummary(null);
      const result = taskId
        ? await window.electronAPI.clearSessionMemory(workspaceId, taskId)
        : await window.electronAPI.clearMemory(
            workspaceId,
            scope.tasks.map((task) => task.id),
          );
      if (active.current !== workspaceId) return;
      const lines = describePurgeCounts(result?.counts);
      setClearSummary({
        lines: lines.length > 0 ? lines : ["Nothing was stored for this workspace."],
        notes: Array.isArray(result?.notes) ? result.notes : [],
        errors: Object.entries(result?.errors ?? {}).map(
          ([store, message]) => `${store}: ${String(message)}`,
        ),
      });
      await load();
    } catch (error) {
      if (active.current === workspaceId)
        callbacks.current.onError(errorText(error, "Failed to clear memory."));
    } finally {
      if (active.current === workspaceId) setClearing(false);
    }
  };

  return {
    sessions,
    settings,
    stats,
    loading,
    loadError,
    saving,
    clearing,
    clearSummary,
    reload: () => void load(),
    save,
    clear,
  };
}
