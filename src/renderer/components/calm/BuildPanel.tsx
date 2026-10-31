import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Code2,
  LayoutDashboard,
  AppWindow,
  Gauge,
  GitBranch,
  Monitor,
  Plus,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  isTempWorkspaceId,
  type AgentConfig,
  type TaskStatus,
  type Workspace,
  type WorktreeWorkspaceInfo,
} from "../../../shared/types";
import { getWorkspaceStatusFolderLabel } from "../MainContent/welcome-suggestions";
import { ModelDropdown, type ModelDropdownProps } from "../MainContent/ModelDropdown";
import { type PendingAttachment } from "../MainContent/attachments";
import { hasHostMethod } from "../../host/browser-capabilities";
import { CalmFolderMenu } from "./CalmTopBar";
import { BuildAccessPicker, useBuildAccessProfile } from "./BuildAccessPicker";
import type { AccessProfileId } from "../../../shared/access-profiles";
import type { SettingsTab } from "../MainContent/main-content-types";
import { BUILD_FOCUS_COMPOSER_EVENT } from "./build-events";
import {
  BUILD_INSTRUCTIONS,
  GUEST_BUILD_INSTRUCTIONS,
  getBuildComputerPolicyIssue,
} from "./build-task";
import { resolveAccessProfileDefinition } from "../../../shared/access-profiles";
import { UseCasesGallery } from "../UseCasesGallery";
import { OPEN_USE_CASES_EVENT } from "../use-cases-events";
import { AttachmentTile } from "../AttachmentTile";
import { BuildMergeReview } from "./BuildMergeReview";

/** Where a build runs: its checkout, and for Build Compare the shared commit and check. */
export type BuildCheckoutOptions = Pick<
  AgentConfig,
  | "executionEnvironment"
  | "worktreeMode"
  | "worktreeBaseBranch"
  | "worktreeBaseCommit"
  | "compareGroupId"
  | "compareVariant"
  | "compareCheckCommand"
>;

