import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Code2, LayoutDashboard, AppWindow, Gauge, Plus, X } from "lucide-react";
import { isTempWorkspaceId, type TaskStatus, type Workspace } from "../../../shared/types";
import { getWorkspaceStatusFolderLabel } from "../MainContent/welcome-suggestions";
import { ModelDropdown, type ModelDropdownProps } from "../MainContent/ModelDropdown";
import { formatFileSize, type PendingAttachment } from "../MainContent/attachments";
import { hasHostMethod } from "../../host/browser-capabilities";
import { CalmFolderMenu } from "./CalmTopBar";
import { BuildAccessPicker, useBuildAccessProfile } from "./BuildAccessPicker";
import type { AccessProfileId } from "../../../shared/access-profiles";
import type { SettingsTab } from "../MainContent/main-content-types";
import { BUILD_FOCUS_COMPOSER_EVENT } from "./build-events";
import { BUILD_INSTRUCTIONS } from "./build-task";
import { UseCasesGallery } from "../UseCasesGallery";
import { OPEN_USE_CASES_EVENT } from "../use-cases-events";

interface BuildPanelProps {
  onStart: (
    prompt: string,
    attachments?: PendingAttachment[],
    options?: { accessProfileId?: AccessProfileId },
  ) => void | boolean | Promise<void | boolean>;
  /** Folder the new build task will run in. */
  workspace: Workspace | null;
  onSelectWorkspace: (workspace: Workspace) => void;
  onPickFolder: () => void;
  folderPickerUnavailableReason?: string;
  showWorkspacePaths?: boolean;
  /** Model picker shown in the composer, as in the modern theme. */
  model: ModelDropdownProps;
  onOpenSettings?: (tab?: SettingsTab) => void;
  /** Latest tasks started from Build, newest first. */
  recentBuilds?: RecentBuild[];
  onOpenBuild?: (taskId: string) => void;
}

export interface RecentBuild {
  id: string;
  title: string;
  status: TaskStatus;
  updatedAt: number;
}

const RUNNING_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "pending",
  "queued",
  "planning",
  "executing",
]);

function getRecentBuildState(status: TaskStatus): { label: string; tone: string } {
  if (RUNNING_STATUSES.has(status)) return { label: "building", tone: "running" };
  if (status === "completed") return { label: "ready", tone: "done" };
  if (status === "failed") return { label: "failed", tone: "error" };
  if (status === "cancelled" || status === "interrupted")
    return { label: "stopped", tone: "error" };
  return { label: status, tone: "idle" };
}

