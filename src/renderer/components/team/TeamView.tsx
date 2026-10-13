import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CalendarClock, Laptop, Plus, Server, Workflow, type LucideIcon } from "lucide-react";
import { BUILTIN_ACCESS_PROFILES } from "../../../shared/access-profiles";
import type { Task, Workspace } from "../../../shared/types";
import { useAttentionSnapshot } from "../../hooks/useAttentionSnapshot";
import { formatHomeSessionTime } from "../../utils/home-sessions";
import {
  buildTeamModel,
  teamInitials,
  type TeamCronJob,
  type TeamDeviceInput,
  type TeamMember,
  type TeamMemberKind,
  type TeamOpenTarget,
  type TeamRole,
  type TeamRoutine,
} from "../../utils/team-view";
import { AgentRoleEditorDialog } from "../AgentRoleEditorDialog";
import "./team-view.css";

const LOCAL_LABEL = navigator.userAgent.includes("Mac") ? "This Mac" : "This computer";

const KIND_ICONS: Record<TeamMemberKind, LucideIcon> = {
  bot: Bot,
  agent: Bot,
  schedule: CalendarClock,
  automation: Workflow,
};

const OPEN_LABEL: Record<TeamOpenTarget["type"], string> = {
  bots: "Open in Bots",
  schedules: "Open in Scheduled tasks",
  routine: "Open in Automations",
};

function TeamAvatar({ member, large = false }: { member: TeamMember; large?: boolean }) {
  const Icon = KIND_ICONS[member.kind];
  const person = member.kind === "bot" || member.kind === "agent";
  return (
    <span
      className={`team-view-avatar kind-${member.kind}${large ? " large" : ""}`}
      aria-hidden="true"
    >
      {person ? teamInitials(member.name) : <Icon size={large ? 20 : 16} />}
    </span>
  );
}

interface TeamViewProps {
  tasks: Task[];
  onOpenTask: (taskId: string) => void;
  onOpenBots: () => void;
  onOpenSchedules: () => void;
  onOpenRoutine: (routineId: string) => void;
  /** Opens the Devices view, on a remote device when one is given. */
  onOpenDevices: (deviceId?: string) => void;
  /** Opens the Devices view on its pairing step. */
  onAddDevice: () => void;
}

interface TeamSources {
  roles: TeamRole[];
  cronJobs: TeamCronJob[];
  routines: TeamRoutine[];
  devices: TeamDeviceInput[];
  workspaces: Workspace[];
}

const EMPTY_SOURCES: TeamSources = {
  roles: [],
  cronJobs: [],
  routines: [],
  devices: [],
  workspaces: [],
};

