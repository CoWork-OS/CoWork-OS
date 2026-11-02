import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Folder, Monitor } from "lucide-react";
import type {
  LLMModelInfo,
  LLMProviderType,
  LLMReasoningEffort,
  Workspace,
} from "../../../shared/types";
import type { AccessProfileDefinition } from "../../../shared/access-profiles";
import type { TaskProposal, TaskProposalStartOptions } from "../../../shared/task-proposals";
import {
  getLlmModelDefaultReasoningEffort,
  getLlmModelReasoningEfforts,
  getLlmReasoningEffortOptions,
} from "../../../shared/llm-model-selection";
import { hasHostMethod } from "../../host/browser-capabilities";

/** Defaults the Options popover shows: this task's folder, model, effort and access. */
export interface SuggestedTaskOptionsContext {
  workspace: Pick<Workspace, "id" | "name" | "path"> | null;
  providerType?: LLMProviderType;
  modelKey?: string;
  models: LLMModelInfo[];
  reasoningEffort?: LLMReasoningEffort;
  accessProfiles: readonly AccessProfileDefinition[];
  accessProfileId?: string;
}

const POPOVER_GAP = 6;
const VIEWPORT_PADDING = 12;

type WorktreeAvailability = { available: boolean; reason?: string } | null;

/**
 * Options for one suggested task before Start (Environment, folder, Worktree, Model, Effort,
 * Permissions). Only what the person changes is sent; the rest follows the task's defaults.
 */