interface BuildPanelProps {
  onStart: (
    prompt: string,
    attachments?: PendingAttachment[],
    options?: { accessProfileId?: AccessProfileId } & BuildCheckoutOptions,
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

/** A native select drawn like the row's other quiet buttons: icon, value, chevron. */
function BuildSelect({
  icon: Icon,
  label,
  title,
  value,
  disabled,
  onChange,
  children,
}: {
  icon?: LucideIcon;
  label: string;
  title?: string;
  value: string | number;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="calm-build-select" title={title}>
      {Icon ? <Icon size={14} aria-hidden="true" /> : null}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown className="calm-build-select-chevron" size={14} aria-hidden="true" />
    </label>
  );
}

function splitPathLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Build Compare: the same request as `count` worktree builds, all started from the commit the
 * branch points to now and all checked by the same command, to compare and merge one. Stops at
 * the first variant that is not admitted.
 */
export async function submitBuildCompare(
  onStart: BuildPanelProps["onStart"],
  text: string,
  attachments: PendingAttachment[],
  options: {
    workspaceId: string;
    branch?: string;
    count: number;
    check: string;
    accessProfileId?: AccessProfileId;
    resolveBaseCommit: (input: { workspaceId: string; branch?: string }) => Promise<{
      commit: string;
    }>;
    newGroupId: () => string;
  },
): Promise<boolean> {
  const { commit } = await options.resolveBaseCommit({
    workspaceId: options.workspaceId,
    ...(options.branch ? { branch: options.branch } : {}),
  });
  const compareGroupId = options.newGroupId();
  const check = options.check.trim();
  let admittedAny = false;
  for (let variant = 1; variant <= Math.min(Math.max(options.count, 2), 3); variant += 1) {
    const admitted = await submitBuildTask(onStart, text, attachments, {
      ...(options.accessProfileId ? { accessProfileId: options.accessProfileId } : {}),
      worktreeMode: "worktree",
      ...(options.branch ? { worktreeBaseBranch: options.branch } : {}),
      worktreeBaseCommit: commit,
      compareGroupId,
      compareVariant: variant,
      ...(check ? { compareCheckCommand: check } : {}),
    });
    if (!admitted) break;
    admittedAny = true;
  }
  return admittedAny;
}

/**
 * The unsent prompt and attachments outlive the view, so leaving Build (for
 * Home, a session or settings) and coming back keeps what was typed. Cleared
 * once a build starts.
 */
const buildDraft: { value: string; attachments: PendingAttachment[] } = {
  value: "",
  attachments: [],
};

type CheckoutMode = "local" | "worktree" | "compare";

const buildCheckoutDraft: {
  workspaceId?: string;
  mode: CheckoutMode;
  branch: string;
} = { mode: "local", branch: "" };

export async function submitBuildTask(
  onStart: BuildPanelProps["onStart"],
  text: string,
  attachments: PendingAttachment[] = [],
  options?: { accessProfileId?: AccessProfileId } & BuildCheckoutOptions,
): Promise<boolean> {
  const trimmed =
    text.trim() || (attachments.length > 0 ? "Build something from the attached files." : "");
  if (!trimmed) return false;
  const instructions = options?.executionEnvironment
    ? GUEST_BUILD_INSTRUCTIONS
    : BUILD_INSTRUCTIONS;
  const result = await onStart(`${trimmed}\n\n${instructions}`, attachments, options);
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
  const [computer, setComputer] = useState<"host" | "bot-desktop" | "cua">("host");
  const [computerInputs, setComputerInputs] = useState("");
  const [computerOutputs, setComputerOutputs] = useState("");
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>(() =>
    buildCheckoutDraft.workspaceId === workspace?.id ? buildCheckoutDraft.mode : "local",
  );
  const [startingBranch, setStartingBranch] = useState(() =>
    buildCheckoutDraft.workspaceId === workspace?.id ? buildCheckoutDraft.branch : "",
  );
  const checkoutWorkspaceId = useRef(workspace?.id);
  const [worktreeWorkspace, setWorktreeWorkspace] = useState<WorktreeWorkspaceInfo | null>(null);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  // Build Compare: how many variants, and the check each one runs before it finishes.
  const [compareCount, setCompareCount] = useState(2);
  const [compareCheck, setCompareCheck] = useState("");

  useEffect(() => {
    let current = true;
    setWorktreeWorkspace(null);
    setWorktreeError(null);
    if (checkoutWorkspaceId.current !== workspace?.id) {
      checkoutWorkspaceId.current = workspace?.id;
      setStartingBranch("");
      setCheckoutMode("local");
    }
    if (!workspace || workspace.isTemp || isTempWorkspaceId(workspace.id)) {
      setWorktreeError("Choose a Git project folder to use a worktree.");
      return;
    }
    if (
      !hasHostMethod("getWorktreeWorkspaceInfo") ||
      !window.electronAPI?.getWorktreeWorkspaceInfo
    ) {
      setWorktreeError("Worktree selection is unavailable on this host. Use the desktop app.");
      return;
    }
    void window.electronAPI
      .getWorktreeWorkspaceInfo(workspace.id)
      .then((info) => {
        if (!current) return;
        if (info.workspaceId !== workspace.id)
          throw new Error("The host returned another workspace.");
        setWorktreeWorkspace(info);
        setStartingBranch((branch) => (info.branches.includes(branch) ? branch : ""));
      })
      .catch((error: unknown) => {
        if (current)
          setWorktreeError(
            error instanceof Error ? error.message : "Could not check the Git repository.",
          );
      });
    return () => {
      current = false;
    };
  }, [workspace?.id, workspace?.path, workspace?.permissions.write]);
  useEffect(() => {
    buildCheckoutDraft.workspaceId = workspace?.id;
    buildCheckoutDraft.mode = checkoutMode;
    buildCheckoutDraft.branch = startingBranch;
  }, [workspace?.id, checkoutMode, startingBranch]);
  const worktreeAvailable =
    worktreeWorkspace?.workspaceId === workspace?.id && worktreeWorkspace?.available === true;
  const worktreeReason = worktreeError || worktreeWorkspace?.reason || "Checking Git repository…";
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

  const transferInputCount = splitPathLines(computerInputs).length;
  const transferOutputCount = splitPathLines(computerOutputs).length;
  const computerPolicyIssue = getBuildComputerPolicyIssue(
    computer,
    resolveAccessProfileDefinition(access.profileId, access.customProfiles),
  );
  const canSubmit =
    (value.trim().length > 0 || attachments.length > 0) &&
    !submitting &&
    !computerPolicyIssue &&
    (checkoutMode === "local" || worktreeAvailable);

  /**
   * Build Compare: the same request as several worktree builds, all started from one commit
   * and checked by the same command, to compare and merge one.
   */
  const submitCompare = async (text: string): Promise<boolean> => {
    const resolveBaseCommit = window.electronAPI?.resolveWorktreeBaseCommit;
    if (!workspace || !resolveBaseCommit) return false;
    return submitBuildCompare(onStart, text, attachments, {
      workspaceId: workspace.id,
      ...(startingBranch ? { branch: startingBranch } : {}),
      count: compareCount,
      check: compareCheck,
      accessProfileId: access.profileId,
      resolveBaseCommit: (input) => resolveBaseCommit(input),
      newGroupId: () => crypto.randomUUID(),
    });
  };

  const submit = async (text: string) => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const admitted =
        checkoutMode === "compare"
          ? await submitCompare(text)
          : await submitBuildTask(onStart, text, attachments, {
              accessProfileId: access.profileId,
              worktreeMode: checkoutMode,
              ...(computer !== "host"
                ? {
                    executionEnvironment: {
                      backend: computer,
                      lifetime: "task" as const,
                      inputPaths: splitPathLines(computerInputs),
                      outputPaths: splitPathLines(computerOutputs),
                    },
                  }
                : {}),
              ...(checkoutMode === "worktree" && startingBranch
                ? { worktreeBaseBranch: startingBranch }
                : {}),
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
                <AttachmentTile
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() =>
                    setAttachments((current) => current.filter((file) => file.id !== attachment.id))
                  }
                  disabled={submitting}
                />
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
          <div className="calm-build-location">
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
            <BuildSelect
              icon={GitBranch}
              label="Build location"
              title={
                checkoutMode === "compare"
                  ? "Build the same request in several checkouts and compare them"
                  : checkoutMode === "worktree"
                    ? "Build in a separate Git checkout"
                    : "Build directly in the selected folder"
              }
              value={checkoutMode}
              disabled={submitting}
              onChange={(next) => setCheckoutMode(next as CheckoutMode)}
            >
              <option value="local">Local</option>
              <option value="worktree" disabled={!worktreeAvailable}>
                Worktree
              </option>
              <option value="compare" disabled={!worktreeAvailable || computer !== "host"}>
                Compare
              </option>
            </BuildSelect>
            <BuildSelect
              icon={Monitor}
              label="Task computer"
              title={
                checkoutMode === "compare"
                  ? "Compare builds run on this computer"
                  : computer === "host"
                    ? "Computer: build on this computer"
                    : "Computer: build on a fresh computer that is deleted when the task ends"
              }
              value={computer}
              disabled={submitting || checkoutMode === "compare"}
              onChange={(next) => setComputer(next as typeof computer)}
            >
              <option value="host">This computer</option>
              <option value="bot-desktop">Fresh Linux computer</option>
              <option value="cua">Fresh Cua Space</option>
            </BuildSelect>
            {checkoutMode === "compare" && worktreeAvailable && (
              <BuildSelect
                label="Number of variants"
                value={compareCount}
                disabled={submitting}
                onChange={(next) => setCompareCount(Number(next))}
              >
                <option value={2}>2 variants</option>
                <option value={3}>3 variants</option>
              </BuildSelect>
            )}
            {checkoutMode !== "local" && worktreeAvailable && (
              <BuildSelect
                label="Starting branch"
                value={startingBranch}
                disabled={submitting}
                onChange={setStartingBranch}
              >
                <option value="">
                  Current checkout ({worktreeWorkspace?.currentBranch || "HEAD"})
                </option>
                {worktreeWorkspace?.branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </BuildSelect>
            )}
          </div>
          <BuildAccessPicker
            profileId={access.profileId}
            customProfiles={access.customProfiles}
            approvalPromptsEnabled={access.approvalPromptsEnabled}
            onSelect={access.select}
            onOpenSettings={onOpenSettings ? () => onOpenSettings("system") : undefined}
            disabled={submitting}
          />
        </div>
        {computerPolicyIssue ? (
          <p className="calm-build-notice" role="status">
            <TriangleAlert size={14} aria-hidden="true" />
            <span>{computerPolicyIssue}</span>
          </p>
        ) : null}
        {computer !== "host" && checkoutMode !== "compare" ? (
          <details className="calm-build-transfers">
            <summary>
              <ChevronRight className="calm-build-transfers-chevron" size={14} aria-hidden="true" />
              <span>Files for this computer</span>
              <span className="calm-build-transfers-count">
                {transferInputCount || transferOutputCount
                  ? `${transferInputCount} in · ${transferOutputCount} out`
                  : "None selected"}
              </span>
            </summary>
            <div className="calm-build-transfer-fields">
              <label>
                <span className="calm-build-transfer-label">Input files</span>
                <span className="calm-build-transfer-hint">
                  From this folder, one path per line
                </span>
                <textarea
                  value={computerInputs}
                  rows={3}
                  spellCheck={false}
                  placeholder="data/input.csv"
                  onChange={(event) => setComputerInputs(event.target.value)}
                />
              </label>
              <label>
                <span className="calm-build-transfer-label">Result files</span>
                <span className="calm-build-transfer-hint">
                  From its work folder, one path per line
                </span>
                <textarea
                  value={computerOutputs}
                  rows={3}
                  spellCheck={false}
                  placeholder="result.csv"
                  onChange={(event) => setComputerOutputs(event.target.value)}
                />
              </label>
            </div>
            <p className="calm-build-transfer-note">
              Only listed files are copied in. Results are saved before the fresh computer is
              deleted. Needs Docker, Podman or Cua Spaces.
            </p>
          </details>
        ) : null}
        {checkoutMode === "compare" && worktreeAvailable && (
          <input
            className="calm-build-compare-check"
            type="text"
            value={compareCheck}
            maxLength={500}
            disabled={submitting}
            onChange={(event) => setCompareCheck(event.target.value)}
            placeholder="Check each variant runs before it finishes, e.g. npm test (optional)"
            aria-label="Check command for every variant"
          />
        )}
        <div className="calm-build-footnote">
          <p className="calm-build-location-help" aria-live="polite">
            {checkoutMode === "compare" && worktreeAvailable
              ? "Builds the same request in separate checkouts from one commit. Compare them below and merge one."
              : checkoutMode === "worktree" && worktreeAvailable
                ? "Starts from committed code in a separate checkout. Local uncommitted changes stay in your folder."
                : !worktreeAvailable
                  ? worktreeReason
                  : "Local builds edit this folder. Choose Worktree to keep changes isolated."}
          </p>
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

        {workspace && worktreeAvailable && (
          <BuildMergeReview workspaceId={workspace.id} onOpenBuild={onOpenBuild} />
        )}

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