/** Each list loads on its own; one that fails leaves its teammates out instead of the view. */
function useTeamSources(): {
  sources: TeamSources;
  reloadSchedules: () => Promise<void>;
  reloadRoles: () => Promise<void>;
} {
  const [sources, setSources] = useState<TeamSources>(EMPTY_SOURCES);

  const reloadSchedules = useCallback(async () => {
    const jobs = await window.electronAPI.listCronJobs({ includeDisabled: true }).catch(() => null);
    if (jobs) setSources((current) => ({ ...current, cronJobs: jobs as TeamCronJob[] }));
  }, []);

  const reloadRoles = useCallback(async () => {
    const roles = await window.electronAPI.getAgentRoles(false).catch(() => null);
    if (Array.isArray(roles)) setSources((current) => ({ ...current, roles: roles as TeamRole[] }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI;
    const load = <K extends keyof TeamSources>(key: K, read: () => Promise<TeamSources[K]>) =>
      void read()
        .then((value) => {
          if (!cancelled && Array.isArray(value)) {
            setSources((current) => ({ ...current, [key]: value }));
          }
        })
        .catch(() => undefined);
    load("roles", async () => (await api.getAgentRoles(false)) as TeamRole[]);
    load(
      "cronJobs",
      async () => (await api.listCronJobs({ includeDisabled: true })) as TeamCronJob[],
    );
    load("routines", async () => (await api.listRoutines()) as TeamRoutine[]);
    load("workspaces", () => api.listWorkspaces());
    if (typeof api.listManagedDevices === "function") {
      load(
        "devices",
        async () => ((await api.listManagedDevices())?.devices ?? []) as TeamDeviceInput[],
      );
    }
    return () => {
      cancelled = true;
    };
  }, []);

  return { sources, reloadSchedules, reloadRoles };
}

/** The access profiles a limit can name: the built-in ones, then the user's own. */
function useAccessProfileChoices(): Array<{ id: string; label: string }> {
  const [custom, setCustom] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      .getPermissionSettings()
      .then((settings) => {
        if (cancelled) return;
        setCustom(
          (settings?.accessProfiles ?? []).map((profile) => ({
            id: profile.id,
            label: profile.label || profile.id,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(
    () => [
      ...BUILTIN_ACCESS_PROFILES.map((profile) => ({ id: profile.id, label: profile.label })),
      ...custom.filter((profile) => !BUILTIN_ACCESS_PROFILES.some((b) => b.id === profile.id)),
    ],
    [custom],
  );
}

/**
 * Team: the agents, bots, schedules and automations that work for you, and the devices
 * they run on. Pick a teammate to see what it's responsible for, what it's waiting on you
 * for, how it's set up and what it did recently.
 */
export function TeamView({
  tasks,
  onOpenTask,
  onOpenBots,
  onOpenSchedules,
  onOpenRoutine,
  onOpenDevices,
  onAddDevice,
}: TeamViewProps) {
  const { sources, reloadSchedules, reloadRoles } = useTeamSources();
  const accessChoices = useAccessProfileChoices();
  const [accessError, setAccessError] = useState<string | null>(null);
  const [savingAccess, setSavingAccess] = useState(false);
  /** The agent whose full settings are open, if any. */
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const attention = useAttentionSnapshot(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const now = Date.now();

  const model = useMemo(
    () =>
      buildTeamModel({
        roles: sources.roles,
        cronJobs: sources.cronJobs,
        routines: sources.routines,
        devices: sources.devices,
        tasks,
        attention: attention.items,
        workspaceNames: new Map(
          sources.workspaces
            .filter((workspace) => !workspace.isTemp)
            .map((workspace) => [workspace.id, workspace.name]),
        ),
        localLabel: LOCAL_LABEL,
        now: Date.now(),
      }),
    [sources, tasks, attention.items],
  );

  const selected = model.members.find((member) => member.id === selectedId) ?? model.members[0];

  useEffect(() => {
    setScheduleError(null);
    setAccessError(null);
  }, [selected?.id]);

  // "May do alone" is a limit: the main process checks the profile exists and narrows every
  // session, schedule and check-in of this agent to it. Nothing here grants access.
  const changeAccessLimit = async (roleId: string, profileId: string) => {
    setSavingAccess(true);
    setAccessError(null);
    try {
      await window.electronAPI.updateAgentRole({ id: roleId, accessProfileId: profileId || null });
      await reloadRoles();
    } catch {
      setAccessError("The limit could not be changed. Try again.");
    } finally {
      setSavingAccess(false);
    }
  };

  const open = (target: TeamOpenTarget) => {
    if (target.type === "bots") onOpenBots();
    else if (target.type === "schedules") onOpenSchedules();
    else onOpenRoutine(target.routineId);
  };

  const toggleSchedule = async (member: TeamMember) => {
    if (!member.schedule) return;
    setSavingSchedule(true);
    setScheduleError(null);
    try {
      const result = await window.electronAPI.updateCronJob(member.schedule.cronJobId, {
        enabled: !member.schedule.enabled,
      });
      if (!result.ok) throw new Error(result.error);
      await reloadSchedules();
    } catch {
      setScheduleError("The schedule could not be changed. Try again from Scheduled tasks.");
    } finally {
      setSavingSchedule(false);
    }
  };

  return (
    <main className="main-content calm-view team-view">
      <div className="calm-view-inner team-view-inner">
        <header className="calm-view-header">
          <h1 className="calm-view-title">Team</h1>
          <p className="calm-view-subtitle">
            Your agents, schedules, automations and devices: what each is doing, what it needs from
            you, and how it's set up. Pick a device to manage it and see its work.
          </p>
        </header>

        <section className="team-view-section" aria-labelledby="team-devices">
          <h2 id="team-devices" className="team-view-section-title">
            Devices
          </h2>
          <div className="team-view-devices">
            {model.devices.map((device) => (
              <button
                key={device.id}
                type="button"
                className={`team-view-device${device.online ? "" : " offline"}`}
                onClick={() => onOpenDevices(device.local ? undefined : device.id)}
              >
                <span className="team-view-device-head">
                  {device.local ? (
                    <Laptop size={18} aria-hidden="true" />
                  ) : (
                    <Server size={18} aria-hidden="true" />
                  )}
                  <span className="team-view-device-name">{device.name}</span>
                  <span className="team-view-device-status">
                    <span className="team-view-dot" aria-hidden="true" />
                    {device.statusLabel}
                  </span>
                </span>
                <span className="team-view-device-line">
                  {device.running === 0 && device.waiting === 0
                    ? "Nothing running"
                    : [
                        device.running > 0 ? `${device.running} running` : "",
                        device.waiting > 0 ? `${device.waiting} waiting on you` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="team-view-device team-view-device-add"
              onClick={onAddDevice}
            >
              <span className="team-view-device-head">
                <Plus size={18} aria-hidden="true" />
                <span className="team-view-device-name">Add a device</span>
              </span>
              <span className="team-view-device-line">
                Connect another computer to run work there.
              </span>
            </button>
          </div>
        </section>

        <section className="team-view-section" aria-labelledby="team-members">
          <h2 id="team-members" className="team-view-section-title">
            Agents, schedules and automations
          </h2>
          {model.members.length === 0 ? (
            <p className="team-view-empty">
              No teammates yet. Bots you create, scheduled tasks and automations show up here.
            </p>
          ) : (
            <div className="team-view-body">
              <ul className="team-view-roster">
                {model.members.map((member) => {
                  const active = selected?.id === member.id;
                  return (
                    <li key={member.id}>
                      <button
                        type="button"
                        className={`team-view-member${active ? " selected" : ""}`}
                        aria-pressed={active}
                        onClick={() => setSelectedId(member.id)}
                      >
                        <TeamAvatar member={member} />
                        <span className="team-view-member-text">
                          <span className="team-view-member-name">
                            {member.name}
                            <span className="team-view-kind">{member.kindLabel}</span>
                          </span>
                          <span className={`team-view-member-status state-${member.state}`}>
                            {member.status}
                          </span>
                        </span>
                        {member.waiting.length > 0 && (
                          <span
                            className="team-view-badge"
                            aria-label={`${member.waiting.length} waiting on you`}
                          >
                            {member.waiting.length}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {selected && (
                <article className="team-view-detail" aria-labelledby="team-detail-title">
                  <div className="team-view-detail-head">
                    <TeamAvatar member={selected} large />
                    <div className="team-view-detail-title">
                      <h3 id="team-detail-title">
                        {selected.name}
                        <span className="team-view-kind">{selected.kindLabel}</span>
                      </h3>
                      <span className={`team-view-member-status state-${selected.state}`}>
                        {selected.status}
                      </span>
                    </div>
                  </div>

                  <div className="team-view-actions">
                    <button type="button" className="primary" onClick={() => open(selected.open)}>
                      {OPEN_LABEL[selected.open.type]}
                    </button>
                    {selected.access && (
                      <button
                        type="button"
                        onClick={() => setEditingRoleId(selected.access!.roleId)}
                      >
                        Edit agent
                      </button>
                    )}
                    {selected.schedule && (
                      <button
                        type="button"
                        disabled={savingSchedule}
                        onClick={() => void toggleSchedule(selected)}
                      >
                        {selected.schedule.enabled ? "Pause schedule" : "Resume schedule"}
                      </button>
                    )}
                  </div>
                  {scheduleError && (
                    <p className="team-view-error" role="alert">
                      {scheduleError}
                    </p>
                  )}

                  {selected.access && (
                    <div className="team-view-block">
                      <h4>
                        <label htmlFor="team-view-access">May do alone</label>
                      </h4>
                      <select
                        id="team-view-access"
                        className="team-view-select"
                        value={selected.access.profileId ?? ""}
                        disabled={savingAccess}
                        onChange={(event) =>
                          void changeAccessLimit(selected.access!.roleId, event.target.value)
                        }
                      >
                        <option value="">No limit: each session's own access</option>
                        {accessChoices.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.label}
                          </option>
                        ))}
                        {selected.access.profileId &&
                          !accessChoices.some(
                            (choice) => choice.id === selected.access!.profileId,
                          ) && (
                            <option value={selected.access.profileId}>Unavailable profile</option>
                          )}
                      </select>
                      <p className="team-view-note">
                        Its sessions, schedules and check-ins never get more access than this; a
                        session can still be stricter. Work it does while you're away can't ask you,
                        so anything that needs your OK is refused.
                      </p>
                      {accessError && (
                        <p className="team-view-error" role="alert">
                          {accessError}
                        </p>
                      )}
                    </div>
                  )}

                  {selected.description && (
                    <div className="team-view-block">
                      <h4>Responsible for</h4>
                      <p className="team-view-description">{selected.description}</p>
                    </div>
                  )}

                  {selected.waiting.length > 0 && (
                    <div className="team-view-block">
                      <h4>Waiting on you</h4>
                      <ul className="team-view-list">
                        {selected.waiting.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => item.taskId && onOpenTask(item.taskId)}
                              disabled={!item.taskId}
                            >
                              <span className="team-view-pill needs">{item.state}</span>
                              <span className="team-view-list-title">{item.title}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {selected.facts.length > 0 && (
                    <div className="team-view-block">
                      <h4>How it's set up</h4>
                      <dl className="team-view-facts">
                        {selected.facts.map((fact) => (
                          <div key={fact.label}>
                            <dt>{fact.label}</dt>
                            <dd>{fact.value}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="team-view-note">
                        {selected.access
                          ? "Change these with Edit agent."
                          : `Change these where they're set: ${OPEN_LABEL[selected.open.type].replace("Open in ", "")}.`}
                      </p>
                    </div>
                  )}

                  <div className="team-view-block">
                    <h4>Recent work</h4>
                    {selected.recent.length === 0 ? (
                      <p className="team-view-note">Nothing yet.</p>
                    ) : (
                      <ul className="team-view-list">
                        {selected.recent.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => item.taskId && onOpenTask(item.taskId)}
                              disabled={!item.taskId}
                            >
                              <span
                                className={`team-view-pill${item.statusLabel === "Needs you" ? " needs" : ""}`}
                              >
                                {item.statusLabel}
                              </span>
                              <span className="team-view-list-title">{item.title}</span>
                              <span className="team-view-list-time">
                                {formatHomeSessionTime(item.at, now)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </article>
              )}
            </div>
          )}
        </section>
      </div>
      {editingRoleId && (
        <AgentRoleEditorDialog
          roleId={editingRoleId}
          onClose={() => setEditingRoleId(null)}
          onSaved={() => reloadRoles()}
        />
      )}
    </main>
  );
}
