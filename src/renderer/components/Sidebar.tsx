import { useState, useRef, useEffect, useMemo, useCallback, Fragment } from "react";
import { Filter } from "lucide-react";
import { Task, Workspace, UiDensity, InfraStatus } from "../../shared/types";

interface SidebarProps {
  workspace: Workspace | null;
  tasks: Task[];
  selectedTaskId: string | null;
  completionAttentionTaskIds?: string[];
  onSelectTask: (id: string | null) => void;
  onNewSession?: () => void;
  onOpenSettings: () => void;
  onOpenMissionControl: () => void;

  onTasksChanged: () => void;
  uiDensity?: UiDensity;
}

/** Visual session mode derived from task metadata */
export type SessionMode =
  | "standard"
  | "autonomous"
  | "collab"
  | "multi-llm"
  | "scheduled"
  | "think"
  | "comparison";

const SESSION_MODE_META: Record<SessionMode, { label: string; shortLabel: string; color: string }> =
  {
    standard: { label: "Standard", shortLabel: "STD", color: "standard" },
    autonomous: { label: "Autonomous", shortLabel: "AUTO", color: "autonomous" },
    collab: { label: "Collaborative", shortLabel: "COLLAB", color: "collab" },
    "multi-llm": { label: "Multi-LLM", shortLabel: "MULTI", color: "multi-llm" },
    scheduled: { label: "Scheduled", shortLabel: "SCHED", color: "scheduled" },
    think: { label: "Think", shortLabel: "THINK", color: "think" },
    comparison: { label: "Comparison", shortLabel: "CMP", color: "comparison" },
  };

/** Derive the primary session mode from task metadata */
export function getSessionMode(task: Task): SessionMode {
  if (task.agentConfig?.collaborativeMode) return "collab";
  if (task.agentConfig?.multiLlmMode) return "multi-llm";
  if (task.agentConfig?.autonomousMode) return "autonomous";
  if (task.agentConfig?.conversationMode === "think") return "think";
  if (task.comparisonSessionId) return "comparison";
  if (task.source === "cron" || task.title?.startsWith("Scheduled:")) return "scheduled";
  return "standard";
}

const HIDDEN_FOCUSED_STATUSES: ReadonlySet<Task["status"]> = new Set(["failed", "cancelled"]);
const ACTIVE_SESSION_STATUSES: ReadonlySet<Task["status"]> = new Set([
  "executing",
  "planning",
  "interrupted",
]);
const AWAITING_SESSION_STATUSES: ReadonlySet<Task["status"]> = new Set(["paused", "blocked"]);

export function isActiveSessionStatus(status: Task["status"]): boolean {
  return ACTIVE_SESSION_STATUSES.has(status);
}

export function isAwaitingSessionStatus(status: Task["status"]): boolean {
  return AWAITING_SESSION_STATUSES.has(status);
}

export function compareTasksByPinAndRecency(a: Task, b: Task): number {
  const pinnedDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinnedDiff !== 0) return pinnedDiff;
  return b.createdAt - a.createdAt;
}

export function shouldShowRootTaskInSidebar(
  task: Task,
  uiDensity: UiDensity,
  showFailedSessions: boolean,
  hasPinnedDescendant = false,
): boolean {
  if (uiDensity !== "focused") return true;
  if (showFailedSessions) return true;
  if (task.pinned) return true;
  if (hasPinnedDescendant) return true;
  return !HIDDEN_FOCUSED_STATUSES.has(task.status);
}

export function countHiddenFailedSessions(tasks: Task[], uiDensity: UiDensity): number {
  const cache = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentTaskId) {
      const siblings = cache.get(task.parentTaskId) || [];
      siblings.push(task);
      cache.set(task.parentTaskId, siblings);
    }
  }

  const hasPinnedDescendant = (taskId: string): boolean => {
    const stack = [...(cache.get(taskId) || [])];
    const seen = new Set<string>();

    while (stack.length > 0) {
      const task = stack.pop();
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);

      if (task.pinned) return true;

      const children = cache.get(task.id) || [];
      for (const child of children) {
        if (!seen.has(child.id)) {
          stack.push(child);
        }
      }
    }

    return false;
  };

  if (uiDensity !== "focused") return 0;
  return tasks.filter(
    (task) =>
      !task.parentTaskId &&
      !task.pinned &&
      !hasPinnedDescendant(task.id) &&
      HIDDEN_FOCUSED_STATUSES.has(task.status),
  ).length;
}

