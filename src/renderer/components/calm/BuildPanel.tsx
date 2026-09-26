import { useCallback, useRef, useState } from "react";
import { ArrowUp, Code2, LayoutDashboard, AppWindow, Gauge } from "lucide-react";
import { isTempWorkspaceId, type Workspace } from "../../../shared/types";
import { getWorkspaceStatusFolderLabel } from "../MainContent/welcome-suggestions";
import { ModelDropdown, type ModelDropdownProps } from "../MainContent/ModelDropdown";
import { CalmFolderMenu } from "./CalmTopBar";

interface BuildPanelProps {
  onStart: (prompt: string) => void | Promise<void>;
  /** Folder the new build task will run in. */
  workspace: Workspace | null;
  onSelectWorkspace: (workspace: Workspace) => void;
  onPickFolder: () => void;
  /** Model picker shown in the composer, as in the modern theme. */
  model: ModelDropdownProps;
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

const BUILD_INSTRUCTIONS =
  "Build this as a self-contained interactive web app (HTML, CSS and JavaScript) and open a live preview when it is ready. Keep it clean and usable by non-developers.";

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
  model,
}: BuildPanelProps) {
  const [value, setValue] = useState("");
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

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onStart(`${trimmed}\n\n${BUILD_INSTRUCTIONS}`);
      setValue("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="main-content calm-view calm-build">
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
            rows={2}
            aria-label="Describe what to build"
          />
          <ModelDropdown {...model} variant="label" align="right" />
          <button
            type="submit"
            className="calm-send-button"
            disabled={!value.trim() || submitting}
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
              onOpen: () => void loadRecentWorkspaces(),
            }}
          />
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
      </div>
    </main>
  );
}
