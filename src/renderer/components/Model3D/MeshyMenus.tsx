import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Download, Sparkles } from "lucide-react";
import type { MeshyFormatOption, MeshyNextAction } from "../../../shared/meshy";
import { useSurfaceActions } from "../AnswerSurface/SurfaceActions";

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // IPC errors arrive wrapped: "Error invoking remote method 'meshy:save': Error: …"
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

function MenuButton({
  icon,
  label,
  iconOnly = false,
  disabled,
  onOpen,
  children,
}: {
  icon: ReactNode;
  label: string;
  /** Show only the icon (the label becomes its tooltip). */
  iconOnly?: boolean;
  disabled?: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="model-menu" ref={rootRef}>
      <button
        type="button"
        className={`model-glass-btn${iconOnly ? " is-icon" : ""}${open ? " is-open" : ""}`}
        disabled={disabled}
        title={iconOnly ? label : undefined}
        aria-label={iconOnly ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
      >
        {icon}
        {!iconOnly && <span>{label}</span>}
        {!iconOnly && <ChevronDown size={12} className="model-glass-chevron" />}
      </button>
      {open && (
        <div className="model-menu-list" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Every file type Meshy made for a task (no credits: they exist already). Picking one
 * saves it beside the model shown, or in Meshy's folder, and shows it in Finder.
 */
export function MeshyFormatMenu({
  taskId,
  beside,
  workspacePath,
  chatTaskId,
  iconOnly = false,
}: {
  taskId: string;
  beside?: string;
  /** The project `beside` may be in. */
  workspacePath?: string;
  chatTaskId?: string;
  iconOnly?: boolean;
}) {
  const [formats, setFormats] = useState<MeshyFormatOption[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const api = window.electronAPI;

  const load = () => {
    setStatus(null);
    api
      .getMeshyFormats?.({ taskId, beside, workspacePath })
      .then(setFormats)
      .catch((error: unknown) => setStatus(errorText(error)));
  };

  const save = async (option: MeshyFormatOption) => {
    if (!api.saveMeshyFormat) return;
    setBusy(true);
    setStatus(`Saving ${option.format.toUpperCase()}…`);
    try {
      const saved = await api.saveMeshyFormat({
        taskId,
        format: option.key,
        beside,
        workspacePath,
        chatTaskId,
        reveal: true,
      });
      setStatus(`Saved ${saved.path.split(/[\\/]/).pop()}`);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <MenuButton
        icon={<Download size={14} />}
        label="Download"
        iconOnly={iconOnly}
        disabled={busy}
        onOpen={load}
      >
        <div className="model-menu-heading">Download a format</div>
        {!formats && <div className="model-menu-note">{status ?? "Checking files…"}</div>}
        {formats?.length === 0 && <div className="model-menu-note">No files for this task.</div>}
        {formats?.map((option) => (
          <button
            key={option.key}
            type="button"
            role="menuitem"
            className="model-menu-item"
            onClick={() => void save(option)}
          >
            <span>
              {option.format.toUpperCase()}
              {option.clip ? ` · ${option.clip.replace(/_/g, " ")}` : ""}
            </span>
            {option.savedPath ? (
              <Check size={13} aria-label="Already saved" />
            ) : (
              <span className="model-menu-cost">free</span>
            )}
          </button>
        ))}
      </MenuButton>
      {status && formats && (
        <span className="model-card-status" role="status">
          {status}
        </span>
      )}
    </>
  );
}

/**
 * Follow-ups the task supports (texture, rig, remesh...). A pick sends a chat message
 * naming the tool and its cost; the agent then makes the call behind its approval card.
 */
export function MeshyNextMenu({ taskId }: { taskId: string }) {
  const requestAction = useSurfaceActions();
  const [actions, setActions] = useState<MeshyNextAction[] | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = window.electronAPI;

  if (!requestAction || !api.getMeshyActions) return null;

  const load = () => {
    setError(null);
    api
      .getMeshyActions?.({ taskId })
      .then((result) => {
        setActions(result.actions);
        setBalance(result.balance);
      })
      .catch((err: unknown) => setError(errorText(err)));
  };

  return (
    <MenuButton icon={<Sparkles size={14} />} label="Next" onOpen={load}>
      <div className="model-menu-heading">Continue with Meshy</div>
      {!actions && <div className="model-menu-note">{error ?? "Loading…"}</div>}
      {actions?.length === 0 && (
        <div className="model-menu-note">Nothing to do next for this task.</div>
      )}
      {actions?.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className="model-menu-item"
          disabled={!action.affordable}
          title={action.affordable ? undefined : "Not enough Meshy credits"}
          onClick={() => void requestAction({ kind: "prompt", text: action.message }, "answer")}
        >
          <span>{action.label}</span>
          <span className="model-menu-cost">
            {action.cost === 0 ? "free" : `${action.cost} cr`}
          </span>
        </button>
      ))}
      {actions && balance !== null && (
        <div className="model-menu-note">Balance: {balance.toLocaleString()} credits</div>
      )}
    </MenuButton>
  );
}