function formatAgo(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const BUILD_STARTERS = [
  {
    id: "dashboard",
    icon: LayoutDashboard,
    title: "Dashboard from a spreadsheet",
    prompt: "Turn a spreadsheet I'll share into an interactive dashboard with filters and KPIs.",
  },
  {
    id: "tool",
    icon: AppWindow,
    title: "Small internal tool",
    prompt: "Build a small internal tool for my team. I'll describe what it should do.",
  },
  {
    id: "tracker",
    icon: Gauge,
    title: "Live status tracker",
    prompt: "Build a live status tracker that shows what is on track, at risk and blocked.",
  },
];

/** Same cap as the home composer: grow with the text, then scroll. */
const COMPOSER_MAX_HEIGHT = 200;

/**
 * The unsent prompt and attachments outlive the view, so leaving Build (for
 * Home, a session or settings) and coming back keeps what was typed. Cleared
 * once a build starts.
 */
const buildDraft: { value: string; attachments: PendingAttachment[] } = {
  value: "",
  attachments: [],
};

export async function submitBuildTask(
  onStart: BuildPanelProps["onStart"],
  text: string,
  attachments: PendingAttachment[] = [],
  options?: { accessProfileId?: AccessProfileId },
): Promise<boolean> {
  const trimmed =
    text.trim() || (attachments.length > 0 ? "Build something from the attached files." : "");
  if (!trimmed) return false;
  const result = await onStart(`${trimmed}\n\n${BUILD_INSTRUCTIONS}`, attachments, options);
  return result !== false;
}

/**
 * Entry point for building small apps, dashboards and tools from plain
 * language. Starts a normal task with instructions that steer it toward a
 * previewable web artifact.
 */
export function BuildPanel({
  onStart,
  workspace,
  onSelectWorkspace,
  onPickFolder,
  folderPickerUnavailableReason,
  showWorkspacePaths,
  model,
  onOpenSettings,
  recentBuilds = [],
  onOpenBuild,
}: BuildPanelProps) {
  const access = useBuildAccessProfile();
  const [value, setValue] = useState(() => buildDraft.value);
  const [useCasesOpen, setUseCasesOpen] = useState(false);

  useEffect(() => {
    const onOpen = (event: Event) => {
      event.preventDefault();
      setUseCasesOpen(true);
    };
    window.addEventListener(OPEN_USE_CASES_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_USE_CASES_EVENT, onOpen);
  }, []);
  const [recentWorkspaces, setRecentWorkspaces] = useState<Workspace[]>([]);

  const loadRecentWorkspaces = useCallback(async () => {
    try {
      const workspaces = await window.electronAPI.listWorkspaces();
      setRecentWorkspaces(
        workspaces
          .filter((w: Workspace) => !w.isTemp && !isTempWorkspaceId(w.id))
          .sort(
            (a: Workspace, b: Workspace) =>
              (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt),
          ),
      );
    } catch {
      setRecentWorkspaces([]);
    }
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>(() => buildDraft.attachments);

  useEffect(() => {
    buildDraft.value = value;
    buildDraft.attachments = attachments;
  }, [value, attachments]);
  const canAttach = hasHostMethod("selectFiles");

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [value]);

  const attachFiles = async () => {
    try {
      const pickerDefaultPath =
        workspace && !workspace.isTemp && !isTempWorkspaceId(workspace.id)
          ? workspace.path
          : undefined;
      const files = await window.electronAPI.selectFiles(pickerDefaultPath);
      if (!files?.length) return;
      setAttachments((current) => {
        const known = new Set(current.map((file) => file.path ?? file.name));
        const added = files
          .filter((file) => !known.has(file.path ?? file.name))
          .map((file) => ({
            ...file,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          }));
        return [...current, ...added];
      });
    } catch (error) {
      console.error("Failed to select files:", error);
    } finally {
      inputRef.current?.focus();
    }
  };

  // The composer is the view's starting point: focus it on arrival and when the
  // sidebar's New build asks again.
  useEffect(() => {
    const focusComposer = () => inputRef.current?.focus();
    focusComposer();
    window.addEventListener(BUILD_FOCUS_COMPOSER_EVENT, focusComposer);
    return () => window.removeEventListener(BUILD_FOCUS_COMPOSER_EVENT, focusComposer);
  }, []);

  const canSubmit = (value.trim().length > 0 || attachments.length > 0) && !submitting;

  const submit = async (text: string) => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const admitted = await submitBuildTask(onStart, text, attachments, {
        accessProfileId: access.profileId,
      });
      if (admitted) {
        // Admission can navigate away before another render/effect is committed.
        buildDraft.value = "";
        buildDraft.attachments = [];
        setValue("");
        setAttachments([]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="main-content calm-view calm-build">
      <UseCasesGallery
        open={useCasesOpen}
        contained
        initialCategory="build"
        onClose={() => setUseCasesOpen(false)}
        onSelect={(prompt) => {
          setValue(prompt);
          inputRef.current?.focus();
        }}
      />
      <div className="calm-view-inner calm-build-inner">
        <div className="calm-build-kicker">
          <Code2 size={16} aria-hidden="true" />
          <span>Build</span>
        </div>
        <h1 className="calm-greeting calm-build-title">What should we build?</h1>
        <p className="calm-view-subtitle">
          Describe a dashboard, tool or small app. CoWork writes the code and shows you a live
          preview.
        </p>

        <form
          className="calm-build-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(value);
          }}
        >
          {attachments.length > 0 && (
            <div className="attachment-list calm-build-attachments">
              {attachments.map((attachment) => (
                <div className="attachment-chip" key={attachment.id}>
                  <span className="attachment-name" title={attachment.name}>
                    {attachment.name}
                  </span>
                  <span className="attachment-size">{formatFileSize(attachment.size)}</span>
                  <button
                    type="button"
                    className="attachment-remove"
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((file) => file.id !== attachment.id),
                      )
                    }
                    disabled={submitting}
                    title="Remove attachment"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className="attachment-btn calm-build-attach"
            onClick={() => void attachFiles()}
            disabled={submitting || !canAttach}
            title={canAttach ? "Add files" : "File uploads are unavailable on this host"}
            aria-label="Add files"
          >
            <Plus size={20} aria-hidden="true" />
          </button>
          <textarea
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit(value);
              }
            }}
            placeholder="Turn my supplier report into a live app for the team…"
            rows={1}
            aria-label="Describe what to build"
          />
          <ModelDropdown {...model} variant="label" align="right" />
          <button
            type="submit"
            className="calm-send-button"
            disabled={!canSubmit}
            aria-label="Start building"
            title="Start building"
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </form>

        <div className="calm-build-status">
          <CalmFolderMenu
            scope={{
              label: getWorkspaceStatusFolderLabel(workspace),
              workspaces: recentWorkspaces,
              activeWorkspaceId: workspace?.id,
              onSelect: onSelectWorkspace,
              onNewFolder: onPickFolder,
              onNewFolderDisabledReason: folderPickerUnavailableReason,
              showWorkspacePaths,
              onOpen: () => void loadRecentWorkspaces(),
            }}
          />
          <BuildAccessPicker
            profileId={access.profileId}
            customProfiles={access.customProfiles}
            approvalPromptsEnabled={access.approvalPromptsEnabled}
            onSelect={access.select}
            onOpenSettings={onOpenSettings ? () => onOpenSettings("system") : undefined}
            disabled={submitting}
          />
          <span className="calm-build-hints" aria-hidden="true">
            <kbd>↵</kbd> to build · <kbd>⇧↵</kbd> new line
          </span>
        </div>

        <div className="calm-build-starters">
          {BUILD_STARTERS.map((starter) => {
            const Icon = starter.icon;
            return (
              <button
                key={starter.id}
                type="button"
                className="calm-build-starter"
                onClick={() => {
                  setValue(starter.prompt);
                  inputRef.current?.focus();
                }}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{starter.title}</span>
              </button>
            );
          })}
        </div>

        {recentBuilds.length > 0 && onOpenBuild && (
          <section className="calm-build-recent" aria-label="Recent builds">
            <div className="calm-build-recent-head">
              <span>recent builds</span>
            </div>
            <ul>
              {recentBuilds.map((build) => {
                const state = getRecentBuildState(build.status);
                return (
                  <li key={build.id}>
                    <button
                      type="button"
                      className="calm-build-recent-row"
                      onClick={() => onOpenBuild(build.id)}
                    >
                      <span
                        className={`calm-build-recent-dot tone-${state.tone}`}
                        aria-hidden="true"
                      />
                      <span className="calm-build-recent-title">{build.title}</span>
                      <span className={`calm-build-recent-state tone-${state.tone}`}>
                        {state.label}
                      </span>
                      <span className="calm-build-recent-time">{formatAgo(build.updatedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <button
          type="button"
          className="use-cases-link use-cases-welcome-link"
          onClick={() => setUseCasesOpen(true)}
        >
          See what people build with CoWork OS
        </button>
      </div>
    </main>
  );
}
