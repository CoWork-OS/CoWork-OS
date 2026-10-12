import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, FolderOpen, PanelRight } from "lucide-react";
import { getSidePanelViewerKind } from "../utils/open-file-in-panel";
import "./file-action-menu.css";

type FileActionMenuState = { path: string; x: number; y: number };

const MENU_VIEWPORT_PADDING = 8;

function FileActionMenu({
  state,
  workspacePath,
  onOpenInPanel,
  onClose,
}: {
  state: FileActionMenuState;
  workspacePath?: string;
  onOpenInPanel?: (path: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ top: state.y, left: state.x });
  const { path } = state;
  const opensInPanel = Boolean(getSidePanelViewerKind(path));

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(
        MENU_VIEWPORT_PADDING,
        Math.min(state.x, window.innerWidth - rect.width - MENU_VIEWPORT_PADDING),
      ),
      top: Math.max(
        MENU_VIEWPORT_PADDING,
        state.y + rect.height + MENU_VIEWPORT_PADDING > window.innerHeight
          ? state.y - rect.height
          : state.y,
      ),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const run = (action: () => unknown) => {
    onClose();
    void Promise.resolve()
      .then(action)
      .catch((error) => console.error("File action failed:", error));
  };

  return createPortal(
    <div
      ref={menuRef}
      className="file-action-menu"
      role="menu"
      aria-label={`Actions for ${path.split(/[\\/]/).pop() || path}`}
      style={{ top: position.top, left: position.left }}
    >
      {onOpenInPanel && (
        <button type="button" role="menuitem" onClick={() => run(() => onOpenInPanel(path))}>
          <PanelRight size={14} aria-hidden="true" />
          {opensInPanel ? "Open in side panel" : "Preview"}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => run(() => window.electronAPI.openFile(path, workspacePath))}
      >
        <ExternalLink size={14} aria-hidden="true" />
        Open with default app
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => run(() => window.electronAPI.showInFinder(path, workspacePath))}
      >
        <FolderOpen size={14} aria-hidden="true" />
        Show in Finder
      </button>
      <div className="file-action-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        onClick={() => run(() => navigator.clipboard.writeText(path))}
      >
        <Copy size={14} aria-hidden="true" />
        Copy path
      </button>
    </div>,
    document.body,
  );
}

/**
 * Right-click / "…" menu for a file reference: open it in CoWork, with the default app,
 * reveal it in Finder, or copy its path. Render `menu` once next to the triggers.
 */
export function useFileActionMenu(options: {
  workspacePath?: string;
  onOpenInPanel?: (path: string) => void;
}): {
  openFileActionMenu: (
    event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
    path: string,
  ) => void;
  openFileActionMenuAt: (anchor: HTMLElement, path: string) => void;
  menu: ReactNode;
} {
  const [state, setState] = useState<FileActionMenuState | null>(null);
  const close = useCallback(() => setState(null), []);
  const openFileActionMenu = useCallback(
    (
      event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
      path: string,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      setState({ path, x: event.clientX, y: event.clientY });
    },
    [],
  );
  const openFileActionMenuAt = useCallback((anchor: HTMLElement, path: string) => {
    const rect = anchor.getBoundingClientRect();
    setState({ path, x: rect.left, y: rect.bottom + 4 });
  }, []);
  const menu = state ? (
    <FileActionMenu
      state={state}
      workspacePath={options.workspacePath}
      onOpenInPanel={options.onOpenInPanel}
      onClose={close}
    />
  ) : null;
  return { openFileActionMenu, openFileActionMenuAt, menu };
}