export function SuggestedTaskOptionsPopover({
  proposal,
  context,
  value,
  onChange,
  onClose,
  anchorRef,
}: {
  proposal: TaskProposal;
  context: SuggestedTaskOptionsContext;
  value: TaskProposalStartOptions | undefined;
  onChange: (options: TaskProposalStartOptions) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [worktree, setWorktree] = useState<WorktreeAvailability>(null);
  const workspaceId = context.workspace?.id;

  // Follows its Options button while the transcript scrolls under it.
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const popover = popoverRef.current?.getBoundingClientRect();
      if (!anchor || !popover) return;
      const below = anchor.bottom + POPOVER_GAP;
      const top =
        below + popover.height + VIEWPORT_PADDING > window.innerHeight
          ? Math.max(VIEWPORT_PADDING, anchor.top - POPOVER_GAP - popover.height)
          : below;
      const left = Math.max(
        VIEWPORT_PADDING,
        Math.min(anchor.left, window.innerWidth - popover.width - VIEWPORT_PADDING),
      );
      setPosition((current) =>
        current && current.top === top && current.left === left ? current : { top, left },
      );
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [anchorRef, onClose]);

  useEffect(() => {
    setWorktree(null);
    if (!workspaceId) {
      setWorktree({ available: false, reason: "Choose a Git project folder to use a worktree." });
      return;
    }
    if (
      !hasHostMethod("getWorktreeWorkspaceInfo") ||
      typeof window.electronAPI?.getWorktreeWorkspaceInfo !== "function"
    ) {
      setWorktree({ available: false, reason: "Worktrees are available in the desktop app." });
      return;
    }
    let current = true;
    void window.electronAPI
      .getWorktreeWorkspaceInfo(workspaceId)
      .then((info) => {
        if (current) setWorktree({ available: info.available === true, reason: info.reason });
      })
      .catch((error: unknown) => {
        if (current) {
          setWorktree({
            available: false,
            reason: error instanceof Error ? error.message : "Could not check the Git repository.",
          });
        }
      });
    return () => {
      current = false;
    };
  }, [workspaceId]);

  const worktreeOn = value?.worktreeMode
    ? value.worktreeMode === "worktree"
    : proposal.suggestedWorktree && worktree?.available === true;

  const providerType = value?.providerType ?? context.providerType;
  const modelKey = value?.modelKey ?? context.modelKey;
  const modelInfo = context.models.find((model) => model.key === modelKey);
  const supportedEfforts =
    modelInfo?.reasoningEfforts ||
    getLlmModelReasoningEfforts(providerType, modelKey, modelInfo?.openaiAuthMethod);
  const effortOptions = providerType
    ? getLlmReasoningEffortOptions(providerType, modelInfo?.openaiAuthMethod, supportedEfforts)
    : [];
  const requestedEffort = value?.reasoningEffort ?? context.reasoningEffort;
  const defaultEffort = getLlmModelDefaultReasoningEffort(providerType, modelKey);
  const effort =
    requestedEffort && supportedEfforts.includes(requestedEffort)
      ? requestedEffort
      : defaultEffort && supportedEfforts.includes(defaultEffort)
        ? defaultEffort
        : effortOptions[0]?.value;
  const accessProfileId = value?.accessProfileId ?? context.accessProfileId;

  const update = (next: Partial<TaskProposalStartOptions>) => onChange({ ...value, ...next });

  return createPortal(
    <div
      ref={popoverRef}
      className="suggested-task-options"
      role="dialog"
      aria-label={`Options for ${proposal.title}`}
      style={
        position
          ? { top: position.top, left: position.left }
          : { top: 0, left: 0, visibility: "hidden" }
      }
    >
      <div className="suggested-task-options-environment">
        <span className="suggested-task-options-label">Environment</span>
        <span
          className="suggested-task-options-environment-value"
          title="Suggested tasks run on this computer"
        >
          <Monitor size={15} strokeWidth={1.75} aria-hidden="true" />
          Local
        </span>
      </div>
      {context.workspace && (
        <div className="suggested-task-options-folder" title={context.workspace.path}>
          <Folder size={16} strokeWidth={1.6} aria-hidden="true" />
          <span className="suggested-task-options-folder-text">
            <span className="suggested-task-options-folder-name">{context.workspace.name}</span>
            <span className="suggested-task-options-folder-path">{context.workspace.path}</span>
          </span>
        </div>
      )}
      <div className="suggested-task-options-row">
        <span className="suggested-task-options-label" id={`worktree-label-${proposal.id}`}>
          Worktree
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={worktreeOn}
          aria-labelledby={`worktree-label-${proposal.id}`}
          className={`suggested-task-switch ${worktreeOn ? "on" : ""}`}
          disabled={worktree?.available !== true}
          title={
            worktree === null
              ? "Checking Git repository…"
              : worktree.available
                ? "Run the task in its own git worktree and branch"
                : worktree.reason
          }
          onClick={() => update({ worktreeMode: worktreeOn ? "local" : "worktree" })}
        >
          <span className="suggested-task-switch-thumb" />
        </button>
      </div>
      {context.models.length > 0 && providerType && (
        <OptionSelect
          label="Model"
          value={modelKey ?? ""}
          options={context.models.map((model) => ({ value: model.key, label: model.displayName }))}
          onChange={(key) => update({ providerType, modelKey: key })}
        />
      )}
      {effortOptions.length >= 2 && providerType && modelKey && effort && (
        <OptionSelect
          label="Effort"
          value={effort}
          options={effortOptions.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(next) =>
            update({ providerType, modelKey, reasoningEffort: next as LLMReasoningEffort })
          }
        />
      )}
      {context.accessProfiles.length > 0 && (
        <OptionSelect
          label="Permissions"
          value={accessProfileId ?? ""}
          options={context.accessProfiles.map((profile) => ({
            value: profile.id,
            label: profile.label,
          }))}
          onChange={(id) => update({ accessProfileId: id })}
        />
      )}
    </div>,
    document.body,
  );
}

function OptionSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const hasValue = options.some((option) => option.value === value);
  return (
    <label className="suggested-task-options-row">
      <span className="suggested-task-options-label">{label}</span>
      <span className="suggested-task-options-select">
        <select value={hasValue ? value : ""} onChange={(event) => onChange(event.target.value)}>
          {!hasValue && <option value="">Default</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </span>
    </label>
  );
}
