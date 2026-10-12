import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Workspace } from "../../../shared/types";

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

/** Above this many folders the menu offers a filter field. */
const FILTER_THRESHOLD = 8;
/** Space kept between the menu and the folder button, and between the menu and any edge. */
const TRIGGER_GAP = 8;
const EDGE_GAP = 8;
/** Never squeeze the menu below this, even in a very short window. */
const MIN_MENU_HEIGHT = 160;

interface MenuFit {
  placement: "up" | "down";
  /** Distance from the viewport's top (opening down) or bottom (opening up) edge. */
  offset: number;
  left: number;
  maxHeight?: number;
  maxWidth?: number;
}

/** The window area a menu may cover: the viewport below the title bar, inset by a gap. */
function viewportBounds() {
  const titleBar = document.querySelector(".title-bar")?.getBoundingClientRect();
  return {
    top: Math.max(0, titleBar?.bottom ?? 0) + EDGE_GAP,
    left: EDGE_GAP,
    bottom: window.innerHeight - EDGE_GAP,
    right: window.innerWidth - EDGE_GAP,
  };
}

/** Render on <body> so no container can clip the menu; inline when there is no DOM. */
function inBodyPortal(node: ReactNode): ReactNode {
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

/** Case-insensitive match on a folder's name or path. */
export function filterWorkspaces(workspaces: Workspace[], query: string): Workspace[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return workspaces;
  return workspaces.filter(
    (w) => w.name.toLowerCase().includes(needle) || w.path.toLowerCase().includes(needle),
  );
}

/**
 * The composer's folder picker: recent folders, then "work in another folder" and "work
 * without a folder". Each folder except the current one can be removed from CoWork after
 * an inline confirmation; removing deletes its sessions and memory, never its files.
 *
 * It renders in a portal so no scrolling or clipped container can cut it off, opens above
 * its button (or below when that has more room), and caps its height to the space it has so
 * only the folder list scrolls. Every folder is listed; long lists get a filter field.
 */
export function WorkspaceDropdownMenu({
  workspaces,
  currentWorkspaceId,
  onSelect,
  onSelectNewFolder,
  onUseTempWorkspace,
  onRemove,
  onClose,
}: {
  workspaces: Workspace[];
  currentWorkspaceId?: string;
  onSelect: (workspace: Workspace) => void;
  onSelectNewFolder: () => void;
  /** Present when the user may switch to scratch work. */
  onUseTempWorkspace?: () => void;
  /** Resolves once the folder is gone; throws with a message to show otherwise. */
  onRemove?: (workspace: Workspace) => Promise<void>;
  /** Close the menu (Escape). */
  onClose?: () => void;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [fit, setFit] = useState<MenuFit | null>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const isPlaced = fit !== null;
  const showFilter = workspaces.length > FILTER_THRESHOLD;
  const shown = showFilter ? filterWorkspaces(workspaces, query) : workspaces;

  const updateFade = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const top = list.scrollTop > 1;
    const bottom = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
    setFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  }, []);

  // Fit the menu to the space around its button before it paints.
  const measure = useCallback(() => {
    const menu = menuRef.current;
    const trigger = anchorRef.current?.parentElement;
    if (!menu || !trigger) return;
    const bounds = viewportBounds();
    const anchor = trigger.getBoundingClientRect();
    const list = listRef.current;
    // Natural height: the chrome around the list plus the list at its CSS cap.
    const listCap = list ? parseFloat(getComputedStyle(list).maxHeight) || Infinity : 0;
    const natural = list
      ? menu.offsetHeight - list.clientHeight + Math.min(list.scrollHeight, listCap)
      : menu.offsetHeight;
    const above = anchor.top - TRIGGER_GAP - bounds.top;
    const below = bounds.bottom - anchor.bottom - TRIGGER_GAP;
    const placement = natural <= above || above >= below ? "up" : "down";
    const room = Math.floor(placement === "up" ? above : below);
    const maxWidth = Math.max(0, Math.floor(bounds.right - bounds.left));
    const width = Math.min(menu.offsetWidth, maxWidth);
    // Left-aligned with the button, slid back inside the window when it would cross an edge.
    const left = Math.round(Math.max(bounds.left, Math.min(anchor.left, bounds.right - width)));
    const next: MenuFit = {
      placement,
      offset: Math.round(
        placement === "up"
          ? window.innerHeight - (anchor.top - TRIGGER_GAP)
          : anchor.bottom + TRIGGER_GAP,
      ),
      left,
      maxHeight: natural > room ? Math.max(MIN_MENU_HEIGHT, room) : undefined,
      maxWidth: menu.offsetWidth > maxWidth ? maxWidth : undefined,
    };
    setFit((current) =>
      current &&
      current.placement === next.placement &&
      current.offset === next.offset &&
      current.left === next.left &&
      current.maxHeight === next.maxHeight &&
      current.maxWidth === next.maxWidth
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    updateFade();
  }, [measure, updateFade, shown.length, confirmingId]);

  // Follow the button when the window resizes or anything around it scrolls.
  useEffect(() => {
    const onReflow = (event: Event) => {
      if (event.type === "scroll" && menuRef.current?.contains(event.target as Node)) return;
      measure();
      updateFade();
    };
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [measure, updateFade]);

  // Open on the current folder, wherever it sits in the list.
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".workspace-dropdown-item.active")
      ?.scrollIntoView({ block: "nearest" });
    updateFade();
  }, [updateFade]);

  // The menu is hidden until its first measurement, and a hidden field can't take focus,
  // so focus the filter once it is placed.
  useEffect(() => {
    if (isPlaced) filterRef.current?.focus();
  }, [isPlaced]);

  // Keep the inline remove confirmation in view.
  useEffect(() => {
    if (!confirmingId) return;
    listRef.current
      ?.querySelector<HTMLElement>(".workspace-dropdown-confirm")
      ?.scrollIntoView({ block: "nearest" });
  }, [confirmingId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmingId) {
        if (removingId) return;
        setConfirmingId(null);
        setError(null);
        return;
      }
      onClose?.();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [confirmingId, removingId, onClose]);

  // Until the first measurement (before paint) the menu sits hidden at the window origin.
  const menuStyle: CSSProperties = fit
    ? {
        left: fit.left,
        ...(fit.placement === "up" ? { bottom: fit.offset } : { top: fit.offset }),
        ...(fit.maxHeight !== undefined ? { maxHeight: fit.maxHeight } : {}),
        ...(fit.maxWidth !== undefined ? { maxWidth: fit.maxWidth, minWidth: 0 } : {}),
      }
    : { left: 0, top: 0, visibility: "hidden" };

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
    <>
      <span ref={anchorRef} hidden />
      {inBodyPortal(
        <div
          ref={menuRef}
          className={`workspace-dropdown workspace-dropdown-floating workspace-dropdown-${fit?.placement ?? "up"}`}
          style={menuStyle}
        >
          {workspaces.length > 0 && (
            <>
              {showFilter ? (
                <div className="workspace-dropdown-header workspace-dropdown-filter">
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && shown[0]) {
                        event.preventDefault();
                        onSelect(shown[0]);
                      }
                    }}
                    placeholder={`Filter ${workspaces.length} folders`}
                    aria-label="Filter folders"
                    ref={filterRef}
                  />
                </div>
              ) : (
                <div className="workspace-dropdown-header">Recent Folders</div>
              )}
              <div
                ref={listRef}
                className={`workspace-dropdown-list${fade.top ? " fade-top" : ""}${fade.bottom ? " fade-bottom" : ""}`}
                onScroll={updateFade}
              >
                {shown.length === 0 && (
                  <div className="workspace-dropdown-empty">No folders match “{query.trim()}”</div>
                )}
                {shown.map((w) => {
                  const active = currentWorkspaceId === w.id;
                  if (confirmingId === w.id) {
                    return (
                      <div key={w.id} className="workspace-dropdown-confirm" role="group">
                        <div className="workspace-dropdown-confirm-text">
                          <strong>Remove “{w.name}” from CoWork?</strong>
                          <span>
                            Its sessions and memory are deleted. Files in the folder stay.
                          </span>
                          {error && (
                            <span className="workspace-dropdown-confirm-error">{error}</span>
                          )}
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
        </div>,
      )}
    </>
  );
}
