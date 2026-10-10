import { useState } from "react";
import type { Workspace } from "../../../shared/types";

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

/**
 * The composer's folder picker: recent folders, then "work in another folder" and "work
 * without a folder". Each folder except the current one can be removed from CoWork after
 * an inline confirmation; removing deletes its sessions and memory, never its files.
 */
export function WorkspaceDropdownMenu({
  workspaces,
  currentWorkspaceId,
  onSelect,
  onSelectNewFolder,
  onUseTempWorkspace,
  onRemove,
}: {
  workspaces: Workspace[];
  currentWorkspaceId?: string;
  onSelect: (workspace: Workspace) => void;
  onSelectNewFolder: () => void;
  /** Present when the user may switch to scratch work. */
  onUseTempWorkspace?: () => void;
  /** Resolves once the folder is gone; throws with a message to show otherwise. */
  onRemove?: (workspace: Workspace) => Promise<void>;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = workspaces.slice(0, 10);

  const remove = async (workspace: Workspace) => {
    if (!onRemove) return;
    setRemovingId(workspace.id);
    setError(null);
    try {
      await onRemove(workspace);
      setConfirmingId(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove the folder.");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="workspace-dropdown">
      {shown.length > 0 && (
        <>
          <div className="workspace-dropdown-header">Recent Folders</div>
          <div
            className={`workspace-dropdown-list ${shown.length > 6 ? "workspace-dropdown-list-scrolls" : ""}`}
          >
            {shown.map((w) => {
              const active = currentWorkspaceId === w.id;
              if (confirmingId === w.id) {
                return (
                  <div key={w.id} className="workspace-dropdown-confirm" role="group">
                    <div className="workspace-dropdown-confirm-text">
                      <strong>Remove “{w.name}” from CoWork?</strong>
                      <span>Its sessions and memory are deleted. Files in the folder stay.</span>
                      {error && <span className="workspace-dropdown-confirm-error">{error}</span>}
                    </div>
                    <div className="workspace-dropdown-confirm-actions">
                      <button
                        type="button"
                        className="workspace-dropdown-confirm-cancel"
                        onClick={() => {
                          setConfirmingId(null);
                          setError(null);
                        }}
                        disabled={removingId === w.id}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="workspace-dropdown-confirm-remove"
                        onClick={() => void remove(w)}
                        disabled={removingId === w.id}
                      >
                        {removingId === w.id ? "Removing…" : "Remove"}
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={w.id} className={`workspace-dropdown-row ${active ? "active" : ""}`}>
                  <button
                    type="button"
                    className={`workspace-dropdown-item ${active ? "active" : ""}`}
                    onClick={() => onSelect(w)}
                  >
                    <FolderIcon />
                    <div className="workspace-item-info">
                      <span className="workspace-item-name">{w.name}</span>
                      <span className="workspace-item-path">{w.path}</span>
                    </div>
                    {active && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="check-icon"
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                  {onRemove && !active && (
                    <button
                      type="button"
                      className="workspace-dropdown-remove"
                      aria-label={`Remove ${w.name} from CoWork`}
                      title="Remove from CoWork"
                      onClick={() => {
                        setConfirmingId(w.id);
                        setError(null);
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="workspace-dropdown-divider" />
        </>
      )}
      <button
        type="button"
        className="workspace-dropdown-item new-folder"
        onClick={onSelectNewFolder}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>Work in another folder...</span>
      </button>
      {onUseTempWorkspace && (
        <button
          type="button"
          className="workspace-dropdown-item new-folder"
          onClick={onUseTempWorkspace}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
          <span>Work without a folder</span>
        </button>
      )}
    </div>
  );
}
