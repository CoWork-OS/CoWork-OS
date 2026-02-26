import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentRoleData } from "../../electron/preload";
import type {
  AgentTeam,
  AgentTeamItem,
  AgentTeamItemStatus,
  AgentTeamMember,
  AgentTeamRun,
  AgentTeamRunStatus,
  Task,
} from "../../shared/types";

type AgentRole = AgentRoleData;

interface AgentTeamsPanelProps {
  workspaceId: string;
  agents: AgentRole[];
  tasks: Task[];
  onOpenTask?: (taskId: string) => void;
}

type TeamRunEvent = {
  type: string;
  timestamp?: number;
  [key: string]: Any;
};

function formatTime(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function summarizeEvent(event: TeamRunEvent): string {
  switch (event.type) {
    case "team_created":
      return `Team created: ${event.team?.name || event.teamId || ""}`.trim();
    case "team_updated":
      return `Team updated: ${event.team?.name || event.teamId || ""}`.trim();
    case "team_deleted":
      return `Team deleted: ${event.teamId || ""}`.trim();
    case "team_member_added":
      return `Member added: ${event.member?.agentRoleId || ""}`.trim();
    case "team_member_updated":
      return `Member updated: ${event.member?.agentRoleId || ""}`.trim();
    case "team_member_removed":
      return `Member removed: ${event.agentRoleId || ""}`.trim();
    case "team_members_reordered":
      return `Members reordered`;
    case "team_run_created":
      return `Run created: ${event.run?.id || ""}`.trim();
    case "team_run_updated":
      return `Run ${event.run?.id || ""} -> ${event.run?.status || ""}`.trim();
    case "team_item_created":
      return `Item created: ${event.item?.title || ""}`.trim();
    case "team_item_updated":
      return `Item updated: ${event.item?.title || ""} -> ${event.item?.status || ""}`.trim();
    case "team_item_deleted":
      return `Item deleted`;
    case "team_item_moved":
      return `Item moved: ${event.item?.title || ""}`.trim();
    case "team_item_spawned":
      return `Spawned task for: ${event.item?.title || ""}`.trim();
    default:
      return event.type;
  }
}

export function AgentTeamsPanel({ workspaceId, agents, tasks, onOpenTask }: AgentTeamsPanelProps) {
  const [teams, setTeams] = useState<AgentTeam[]>([]);
  const [showInactiveTeams, setShowInactiveTeams] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamMembers, setTeamMembers] = useState<AgentTeamMember[]>([]);
  const [runs, setRuns] = useState<AgentTeamRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [items, setItems] = useState<AgentTeamItem[]>([]);
  const [events, setEvents] = useState<TeamRunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingTeams, setIsLoadingTeams] = useState(true);

  // New Team form
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamDescription, setNewTeamDescription] = useState("");
  const [newTeamLeadRoleId, setNewTeamLeadRoleId] = useState<string>("");
  const [newTeamMaxParallel, setNewTeamMaxParallel] = useState<number>(4);
  const [newTeamDefaultModelPreference, setNewTeamDefaultModelPreference] =
    useState<string>("cheaper");
  const [newTeamDefaultPersonality, setNewTeamDefaultPersonality] = useState<string>("concise");

  // Selected Team edit draft (simple inline editing)
  const selectedTeam = useMemo(
    () => (selectedTeamId ? teams.find((t) => t.id === selectedTeamId) : undefined),
    [teams, selectedTeamId],
  );
  const [teamDraft, setTeamDraft] = useState<{
    name: string;
    description: string;
    leadAgentRoleId: string;
    maxParallelAgents: number;
    defaultModelPreference: string;
    defaultPersonality: string;
    isActive: boolean;
    persistent: boolean;
  } | null>(null);

  // New Member form
  const [newMemberRoleId, setNewMemberRoleId] = useState("");
  const [newMemberRequired, setNewMemberRequired] = useState(false);
  const [newMemberGuidance, setNewMemberGuidance] = useState("");

  // New Run form
  const [newRunRootTaskId, setNewRunRootTaskId] = useState("");
  const [newRunStartNow, setNewRunStartNow] = useState(true);
  const [newRunCollaborative, setNewRunCollaborative] = useState(false);

  // New Item form
  const [newItemTitle, setNewItemTitle] = useState("");
  const [newItemOwnerRoleId, setNewItemOwnerRoleId] = useState("");
  const [newItemDescription, setNewItemDescription] = useState("");

  const agentById = useMemo(() => {
    const map = new Map<string, AgentRole>();
    agents.forEach((a) => map.set(a.id, a));
    return map;
  }, [agents]);

  const tasksById = useMemo(() => {
    const map = new Map<string, Task>();
    tasks.forEach((t) => map.set(t.id, t));
    return map;
  }, [tasks]);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort(
      (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
    );
  }, [tasks]);

  const loadTeams = useCallback(async () => {
    try {
      setIsLoadingTeams(true);
      setError(null);
      const loaded = await window.electronAPI.listTeams(workspaceId, showInactiveTeams);
      setTeams(loaded);
      setSelectedTeamId((prev) => {
        if (prev && loaded.some((t) => t.id === prev)) return prev;
        return loaded[0]?.id ?? null;
      });
    } catch (err: Any) {
      console.error("Failed to load teams:", err);
      setError(err?.message || "Failed to load teams");
    } finally {
      setIsLoadingTeams(false);
    }
  }, [workspaceId, showInactiveTeams]);

  const loadTeamDetails = useCallback(async (teamId: string) => {
    try {
      setError(null);
      const [loadedMembers, loadedRuns] = await Promise.all([
        window.electronAPI.listTeamMembers(teamId),
        window.electronAPI.listTeamRuns(teamId, 30),
      ]);
      setTeamMembers(loadedMembers);
      setRuns(loadedRuns);
      setSelectedRunId((prev) => {
        if (prev && loadedRuns.some((r) => r.id === prev)) return prev;
        return loadedRuns[0]?.id ?? null;
      });
    } catch (err: Any) {
      console.error("Failed to load team details:", err);
      setError(err?.message || "Failed to load team details");
    }
  }, []);

  const loadRunItems = useCallback(async (runId: string) => {
    try {
      setError(null);
      const loaded = await window.electronAPI.listTeamItems(runId);
      setItems(loaded);
    } catch (err: Any) {
      console.error("Failed to load run items:", err);
      setError(err?.message || "Failed to load run items");
    }
  }, []);

  useEffect(() => {
    void loadTeams();
    // Clear selection-derived state when workspace changes.
    setSelectedRunId(null);
    setItems([]);
    setEvents([]);
  }, [workspaceId, showInactiveTeams, loadTeams]);

  useEffect(() => {
    if (!selectedTeamId) {
      setTeamMembers([]);
      setRuns([]);
      setSelectedRunId(null);
      setItems([]);
      setTeamDraft(null);
      return;
    }
    void loadTeamDetails(selectedTeamId);
  }, [selectedTeamId, loadTeamDetails]);

  useEffect(() => {
    if (!selectedRunId) {
      setItems([]);
      return;
    }
    void loadRunItems(selectedRunId);
  }, [selectedRunId, loadRunItems]);

  useEffect(() => {
    if (!selectedTeam) {
      setTeamDraft(null);
      return;
    }
    setTeamDraft({
      name: selectedTeam.name,
      description: selectedTeam.description || "",
      leadAgentRoleId: selectedTeam.leadAgentRoleId,
      maxParallelAgents: selectedTeam.maxParallelAgents || 1,
      defaultModelPreference: selectedTeam.defaultModelPreference || "same",
      defaultPersonality: selectedTeam.defaultPersonality || "same",
      isActive: selectedTeam.isActive,
      persistent: selectedTeam.persistent ?? false,
    });
  }, [selectedTeamId]);

  useEffect(() => {
    // Subscribe to daemon+IPC broadcasts.
    const unsubscribe = window.electronAPI.onTeamRunEvent((event) => {
      setEvents((prev) => [event as TeamRunEvent, ...prev].slice(0, 200));
      // Keep local state consistent with minimal bookkeeping (no full reloads).
      switch (event.type) {
        case "team_created":
          setTeams((prev) => {
            const team = event.team as AgentTeam | undefined;
            if (!team) return prev;
            const existing = prev.some((t) => t.id === team.id);
            const next = existing
              ? prev.map((t) => (t.id === team.id ? team : t))
              : [...prev, team];
            next.sort((a, b) => a.name.localeCompare(b.name));
            return next;
          });
          break;
        case "team_updated":
          setTeams((prev) =>
            prev.map((t) => (t.id === event.team?.id ? (event.team as AgentTeam) : t)),
          );
          break;
        case "team_deleted":
          setTeams((prev) => prev.filter((t) => t.id !== event.teamId));
          setSelectedTeamId((prev) => (prev === event.teamId ? null : prev));
          break;
        case "team_member_added":
          if (event.member?.teamId === selectedTeamId) {
            setTeamMembers((prev) => {
              const existing = prev.some((m) => m.id === event.member.id);
              const next = existing
                ? prev.map((m) => (m.id === event.member.id ? event.member : m))
                : [...prev, event.member];
              return next.sort((a, b) => a.memberOrder - b.memberOrder);
            });
          }
          break;
        case "team_member_updated":
          if (event.member?.teamId === selectedTeamId) {
            setTeamMembers((prev) =>
              prev.map((m) => (m.id === event.member.id ? event.member : m)),
            );
          }
          break;
        case "team_member_removed":
          if (event.teamId === selectedTeamId) {
            setTeamMembers((prev) => prev.filter((m) => m.agentRoleId !== event.agentRoleId));
          }
          break;
        case "team_members_reordered":
          if (event.teamId === selectedTeamId && Array.isArray(event.members)) {
            setTeamMembers(event.members);
          }
          break;
        case "team_run_created":
          if (event.run?.teamId === selectedTeamId) {
            setRuns((prev) => {
              const run = event.run as AgentTeamRun;
              const existing = prev.some((r) => r.id === run.id);
              return existing ? prev.map((r) => (r.id === run.id ? run : r)) : [run, ...prev];
            });
            setSelectedRunId((prev) => prev ?? event.run.id);
          }
          break;
        case "team_run_updated":
          if (event.run?.teamId === selectedTeamId) {
            setRuns((prev) => {
              const run = event.run as AgentTeamRun;
              const existing = prev.some((r) => r.id === run.id);
              return existing ? prev.map((r) => (r.id === run.id ? run : r)) : [run, ...prev];
            });
          }
          break;
        case "team_item_created":
          if (event.item?.teamRunId === selectedRunId) {
            setItems((prev) => {
              const item = event.item as AgentTeamItem;
              const existing = prev.some((i) => i.id === item.id);
              return existing ? prev.map((i) => (i.id === item.id ? item : i)) : [...prev, item];
            });
          }
          break;
        case "team_item_updated":
          if (event.item?.teamRunId === selectedRunId) {
            setItems((prev) => {
              const item = event.item as AgentTeamItem;
              const existing = prev.some((i) => i.id === item.id);
              return existing ? prev.map((i) => (i.id === item.id ? item : i)) : [...prev, item];
            });
          }
          break;
        case "team_item_deleted":
          if (event.teamRunId === selectedRunId) {
            setItems((prev) => prev.filter((i) => i.id !== event.itemId));
          }
          break;
        case "team_item_moved":
        case "team_item_spawned":
          if (event.item?.teamRunId === selectedRunId) {
            setItems((prev) =>
              prev.map((i) => (i.id === event.item.id ? (event.item as AgentTeamItem) : i)),
            );
          }
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [selectedTeamId, selectedRunId]);

  const handleCreateTeam = useCallback(async () => {
    const leadId = newTeamLeadRoleId || agents.find((a) => a.isActive)?.id || "";
    if (!newTeamName.trim()) {
      setError("Team name is required");
      return;
    }
    if (!leadId) {
      setError("Lead agent role is required");
      return;
    }
    try {
      setError(null);
      const created = await window.electronAPI.createTeam({
        workspaceId,
        name: newTeamName.trim(),
        description: newTeamDescription.trim() || undefined,
        leadAgentRoleId: leadId,
        maxParallelAgents: Math.max(1, Number(newTeamMaxParallel) || 1),
        defaultModelPreference: newTeamDefaultModelPreference,
        defaultPersonality: newTeamDefaultPersonality,
        isActive: true,
      });
      setTeams((prev) => {
        const next = [...prev, created];
        next.sort((a, b) => a.name.localeCompare(b.name));
        return next;
      });
      setSelectedTeamId(created.id);
      setNewTeamName("");
      setNewTeamDescription("");
      setNewTeamLeadRoleId("");
      setNewTeamMaxParallel(4);
      setNewTeamDefaultModelPreference("cheaper");
      setNewTeamDefaultPersonality("concise");
    } catch (err: Any) {
      console.error("Failed to create team:", err);
      setError(err?.message || "Failed to create team");
    }
  }, [
    workspaceId,
    newTeamName,
    newTeamDescription,
    newTeamLeadRoleId,
    newTeamMaxParallel,
    newTeamDefaultModelPreference,
    newTeamDefaultPersonality,
    agents,
  ]);

  const handleSaveTeam = useCallback(async () => {
    if (!selectedTeam || !teamDraft) return;
    try {
      setError(null);
      const updated = await window.electronAPI.updateTeam({
        id: selectedTeam.id,
        name: teamDraft.name.trim(),
        description: teamDraft.description.trim() || null,
        leadAgentRoleId: teamDraft.leadAgentRoleId,
        maxParallelAgents: Math.max(1, Number(teamDraft.maxParallelAgents) || 1),
        defaultModelPreference: teamDraft.defaultModelPreference,
        defaultPersonality: teamDraft.defaultPersonality,
        isActive: teamDraft.isActive,
        persistent: teamDraft.persistent,
      });
      if (updated) {
        setTeams((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      }
    } catch (err: Any) {
      console.error("Failed to update team:", err);
      setError(err?.message || "Failed to update team");
    }
  }, [selectedTeam?.id, teamDraft]);

  const handleDeleteTeam = useCallback(async () => {
    if (!selectedTeam) return;
    if (!confirm(`Delete team "${selectedTeam.name}"? This will delete runs and items.`)) return;
    try {
      setError(null);
      const res = await window.electronAPI.deleteTeam(selectedTeam.id);
      if (res?.success) {
        setTeams((prev) => prev.filter((t) => t.id !== selectedTeam.id));
        setSelectedTeamId(null);
      }
    } catch (err: Any) {
      console.error("Failed to delete team:", err);
      setError(err?.message || "Failed to delete team");
    }
  }, [selectedTeam?.id]);

  const handleAddMember = useCallback(async () => {
    if (!selectedTeamId) return;
    if (!newMemberRoleId) {
      setError("Pick an agent role to add");
      return;
    }
    try {
      setError(null);
      const member = await window.electronAPI.addTeamMember({
        teamId: selectedTeamId,
        agentRoleId: newMemberRoleId,
        isRequired: newMemberRequired,
        roleGuidance: newMemberGuidance.trim() || undefined,
      });
      setTeamMembers((prev) => {
        const existing = prev.some((m) => m.id === member.id);
        const next = existing
          ? prev.map((m) => (m.id === member.id ? member : m))
          : [...prev, member];
        return next.sort((a, b) => a.memberOrder - b.memberOrder);
      });
      setNewMemberRoleId("");
      setNewMemberRequired(false);
      setNewMemberGuidance("");
    } catch (err: Any) {
      console.error("Failed to add team member:", err);
      setError(err?.message || "Failed to add team member");
    }
  }, [selectedTeamId, newMemberRoleId, newMemberRequired, newMemberGuidance]);

  const handleRemoveMember = useCallback(
    async (member: AgentTeamMember) => {
      if (!selectedTeamId) return;
      const role = agentById.get(member.agentRoleId);
      if (!confirm(`Remove ${role?.displayName || "member"} from this team?`)) return;
      try {
        setError(null);
        await window.electronAPI.removeTeamMember(selectedTeamId, member.agentRoleId);
        setTeamMembers((prev) => prev.filter((m) => m.id !== member.id));
      } catch (err: Any) {
        console.error("Failed to remove team member:", err);
        setError(err?.message || "Failed to remove team member");
      }
    },
    [selectedTeamId, agentById],
  );

  const handleUpdateMember = useCallback(
    async (memberId: string, updates: Partial<AgentTeamMember>) => {
      try {
        setError(null);
        const updated = await window.electronAPI.updateTeamMember({
          id: memberId,
          ...(updates.isRequired !== undefined ? { isRequired: updates.isRequired } : {}),
          ...(updates.roleGuidance !== undefined
            ? { roleGuidance: updates.roleGuidance || null }
            : {}),
          ...(updates.memberOrder !== undefined ? { memberOrder: updates.memberOrder } : {}),
        });
        if (updated) {
          setTeamMembers((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        }
      } catch (err: Any) {
        console.error("Failed to update team member:", err);
        setError(err?.message || "Failed to update team member");
      }
    },
    [],
  );

  const handleReorderMember = useCallback(
    async (memberId: string, direction: "up" | "down") => {
      if (!selectedTeamId) return;
      const idx = teamMembers.findIndex((m) => m.id === memberId);
      if (idx === -1) return;
      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= teamMembers.length) return;

      const ordered = [...teamMembers];
      const [m] = ordered.splice(idx, 1);
      ordered.splice(targetIdx, 0, m);

      try {
        setError(null);
        const updated = await window.electronAPI.reorderTeamMembers(
          selectedTeamId,
          ordered.map((x) => x.id),
        );
        setTeamMembers(updated);
      } catch (err: Any) {
        console.error("Failed to reorder team members:", err);
        setError(err?.message || "Failed to reorder team members");
      }
    },
    [selectedTeamId, teamMembers],
  );

  const handleCreateRun = useCallback(async () => {
    if (!selectedTeamId) return;
    if (!newRunRootTaskId) {
      setError("Pick a root task");
      return;
    }
    try {
      setError(null);
      const run = await window.electronAPI.createTeamRun({
        teamId: selectedTeamId,
        rootTaskId: newRunRootTaskId,
        status: newRunStartNow ? "running" : "pending",
        collaborativeMode: newRunCollaborative,
      });
      setRuns((prev) => [run, ...prev]);
      setSelectedRunId(run.id);
    } catch (err: Any) {
      console.error("Failed to create team run:", err);
      setError(err?.message || "Failed to create team run");
    }
  }, [selectedTeamId, newRunRootTaskId, newRunStartNow, newRunCollaborative]);

  const selectedRun = useMemo(
    () => (selectedRunId ? runs.find((r) => r.id === selectedRunId) : undefined),
    [runs, selectedRunId],
  );

  const handleUpdateRunStatus = useCallback(
    async (status: "resume" | "pause" | "cancel") => {
      if (!selectedRunId) return;
      try {
        setError(null);
        if (status === "resume") {
          await window.electronAPI.resumeTeamRun(selectedRunId);
        } else if (status === "pause") {
          await window.electronAPI.pauseTeamRun(selectedRunId);
        } else {
          await window.electronAPI.cancelTeamRun(selectedRunId);
        }
      } catch (err: Any) {
        console.error("Failed to update team run:", err);
        setError(err?.message || "Failed to update team run");
      }
    },
    [selectedRunId],
  );

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.createdAt - b.createdAt;
    });
  }, [items]);

  const handleCreateItem = useCallback(async () => {
    if (!selectedRunId) return;
    if (!newItemTitle.trim()) {
      setError("Item title is required");
      return;
    }
    try {
      setError(null);
      const maxSort = sortedItems.reduce((acc, i) => Math.max(acc, i.sortOrder), 0);
      const created = await window.electronAPI.createTeamItem({
        teamRunId: selectedRunId,
        title: newItemTitle.trim(),
        description: newItemDescription.trim() || undefined,
        ownerAgentRoleId: newItemOwnerRoleId || undefined,
        status: "todo",
        sortOrder: maxSort + 1,
      });
      setItems((prev) => [...prev, created]);
      setNewItemTitle("");
      setNewItemDescription("");
      setNewItemOwnerRoleId("");
    } catch (err: Any) {
      console.error("Failed to create item:", err);
      setError(err?.message || "Failed to create item");
    }
  }, [selectedRunId, newItemTitle, newItemDescription, newItemOwnerRoleId, sortedItems]);

  const handleUpdateItem = useCallback(async (itemId: string, updates: Partial<AgentTeamItem>) => {
    try {
      setError(null);
      const updated = await window.electronAPI.updateTeamItem({
        id: itemId,
        ...(updates.title !== undefined ? { title: updates.title } : {}),
        ...(updates.description !== undefined ? { description: updates.description || null } : {}),
        ...(updates.ownerAgentRoleId !== undefined
          ? { ownerAgentRoleId: updates.ownerAgentRoleId || null }
          : {}),
        ...(updates.sourceTaskId !== undefined
          ? { sourceTaskId: updates.sourceTaskId || null }
          : {}),
        ...(updates.status !== undefined ? { status: updates.status as AgentTeamItemStatus } : {}),
        ...(updates.resultSummary !== undefined
          ? { resultSummary: updates.resultSummary || null }
          : {}),
        ...(updates.sortOrder !== undefined ? { sortOrder: updates.sortOrder } : {}),
      });
      if (updated) {
        setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      }
    } catch (err: Any) {
      console.error("Failed to update item:", err);
      setError(err?.message || "Failed to update item");
    }
  }, []);

  const handleDeleteItem = useCallback(async (item: AgentTeamItem) => {
    if (!confirm(`Delete item "${item.title}"?`)) return;
    try {
      setError(null);
      await window.electronAPI.deleteTeamItem(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err: Any) {
      console.error("Failed to delete item:", err);
      setError(err?.message || "Failed to delete item");
    }
  }, []);

  const handleMoveItem = useCallback(
    async (item: AgentTeamItem, direction: "up" | "down") => {
      const idx = sortedItems.findIndex((i) => i.id === item.id);
      if (idx === -1) return;
      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= sortedItems.length) return;

      const target = sortedItems[targetIdx];
      try {
        setError(null);
        // Swap sortOrder values
        const a = await window.electronAPI.moveTeamItem({
          id: item.id,
          parentItemId: item.parentItemId ?? null,
          sortOrder: target.sortOrder,
        });
        const b = await window.electronAPI.moveTeamItem({
          id: target.id,
          parentItemId: target.parentItemId ?? null,
          sortOrder: item.sortOrder,
        });
        setItems((prev) =>
          prev
            .map((i) => (i.id === a?.id ? (a as AgentTeamItem) : i))
            .map((i) => (i.id === b?.id ? (b as AgentTeamItem) : i)),
        );
      } catch (err: Any) {
        console.error("Failed to reorder item:", err);
        setError(err?.message || "Failed to reorder item");
      }
    },
    [sortedItems],
  );

  const availableMemberRoles = useMemo(() => {
    const memberRoleIds = new Set(teamMembers.map((m) => m.agentRoleId));
    return agents.filter((a) => memberRoleIds.has(a.id));
  }, [agents, teamMembers]);

  const runStatusLabel = (status?: AgentTeamRunStatus): string => {
    if (!status) return "";
    const labels: Record<AgentTeamRunStatus, string> = {
      pending: "PENDING",
      running: "RUNNING",
      paused: "PAUSED",
      completed: "COMPLETED",
      failed: "FAILED",
      cancelled: "CANCELLED",
    };
    return labels[status];
  };

  const itemStatusColorClass = (status: AgentTeamItemStatus): string => {
    switch (status) {
      case "todo":
        return "neutral";
      case "in_progress":
        return "info";
      case "blocked":
        return "warn";
      case "done":
        return "success";
      case "failed":
        return "danger";
      default:
        return "neutral";
    }
  };

  return (
    <div className="mc-content mc-teams-content">
      {/* Left Panel - Teams */}
      <aside className="mc-agents-panel mc-teams-left">
        <div className="mc-panel-header">
          <h2>Teams</h2>
          <span className="mc-count">{teams.length}</span>
        </div>
        <div className="mc-teams-toolbar">
          <label className="mc-checkbox">
            <input
              type="checkbox"
              checked={showInactiveTeams}
              onChange={(e) => setShowInactiveTeams(e.target.checked)}
            />
            Show inactive
          </label>
          <button className="mc-btn" onClick={() => void loadTeams()} disabled={isLoadingTeams}>
            {isLoadingTeams ? "Loading…" : "Reload"}
          </button>
        </div>
        <div className="mc-agents-list mc-teams-list">
          {isLoadingTeams ? (
            <div className="mc-empty">Loading teams…</div>
          ) : teams.length === 0 ? (
            <div className="mc-empty">No teams yet. Create one below.</div>
          ) : (
            teams.map((team) => {
              const lead = agentById.get(team.leadAgentRoleId);
              return (
                <button
                  key={team.id}
                  className={`mc-team-row ${selectedTeamId === team.id ? "selected" : ""}`}
                  onClick={() => setSelectedTeamId(team.id)}
                >
                  <div className="mc-team-row-top">
                    <span className="mc-team-name">{team.name}</span>
                    {!team.isActive && <span className="mc-pill neutral">INACTIVE</span>}
                    {team.persistent && (
                      <span
                        className="mc-pill"
                        style={{ background: "var(--accent, #6366f1)", color: "#fff" }}
                      >
                        PERSISTENT
                      </span>
                    )}
                  </div>
                  <div className="mc-team-meta">
                    Lead: {lead?.displayName || "Unknown"} · Max: {team.maxParallelAgents}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="mc-divider" />

        <div className="mc-section mc-team-create">
          <div className="mc-section-title">New team</div>
          <div className="mc-form">
            <label className="mc-field">
              <span>Name</span>
              <input
                className="mc-input"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                placeholder="e.g. Web squad"
              />
            </label>
            <label className="mc-field">
              <span>Description</span>
              <textarea
                className="mc-textarea"
                value={newTeamDescription}
                onChange={(e) => setNewTeamDescription(e.target.value)}
                placeholder="Optional"
              />
            </label>
            <label className="mc-field">
              <span>Lead agent</span>
              <select
                className="mc-select"
                value={newTeamLeadRoleId}
                onChange={(e) => setNewTeamLeadRoleId(e.target.value)}
              >
                <option value="">Select…</option>
                {agents
                  .filter((a) => a.isActive)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <label className="mc-field">
              <span>Max parallel agents</span>
              <input
                className="mc-input"
                type="number"
                min={1}
                max={50}
                value={newTeamMaxParallel}
                onChange={(e) => setNewTeamMaxParallel(Number(e.target.value))}
              />
            </label>
            <label className="mc-field">
              <span>Default model</span>
              <select
                className="mc-select"
                value={newTeamDefaultModelPreference}
                onChange={(e) => setNewTeamDefaultModelPreference(e.target.value)}
              >
                <option value="same">Same (inherit)</option>
                <option value="cheaper">Cheaper (Haiku)</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
              </select>
            </label>
            <label className="mc-field">
              <span>Default personality</span>
              <select
                className="mc-select"
                value={newTeamDefaultPersonality}
                onChange={(e) => setNewTeamDefaultPersonality(e.target.value)}
              >
                <option value="same">Same (inherit)</option>
                <option value="concise">Concise</option>
                <option value="professional">Professional</option>
                <option value="technical">Technical</option>
                <option value="friendly">Friendly</option>
                <option value="creative">Creative</option>
                <option value="casual">Casual</option>
              </select>
            </label>
            <button className="mc-btn primary" onClick={() => void handleCreateTeam()}>
              Create team
            </button>
          </div>
        </div>
      </aside>

      {/* Center Panel - Team Details / Runs / Items */}
      <main className="mc-queue-panel mc-teams-center">
        <div className="mc-panel-header">
          <h2>Team Builder</h2>
        </div>

        {error && <div className="mc-error">{error}</div>}

        {!selectedTeam || !teamDraft ? (
          <div className="mc-empty mc-teams-empty">Select a team to configure it.</div>
        ) : (
          <div className="mc-teams-scroll">
            <div className="mc-section">
              <div className="mc-section-header">
                <div className="mc-section-title">Team</div>
                <div className="mc-section-actions">
                  <button className="mc-btn" onClick={() => void handleSaveTeam()}>
                    Save
                  </button>
                  <button className="mc-btn danger" onClick={() => void handleDeleteTeam()}>
                    Delete
                  </button>
                </div>
              </div>
              <div className="mc-form mc-form-grid">
                <label className="mc-field">
                  <span>Name</span>
                  <input
                    className="mc-input"
                    value={teamDraft.name}
                    onChange={(e) => setTeamDraft({ ...teamDraft, name: e.target.value })}
                  />
                </label>
                <label className="mc-field">
                  <span>Lead agent</span>
                  <select
                    className="mc-select"
                    value={teamDraft.leadAgentRoleId}
                    onChange={(e) =>
                      setTeamDraft({ ...teamDraft, leadAgentRoleId: e.target.value })
                    }
                  >
                    {agents
                      .filter((a) => a.isActive)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.displayName}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="mc-field">
                  <span>Max parallel</span>
                  <input
                    className="mc-input"
                    type="number"
                    min={1}
                    max={50}
                    value={teamDraft.maxParallelAgents}
                    onChange={(e) =>
                      setTeamDraft({ ...teamDraft, maxParallelAgents: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="mc-field">
                  <span>Default model</span>
                  <select
                    className="mc-select"
                    value={teamDraft.defaultModelPreference}
                    onChange={(e) =>
                      setTeamDraft({ ...teamDraft, defaultModelPreference: e.target.value })
                    }
                  >
                    <option value="same">Same (inherit)</option>
                    <option value="cheaper">Cheaper (Haiku)</option>
                    <option value="sonnet">Sonnet</option>
                    <option value="opus">Opus</option>
                  </select>
                </label>
                <label className="mc-field">
                  <span>Default personality</span>
                  <select
                    className="mc-select"
                    value={teamDraft.defaultPersonality}
                    onChange={(e) =>
                      setTeamDraft({ ...teamDraft, defaultPersonality: e.target.value })
                    }
                  >
                    <option value="same">Same (inherit)</option>
                    <option value="concise">Concise</option>
                    <option value="professional">Professional</option>
                    <option value="technical">Technical</option>
                    <option value="friendly">Friendly</option>
                    <option value="creative">Creative</option>
                    <option value="casual">Casual</option>
                  </select>
                </label>
                <label className="mc-field mc-field-inline">
                  <span>Active</span>
                  <input
                    type="checkbox"
                    checked={teamDraft.isActive}
                    onChange={(e) => setTeamDraft({ ...teamDraft, isActive: e.target.checked })}
                  />
                </label>
                <label
                  className="mc-field mc-field-inline"
                  title="Persistent teams remain available across sessions and can auto-dispatch for matching workspace tasks"
                >
                  <span>Persistent</span>
                  <input
                    type="checkbox"
                    checked={teamDraft.persistent}
                    onChange={(e) => setTeamDraft({ ...teamDraft, persistent: e.target.checked })}
                  />
                </label>
                <label className="mc-field mc-field-wide">
                  <span>Description</span>
                  <textarea
                    className="mc-textarea"
                    value={teamDraft.description}
                    onChange={(e) => setTeamDraft({ ...teamDraft, description: e.target.value })}
                  />
                </label>
              </div>
            </div>

            <div className="mc-section">
              <div className="mc-section-header">
                <div className="mc-section-title">Members</div>
                <div className="mc-section-subtitle">{teamMembers.length}</div>
              </div>
              <div className="mc-form mc-form-grid">
                <label className="mc-field">
                  <span>Add member</span>
                  <select
                    className="mc-select"
                    value={newMemberRoleId}
                    onChange={(e) => setNewMemberRoleId(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {agents
                      .filter((a) => a.isActive)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.displayName}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="mc-field mc-field-inline">
                  <span>Required</span>
                  <input
                    type="checkbox"
                    checked={newMemberRequired}
                    onChange={(e) => setNewMemberRequired(e.target.checked)}
                  />
                </label>
                <label className="mc-field mc-field-wide">
                  <span>Guidance (optional)</span>
                  <textarea
                    className="mc-textarea"
                    value={newMemberGuidance}
                    onChange={(e) => setNewMemberGuidance(e.target.value)}
                    placeholder="Team-specific guidance for this role"
                  />
                </label>
                <button className="mc-btn primary" onClick={() => void handleAddMember()}>
                  Add member
                </button>
              </div>

              <div className="mc-table">
                {teamMembers.length === 0 ? (
                  <div className="mc-empty">No members yet.</div>
                ) : (
                  teamMembers.map((m) => {
                    const role = agentById.get(m.agentRoleId);
                    return (
                      <div key={m.id} className="mc-row">
                        <div className="mc-row-main">
                          <div className="mc-row-title">
                            {role?.icon} {role?.displayName || m.agentRoleId}
                          </div>
                          <div className="mc-row-sub">
                            {m.isRequired ? (
                              <span className="mc-pill info">REQUIRED</span>
                            ) : (
                              <span className="mc-pill neutral">OPTIONAL</span>
                            )}
                          </div>
                        </div>
                        <div className="mc-row-actions">
                          <button
                            className="mc-btn tiny"
                            onClick={() => void handleReorderMember(m.id, "up")}
                          >
                            ↑
                          </button>
                          <button
                            className="mc-btn tiny"
                            onClick={() => void handleReorderMember(m.id, "down")}
                          >
                            ↓
                          </button>
                          <button
                            className="mc-btn tiny"
                            onClick={() =>
                              void handleUpdateMember(m.id, { isRequired: !m.isRequired })
                            }
                          >
                            Toggle required
                          </button>
                          <button
                            className="mc-btn tiny"
                            onClick={() => {
                              const next = prompt(
                                "Role guidance (team-specific)",
                                m.roleGuidance || "",
                              );
                              if (next === null) return;
                              void handleUpdateMember(m.id, { roleGuidance: next });
                            }}
                          >
                            Guidance
                          </button>
                          <button
                            className="mc-btn tiny danger"
                            onClick={() => void handleRemoveMember(m)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="mc-section">
              <div className="mc-section-header">
                <div className="mc-section-title">Runs</div>
                <div className="mc-section-subtitle">{runs.length}</div>
              </div>

              <div className="mc-form mc-form-grid">
                <label className="mc-field mc-field-wide">
                  <span>Root task</span>
                  <select
                    className="mc-select"
                    value={newRunRootTaskId}
                    onChange={(e) => setNewRunRootTaskId(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {sortedTasks.slice(0, 200).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mc-field mc-field-inline">
                  <span>Start now</span>
                  <input
                    type="checkbox"
                    checked={newRunStartNow}
                    onChange={(e) => setNewRunStartNow(e.target.checked)}
                  />
                </label>
                <label className="mc-field mc-field-inline">
                  <span>Collaborative</span>
                  <input
                    type="checkbox"
                    checked={newRunCollaborative}
                    onChange={(e) => setNewRunCollaborative(e.target.checked)}
                  />
                </label>
                <button className="mc-btn primary" onClick={() => void handleCreateRun()}>
                  Create run
                </button>
              </div>

              <div className="mc-table">
                {runs.length === 0 ? (
                  <div className="mc-empty">No runs yet.</div>
                ) : (
                  runs.map((r) => {
                    const root = tasksById.get(r.rootTaskId);
                    return (
                      <button
                        key={r.id}
                        className={`mc-run-row ${selectedRunId === r.id ? "selected" : ""}`}
                        onClick={() => setSelectedRunId(r.id)}
                      >
                        <div className="mc-run-row-top">
                          <span
                            className={`mc-pill ${r.status === "running" ? "info" : r.status === "completed" ? "success" : r.status === "failed" ? "danger" : "neutral"}`}
                          >
                            {runStatusLabel(r.status)}
                          </span>
                          {r.collaborativeMode && <span className="mc-pill info">COLLAB</span>}
                          <span className="mc-muted">{formatTime(r.startedAt)}</span>
                        </div>
                        <div className="mc-run-row-title">{root?.title || r.rootTaskId}</div>
                        {r.error && <div className="mc-run-row-error">{r.error}</div>}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="mc-section">
              <div className="mc-section-header">
                <div className="mc-section-title">Run monitor</div>
                {selectedRun && (
                  <div className="mc-section-actions">
                    {(selectedRun.status === "pending" || selectedRun.status === "paused") && (
                      <button
                        className="mc-btn primary"
                        onClick={() => void handleUpdateRunStatus("resume")}
                      >
                        {selectedRun.status === "pending" ? "Start" : "Resume"}
                      </button>
                    )}
                    {selectedRun.status === "running" && (
                      <button
                        className="mc-btn"
                        onClick={() => void handleUpdateRunStatus("pause")}
                      >
                        Pause
                      </button>
                    )}
                    {selectedRun.status !== "completed" &&
                      selectedRun.status !== "failed" &&
                      selectedRun.status !== "cancelled" && (
                        <button
                          className="mc-btn danger"
                          onClick={() => void handleUpdateRunStatus("cancel")}
                        >
                          Cancel
                        </button>
                      )}
                  </div>
                )}
              </div>

              {!selectedRun ? (
                <div className="mc-empty">Select a run to see items.</div>
              ) : (
                <>
                  {selectedRun.summary && <pre className="mc-pre">{selectedRun.summary}</pre>}

                  <div className="mc-form mc-form-grid">
                    <label className="mc-field">
                      <span>New item</span>
                      <input
                        className="mc-input"
                        value={newItemTitle}
                        onChange={(e) => setNewItemTitle(e.target.value)}
                        placeholder="e.g. Implement API endpoint"
                      />
                    </label>
                    <label className="mc-field">
                      <span>Owner</span>
                      <select
                        className="mc-select"
                        value={newItemOwnerRoleId}
                        onChange={(e) => setNewItemOwnerRoleId(e.target.value)}
                      >
                        <option value="">Unassigned</option>
                        {(availableMemberRoles.length > 0
                          ? availableMemberRoles
                          : agents.filter((a) => a.isActive)
                        ).map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="mc-field mc-field-wide">
                      <span>Description (optional)</span>
                      <textarea
                        className="mc-textarea"
                        value={newItemDescription}
                        onChange={(e) => setNewItemDescription(e.target.value)}
                        placeholder="Optional"
                      />
                    </label>
                    <button className="mc-btn primary" onClick={() => void handleCreateItem()}>
                      Add item
                    </button>
                  </div>

                  <div className="mc-table">
                    {sortedItems.length === 0 ? (
                      <div className="mc-empty">No checklist items yet.</div>
                    ) : (
                      sortedItems.map((it) => {
                        const owner = it.ownerAgentRoleId
                          ? agentById.get(it.ownerAgentRoleId)
                          : null;
                        const linkedTask = it.sourceTaskId ? tasksById.get(it.sourceTaskId) : null;
                        return (
                          <div key={it.id} className="mc-row mc-item-row">
                            <div className="mc-row-main">
                              <div className="mc-row-title">
                                <span className={`mc-dot ${itemStatusColorClass(it.status)}`} />
                                <span className="mc-item-title">{it.title}</span>
                              </div>
                              <div className="mc-row-sub">
                                <span className={`mc-pill ${itemStatusColorClass(it.status)}`}>
                                  {it.status.toUpperCase()}
                                </span>
                                <span className="mc-muted">
                                  Owner:{" "}
                                  {owner ? `${owner.icon} ${owner.displayName}` : "Unassigned"}
                                </span>
                                {linkedTask && (
                                  <button
                                    className="mc-link"
                                    onClick={() =>
                                      onOpenTask ? onOpenTask(linkedTask.id) : undefined
                                    }
                                    title="Open linked task"
                                  >
                                    Task: {linkedTask.title}
                                  </button>
                                )}
                                {!linkedTask && it.sourceTaskId && (
                                  <span className="mc-muted">Task: {it.sourceTaskId}</span>
                                )}
                              </div>
                              {it.resultSummary && (
                                <div className="mc-row-summary">{it.resultSummary}</div>
                              )}
                            </div>
                            <div className="mc-row-actions">
                              <select
                                className="mc-select tiny"
                                value={it.ownerAgentRoleId || ""}
                                onChange={(e) =>
                                  void handleUpdateItem(it.id, {
                                    ownerAgentRoleId: e.target.value || "",
                                  })
                                }
                                title="Assign owner"
                              >
                                <option value="">Unassigned</option>
                                {(availableMemberRoles.length > 0
                                  ? availableMemberRoles
                                  : agents.filter((a) => a.isActive)
                                ).map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.displayName}
                                  </option>
                                ))}
                              </select>
                              <select
                                className="mc-select tiny"
                                value={it.status}
                                onChange={(e) =>
                                  void handleUpdateItem(it.id, {
                                    status: e.target.value as AgentTeamItemStatus,
                                  })
                                }
                                title="Set status"
                              >
                                {(
                                  [
                                    "todo",
                                    "in_progress",
                                    "blocked",
                                    "done",
                                    "failed",
                                  ] as AgentTeamItemStatus[]
                                ).map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                              <button
                                className="mc-btn tiny"
                                onClick={() => void handleMoveItem(it, "up")}
                                title="Move up"
                              >
                                ↑
                              </button>
                              <button
                                className="mc-btn tiny"
                                onClick={() => void handleMoveItem(it, "down")}
                                title="Move down"
                              >
                                ↓
                              </button>
                              {it.sourceTaskId && (
                                <button
                                  className="mc-btn tiny"
                                  onClick={() => void handleUpdateItem(it.id, { sourceTaskId: "" })}
                                  title="Unlink task"
                                >
                                  Unlink
                                </button>
                              )}
                              <button
                                className="mc-btn tiny danger"
                                onClick={() => void handleDeleteItem(it)}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Right Panel - Events */}
      <aside className="mc-feed-panel mc-teams-right">
        <div className="mc-panel-header mc-feed-header">
          <div className="mc-tabs">
            <button className="mc-tab-btn active">Run events</button>
          </div>
          <button className="mc-clear-task" onClick={() => setEvents([])}>
            Clear
          </button>
        </div>
        <div className="mc-feed-list mc-team-events">
          {events.length === 0 ? (
            <div className="mc-feed-empty">No events yet.</div>
          ) : (
            events.map((e, idx) => (
              <div key={`${e.type}-${e.timestamp || 0}-${idx}`} className="mc-feed-item">
                <div className="mc-feed-item-header">
                  <span className="mc-feed-agent system">{e.type}</span>
                  <span className="mc-feed-time">{formatTime(e.timestamp)}</span>
                </div>
                <div className="mc-feed-content">{summarizeEvent(e)}</div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