// Tree node structure for hierarchical display
interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
}

export function Sidebar({
  workspace: _workspace,
  tasks,
  selectedTaskId,
  completionAttentionTaskIds = [],
  onSelectTask,
  onNewSession,
  onOpenSettings,
  onOpenMissionControl,

  onTasksChanged,
  uiDensity = "focused",
}: SidebarProps) {
  const [menuOpenTaskId, setMenuOpenTaskId] = useState<string | null>(null);
  const [renameTaskId, setRenameTaskId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set());
  const [showFailedSessions, setShowFailedSessions] = useState(false);
  const [pinActionError, setPinActionError] = useState<string | null>(null);
  const [activeModeFilters, setActiveModeFilters] = useState<Set<SessionMode>>(new Set());
  const [showFilterBar, setShowFilterBar] = useState(false);
  const pinActionErrorTimeoutRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const renameInputRef = useRef<HTMLInputElement>(null);
  const completionAttentionSet = useMemo(
    () => new Set(completionAttentionTaskIds),
    [completionAttentionTaskIds],
  );

  // Helper to get date group for a timestamp
  const getDateGroup = useCallback((timestamp: number): string => {
    const now = new Date();
    const date = new Date(timestamp);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    if (date >= today) return "Today";
    if (date >= yesterday) return "Yesterday";
    return "Earlier";
  }, []);

  // Build task tree from flat list
  const taskTree = useMemo(() => {
    const childrenMap = new Map<string, Task[]>();

    // Index all tasks
    for (const task of tasks) {
      if (task.parentTaskId) {
        const siblings = childrenMap.get(task.parentTaskId) || [];
        siblings.push(task);
        childrenMap.set(task.parentTaskId, siblings);
      }
    }

    const hasPinnedDescendant = (taskId: string): boolean => {
      const stack = [...(childrenMap.get(taskId) || [])];
      const seen = new Set<string>();

      while (stack.length > 0) {
        const task = stack.pop();
        if (!task || seen.has(task.id)) continue;
        seen.add(task.id);

        if (task.pinned) return true;

        const children = childrenMap.get(task.id) || [];
        for (const child of children) {
          if (!seen.has(child.id)) {
            stack.push(child);
          }
        }
      }

      return false;
    };

    // Build tree nodes recursively
    const buildNode = (task: Task): TaskTreeNode => {
      const children = childrenMap.get(task.id) || [];
      // Sort children: pinned sessions first, then newest first
      children.sort(compareTasksByPinAndRecency);
      return {
        task,
        children: children.map(buildNode),
      };
    };

    // Get root tasks (no parent) and sort by creation time (newest first)
    let rootTasks = tasks
      .filter((t) => !t.parentTaskId)
      .filter((t) =>
        shouldShowRootTaskInSidebar(t, uiDensity, showFailedSessions, hasPinnedDescendant(t.id)),
      )
      .sort(compareTasksByPinAndRecency);

    return rootTasks.map(buildNode);
  }, [tasks, uiDensity, showFailedSessions]);

  // Count hidden failed sessions for the toggle label
  const failedSessionCount = useMemo(() => {
    return countHiddenFailedSessions(tasks, uiDensity);
  }, [tasks, uiDensity]);

  // Count root tasks per session mode (for filter badge counts)
  const modeCounts = useMemo(() => {
    const counts = new Map<SessionMode, number>();
    for (const node of taskTree) {
      const mode = getSessionMode(node.task);
      counts.set(mode, (counts.get(mode) || 0) + 1);
    }
    return counts;
  }, [taskTree]);

  // Which modes are actually present in current sessions
  const availableModes = useMemo(() => {
    const modes: SessionMode[] = [];
    for (const mode of Object.keys(SESSION_MODE_META) as SessionMode[]) {
      if ((modeCounts.get(mode) || 0) > 0) modes.push(mode);
    }
    return modes;
  }, [modeCounts]);

  // Remove stale filters when workspace/task data changes and previously
  // selected modes are no longer available.
  useEffect(() => {
    const availableModeSet = new Set(availableModes);
    setActiveModeFilters((prev) => {
      const next = new Set(Array.from(prev).filter((mode) => availableModeSet.has(mode)));
      return next.size === prev.size ? prev : next;
    });
  }, [availableModes]);

  // Apply mode filter to the task tree
  const filteredTaskTree = useMemo(() => {
    if (activeModeFilters.size === 0) return taskTree;
    return taskTree.filter((node) => activeModeFilters.has(getSessionMode(node.task)));
  }, [taskTree, activeModeFilters]);

  const toggleModeFilter = useCallback((mode: SessionMode) => {
    setActiveModeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) {
        next.delete(mode);
      } else {
        next.add(mode);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (pinActionErrorTimeoutRef.current !== null) {
        window.clearTimeout(pinActionErrorTimeoutRef.current);
      }
    };
  }, []);

  const focusedTaskEntries = useMemo(() => {
    if (uiDensity !== "focused") return [];
    return filteredTaskTree.reduce<
      Array<{
        node: TaskTreeNode;
        index: number;
        group: string;
        showHeader: boolean;
        isLast: boolean;
      }>
    >((acc, node, index) => {
      const group = getDateGroup(node.task.createdAt);
      const previousGroup = acc.length > 0 ? acc[acc.length - 1].group : "";
      const isLast = index === filteredTaskTree.length - 1;
      acc.push({
        node,
        index,
        group,
        showHeader: group !== previousGroup,
        isLast,
      });
      return acc;
    }, []);
  }, [getDateGroup, filteredTaskTree, uiDensity]);

  // Auto-collapse sub-agent trees in focused mode
  const hasInitializedCollapse = useRef(false);
  useEffect(() => {
    const parentByTaskId = new Map<string, string>();
    const parentsWithChildren = new Set<string>();

    for (const task of tasks) {
      if (task.parentTaskId) {
        parentByTaskId.set(task.id, task.parentTaskId);
        parentsWithChildren.add(task.parentTaskId);
      }
    }

    const expandAncestorsForPinned = (collapsed: Set<string>): void => {
      for (const task of tasks) {
        if (!task.pinned) continue;

        let currentParent = task.parentTaskId;
        const seen = new Set<string>();
        while (currentParent && !seen.has(currentParent)) {
          seen.add(currentParent);
          collapsed.delete(currentParent);
          const nextParent = parentByTaskId.get(currentParent);
          if (!nextParent) break;
          currentParent = nextParent;
        }
      }
    };

    if (uiDensity === "focused") {
      if (!hasInitializedCollapse.current) {
        expandAncestorsForPinned(parentsWithChildren);
        if (parentsWithChildren.size > 0) {
          setCollapsedTasks(parentsWithChildren);
        }
        hasInitializedCollapse.current = true;
      } else {
        setCollapsedTasks((prev) => {
          const next = new Set(prev);
          expandAncestorsForPinned(next);
          return next;
        });
      }
    }
    if (uiDensity === "full") {
      hasInitializedCollapse.current = false;
    }
  }, [uiDensity, tasks]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenTaskId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renameTaskId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameTaskId]);

  const handleMenuToggle = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setMenuOpenTaskId(menuOpenTaskId === taskId ? null : taskId);
  };

  const focusMenuButton = (taskId: string) => {
    const button = menuButtonRef.current.get(taskId);
    if (button) {
      button.focus();
    }
  };

  const focusFirstMenuItem = () => {
    const menu = menuRef.current;
    const first = menu?.querySelector<HTMLButtonElement>("button[data-menu-option]");
    first?.focus();
  };

  const focusMenuItem = (offset: 1 | -1) => {
    const menu = menuRef.current;
    if (!menu) return;

    const options = Array.from(
      menu.querySelectorAll<HTMLButtonElement>("button[data-menu-option]"),
    );
    if (options.length === 0) return;

    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = (currentIndex + offset + options.length) % options.length;
    const next = options[nextIndex];
    next?.focus();
  };

  const closeMenu = (taskId: string) => {
    setMenuOpenTaskId(null);
    focusMenuButton(taskId);
  };

  const handleMenuButtonKeyDown = (e: React.KeyboardEvent, taskId: string) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      const nextOpen = menuOpenTaskId === taskId ? null : taskId;
      setMenuOpenTaskId(nextOpen);
      if (nextOpen) {
        requestAnimationFrame(() => focusFirstMenuItem());
      }
      return;
    }

    if (e.key === "Escape") {
      closeMenu(taskId);
    }
  };

  const handleMenuItemKeyDown = (e: React.KeyboardEvent, taskId: string) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusMenuItem(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusMenuItem(-1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(taskId);
      return;
    }
  };

  const handleRenameClick = (e: React.MouseEvent, task: Task) => {
    e.stopPropagation();
    setMenuOpenTaskId(null);
    setRenameTaskId(task.id);
    setRenameValue(task.title);
  };

  const handleRenameSubmit = async (taskId: string) => {
    if (renameValue.trim()) {
      await window.electronAPI.renameTask(taskId, renameValue.trim());
      onTasksChanged();
    }
    setRenameTaskId(null);
    setRenameValue("");
  };

  const handlePinClick = async (e: React.MouseEvent, task: Task) => {
    e.stopPropagation();
    setMenuOpenTaskId(null);
    setPinActionError(null);
    try {
      await window.electronAPI.toggleTaskPin(task.id);
      onTasksChanged();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to update pin state. Please try again.";
      console.error("Failed to toggle pin:", error);
      setPinActionError(message);
      if (pinActionErrorTimeoutRef.current !== null) {
        window.clearTimeout(pinActionErrorTimeoutRef.current);
      }
      pinActionErrorTimeoutRef.current = window.setTimeout(() => {
        setPinActionError(null);
      }, 2500);
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, taskId: string) => {
    if (e.key === "Enter") {
      handleRenameSubmit(taskId);
    } else if (e.key === "Escape") {
      setRenameTaskId(null);
      setRenameValue("");
    }
  };

  const handleArchiveClick = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setMenuOpenTaskId(null);
    await window.electronAPI.deleteTask(taskId);
    if (selectedTaskId === taskId) {
      onSelectTask(null);
    }
    onTasksChanged();
  };

  const toggleCollapse = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setCollapsedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const getStatusIndicator = (status: Task["status"], showCompletionAttention = false) => {
    if (isActiveSessionStatus(status)) {
      return (
        <>
          <span className="terminal-only">[~]</span>
          <span className="modern-only">
            <span className="cli-session-indicator cli-session-indicator-active" aria-hidden="true" />
          </span>
        </>
      );
    }

    if (isAwaitingSessionStatus(status)) {
      return (
        <>
          <span className="terminal-only">[?]</span>
          <span className="modern-only">
            <span
              className="cli-session-indicator cli-session-indicator-awaiting"
              aria-hidden="true"
            />
          </span>
        </>
      );
    }

    switch (status) {
      case "completed":
        if (!showCompletionAttention) {
          return (
            <>
              <span className="terminal-only">[ ]</span>
              <span className="modern-only">
                <span className="cli-session-indicator cli-session-indicator-invisible" aria-hidden="true" />
              </span>
            </>
          );
        }
        return (
          <>
            <span className="terminal-only">[•]</span>
            <span className="modern-only">
              <span
                className="cli-session-indicator cli-session-indicator-completed"
                aria-hidden="true"
              />
            </span>
          </>
        );
      case "failed":
      case "cancelled":
        return (
          <>
            <span className="terminal-only">[✗]</span>
            <span className="modern-only">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </span>
          </>
        );
      default:
        return (
          <>
            <span className="terminal-only">[ ]</span>
            <span className="modern-only">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" opacity="0.3"></circle>
              </svg>
            </span>
          </>
        );
    }
  };

  const getStatusClass = (status: Task["status"], showCompletionAttention = false) => {
    if (isActiveSessionStatus(status)) return "active";
    if (isAwaitingSessionStatus(status)) return "awaiting";
    if (status === "completed" && showCompletionAttention) return "completed";

    switch (status) {
      case "failed":
      case "cancelled":
        return "failed";
      default:
        return "";
    }
  };

  const getAgentTypeIndicator = (task: Task) => {
    if (task.agentType === "sub") {
      return (
        <span className="cli-agent-type sub" title="Sub-agent">
          SUB
        </span>
      );
    }
    if (task.agentType === "parallel") {
      return (
        <span className="cli-agent-type parallel" title="Parallel agent">
          PAR
        </span>
      );
    }
    return null;
  };

  const handleNewTask = () => {
    if (onNewSession) {
      onNewSession();
      return;
    }
    // Fallback: deselect current task to show the welcome/new task screen
    onSelectTask(null);
  };

  // Render a task node and its children recursively
  const renderTaskNode = (
    node: TaskTreeNode,
    index: number,
    depth: number = 0,
    isLast: boolean = true,
  ): React.ReactNode => {
    const { task, children } = node;
    const hasChildren = children.length > 0;
    const isCollapsed = collapsedTasks.has(task.id);
    const isSubAgent = !!task.parentTaskId;

    // Tree connector prefix based on depth
    const treePrefix = depth > 0 ? (isLast ? "└─" : "├─") : "";
    const taskMode = depth === 0 ? getSessionMode(task) : null;
    const modeClass = taskMode && taskMode !== "standard" ? `session-mode-${taskMode}` : "";
    const showCompletionAttention =
      task.status === "completed" &&
      selectedTaskId !== task.id &&
      completionAttentionSet.has(task.id);

    return (
      <div key={task.id} className="task-tree-node">
        <div
          className={`task-item cli-task-item ${selectedTaskId === task.id ? "task-item-selected" : ""} ${isSubAgent ? "task-item-subagent" : ""} ${modeClass}`}
          onClick={() => renameTaskId !== task.id && onSelectTask(task.id)}
          style={{ paddingLeft: depth > 0 ? `${8 + depth * 16}px` : undefined }}
          title={
            taskMode && taskMode !== "standard" ? SESSION_MODE_META[taskMode].label : undefined
          }
        >
          {/* Tree connector for sub-agents */}
          {depth > 0 && <span className="cli-tree-prefix">{treePrefix}</span>}

          {/* Collapse toggle for tasks with children */}
          {hasChildren ? (
            <button
              className="cli-collapse-btn"
              onClick={(e) => toggleCollapse(e, task.id)}
              title={isCollapsed ? "Expand" : "Collapse"}
            >
              {isCollapsed ? "▸" : "▾"}
            </button>
          ) : (
            <span className="cli-task-num">
              {depth === 0 ? String(index + 1).padStart(2, "0") : "··"}
            </span>
          )}

          <span className={`cli-task-status ${getStatusClass(task.status, showCompletionAttention)}`}>
            {getStatusIndicator(task.status, showCompletionAttention)}
          </span>

          {task.pinned && (
            <span className="cli-task-pinned" title="Pinned">
              📌
            </span>
          )}

          {/* Agent type badge for sub-agents */}
          {getAgentTypeIndicator(task)}

          {/* Git branch indicator for worktree-isolated tasks */}
          {task.worktreeBranch && (
            <span
              className="cli-task-branch"
              title={task.worktreeBranch}
              style={{
                display: "inline-flex",
                alignItems: "center",
                marginRight: "4px",
                color: "var(--color-accent)",
                opacity: 0.7,
                flexShrink: 0,
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            </span>
          )}

          <div className="task-item-content cli-task-content">
            {renameTaskId === task.id ? (
              <input
                ref={renameInputRef}
                type="text"
                className="task-item-rename-input cli-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => handleRenameKeyDown(e, task.id)}
                onBlur={() => handleRenameSubmit(task.id)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div className="cli-task-title-row">
                <span className="cli-task-title" title={task.title}>
                  {task.title}
                </span>
                {isAwaitingSessionStatus(task.status) && (
                  <span className="cli-task-awaiting-badge">Awaiting response</span>
                )}
              </div>
            )}
          </div>

          <div
            className="task-item-actions cli-task-actions"
            ref={menuOpenTaskId === task.id ? menuRef : null}
          >
            <button
              className="task-item-more cli-more-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpenTaskId === task.id}
              aria-controls={`task-menu-${task.id}`}
              aria-label={`Session actions for ${task.title}`}
              onClick={(e) => handleMenuToggle(e, task.id)}
              onKeyDown={(e) => handleMenuButtonKeyDown(e, task.id)}
              ref={(el) => {
                if (el) {
                  menuButtonRef.current.set(task.id, el);
                } else {
                  menuButtonRef.current.delete(task.id);
                }
              }}
            >
              ···
            </button>
            {menuOpenTaskId === task.id && (
              <div
                id={`task-menu-${task.id}`}
                className="task-item-menu cli-task-menu"
                role="menu"
                aria-label="Session actions"
                ref={menuRef}
              >
                <button
                  className="task-item-menu-option cli-menu-option"
                  role="menuitem"
                  data-menu-option="rename"
                  onClick={(e) => handleRenameClick(e, task)}
                  onKeyDown={(e) => handleMenuItemKeyDown(e, task.id)}
                >
                  <span className="cli-menu-prefix">&gt;</span>
                  rename
                </button>
                <button
                  className="task-item-menu-option cli-menu-option"
                  role="menuitem"
                  data-menu-option="pin"
                  onClick={(e) => handlePinClick(e, task)}
                  onKeyDown={(e) => handleMenuItemKeyDown(e, task.id)}
                >
                  <span className="cli-menu-prefix">&gt;</span>
                  {task.pinned ? "unpin" : "pin"}
                </button>
                <button
                  className="task-item-menu-option task-item-menu-option-danger cli-menu-option cli-menu-danger"
                  role="menuitem"
                  data-menu-option="archive"
                  onClick={(e) => handleArchiveClick(e, task.id)}
                  onKeyDown={(e) => handleMenuItemKeyDown(e, task.id)}
                >
                  <span className="cli-menu-prefix">&gt;</span>
                  archive
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Render children if not collapsed */}
        {hasChildren && !isCollapsed && (
          <div className="task-tree-children">
            {children.map((child, childIndex) =>
              renderTaskNode(child, childIndex, depth + 1, childIndex === children.length - 1),
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="sidebar cli-sidebar">
      {/* New Session Button */}
      <div className="sidebar-header">
        <div className="cli-header-actions">
          <button
            className="cli-action-btn cli-mission-control-btn"
            onClick={onOpenMissionControl}
            title="Mission Control"
          >
            <span className="terminal-only">
              <span className="cli-btn-bracket">[</span>
              <span className="cli-btn-accent">MC</span>
              <span className="cli-btn-bracket">]</span>
            </span>
            <span className="cli-btn-text">
              <span className="terminal-only">mission_control</span>
              <span className="modern-only">Mission Control</span>
            </span>
          </button>
          <button className="new-task-btn cli-new-task-btn cli-action-btn" onClick={handleNewTask}>
            <span className="terminal-only">
              <span className="cli-btn-bracket">[</span>
              <span className="cli-btn-plus">+</span>
              <span className="cli-btn-bracket">]</span>
            </span>
            <span className="cli-btn-text">
              <span className="terminal-only">new_session</span>
              <span className="modern-only">New Session</span>
            </span>
          </button>
        </div>
      </div>

      {/* Sessions List */}
      <div className="task-list cli-task-list">
        {pinActionError && (
          <div className="cli-sidebar-error" role="alert">
            {pinActionError}
          </div>
        )}
        <div className="task-list-header cli-list-header">
          <span className="cli-section-prompt">&gt;</span>
          <span className="terminal-only">SESSIONS</span>
          <span className="modern-only">Sessions</span>
          {(availableModes.length > 1 || activeModeFilters.size > 0) && (
            <button
              type="button"
              className={`session-filter-toggle ${showFilterBar || activeModeFilters.size > 0 ? "active" : ""}`}
              onClick={() => setShowFilterBar(!showFilterBar)}
              title="Filter by mode"
            >
              <Filter size={12} strokeWidth={2.5} />
              {activeModeFilters.size > 0 && (
                <span className="filter-count">{activeModeFilters.size}</span>
              )}
            </button>
          )}
          {uiDensity === "focused" && failedSessionCount > 0 && (
            <button
              type="button"
              className="show-failed-toggle"
              onClick={() => setShowFailedSessions(!showFailedSessions)}
            >
              {showFailedSessions ? "Hide" : "Show"} failed ({failedSessionCount})
            </button>
          )}
        </div>
        {showFilterBar && (availableModes.length > 1 || activeModeFilters.size > 0) && (
          <div className="session-filter-bar">
            {availableModes.map((mode) => {
              const meta = SESSION_MODE_META[mode];
              const isActive = activeModeFilters.has(mode);
              return (
                <button
                  type="button"
                  key={mode}
                  className={`session-filter-chip ${meta.color} ${isActive ? "active" : ""}`}
                  onClick={() => toggleModeFilter(mode)}
                  title={meta.label}
                >
                  <span className="filter-chip-dot" />
                  {meta.label}
                  <span className="filter-chip-count">{modeCounts.get(mode) || 0}</span>
                </button>
              );
            })}
            {activeModeFilters.size > 0 && (
              <button
                type="button"
                className="session-filter-clear"
                onClick={() => setActiveModeFilters(new Set())}
                title="Clear filters"
              >
                clear
              </button>
            )}
          </div>
        )}
        {filteredTaskTree.length === 0 ? (
          activeModeFilters.size > 0 ? (
            <div className="sidebar-empty cli-empty sidebar-empty-filtered">
              <p className="cli-hint">
                <span>No sessions match the selected filters</span>
              </p>
            </div>
          ) : (
            <div
              className={`sidebar-empty cli-empty ${uiDensity === "focused" ? "sidebar-empty-focused" : ""}`}
            >
              <pre className="cli-tree terminal-only">{`├── (no sessions yet)
└── ...`}</pre>
              {uiDensity === "focused" ? (
                <div className="sidebar-empty-message">
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ opacity: 0.3 }}
                  >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <p>Your conversations will appear here</p>
                  <span>Start a new session to get going</span>
                </div>
              ) : (
                <p className="cli-hint">
                  <span className="terminal-only"># start a new session above</span>
                  <span className="modern-only">Start a new session to begin</span>
                </p>
              )}
            </div>
          )
        ) : uiDensity === "focused" ? (
          focusedTaskEntries.map((entry) => (
            <Fragment key={entry.node.task.id}>
              {entry.showHeader && <div className="sidebar-date-group">{entry.group}</div>}
              {renderTaskNode(entry.node, entry.index, 0, entry.isLast)}
            </Fragment>
          ))
        ) : (
          filteredTaskTree.map((node, index) =>
            renderTaskNode(node, index, 0, index === filteredTaskTree.length - 1),
          )
        )}
      </div>

      {/* Footer */}
      <div className="sidebar-footer cli-sidebar-footer">
        <InfraWalletBadge onOpenSettings={onOpenSettings} />
        <div className="cli-footer-actions">
          <button
            className="settings-btn cli-settings-btn"
            onClick={onOpenSettings}
            title="Settings"
          >
            <span className="terminal-only">[cfg]</span>
            <span className="modern-only">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function InfraWalletBadge({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [balance, setBalance] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const ipcAPI = window.electronAPI;
    if (!ipcAPI?.infraGetStatus || !ipcAPI?.infraGetSettings) return;

    const load = async () => {
      try {
        const [status, settings] = await Promise.all([
          ipcAPI.infraGetStatus(),
          ipcAPI.infraGetSettings(),
        ]);
        if (settings?.showWalletInSidebar && status?.enabled && status?.wallet?.balanceUsdc) {
          setBalance(status.wallet.balanceUsdc);
          setVisible(true);
        } else {
          setVisible(false);
        }
      } catch {
        setVisible(false);
      }
    };

    load();

    const unsubscribe = ipcAPI.onInfraStatusChange?.((status: InfraStatus) => {
      if (status?.enabled && status?.wallet?.balanceUsdc) {
        setBalance(status.wallet.balanceUsdc);
        setVisible(true);
      }
    });
    return () => unsubscribe?.();
  }, []);

  if (!visible || !balance) return null;

  return (
    <button
      type="button"
      className="infra-wallet-badge"
      onClick={onOpenSettings}
      title="Infrastructure — click to open settings"
      aria-label="Open Infrastructure settings"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
      <span className="infra-wallet-balance">{balance} USDC</span>
    </button>
  );
}
