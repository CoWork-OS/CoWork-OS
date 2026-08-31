import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, FolderOpen } from "lucide-react";
import {
  canPreviewPresentationInApp,
  getPresentationFormatLabel,
} from "../../shared/presentation-formats";

type PresentationArtifactCardProps = {
  filePath: string;
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
};

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

export function PresentationArtifactCard({
  filePath,
  workspacePath,
  onOpenViewer,
}: PresentationArtifactCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileName = getFileName(filePath);
  const formatLabel = getPresentationFormatLabel(filePath);
  const canOpenInViewer = canPreviewPresentationInApp(filePath);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (actionsRef.current?.contains(event.target as Node)) return;
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) {
      setMenuPosition(null);
      return;
    }
    const updateMenuPosition = () => {
      const rect = actionsRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = 270;
      const viewportPadding = 12;
      const left = Math.min(
        Math.max(viewportPadding, rect.right - menuWidth),
        window.innerWidth - menuWidth - viewportPadding,
      );
      setMenuPosition({ top: rect.bottom + 8, left });
    };
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  const handleOpenViewer = () => {
    setMenuOpen(false);
    if (canOpenInViewer && onOpenViewer) {
      onOpenViewer(filePath);
      return;
    }
    void window.electronAPI.openFile(filePath, workspacePath);
  };

  const handleOpenWithApp = (appName: string) => {
    setMenuOpen(false);
    void window.electronAPI
      .openFileWithApp(filePath, workspacePath, appName)
      .catch(() => window.electronAPI.openFile(filePath, workspacePath));
  };

  const handleShowInFinder = () => {
    setMenuOpen(false);
    void window.electronAPI.showInFinder(filePath, workspacePath);
  };

  return (
    <div className="presentation-artifact-card">
      <div className="presentation-artifact-icon" aria-hidden="true">
        <span>P</span>
      </div>
      <button
        type="button"
        className="presentation-artifact-file"
        onClick={handleOpenViewer}
        title={fileName}
      >
        <span className="presentation-artifact-name">{fileName}</span>
        <span className="presentation-artifact-meta">Presentation · {formatLabel}</span>
      </button>
      <div className="presentation-artifact-actions" ref={actionsRef}>
        <button
          type="button"
          className="presentation-artifact-open"
          onClick={handleOpenViewer}
          title="Open presentation preview"
        >
          <ArrowUpRight size={18} strokeWidth={2} />
          <span>Open</span>
        </button>
        <button
          type="button"
          className="presentation-artifact-menu-btn"
          onClick={() => setMenuOpen((current) => !current)}
          title="Open options"
          aria-label="Open options"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <svg
            className="presentation-artifact-chevron-down"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3.5 5.25L7 8.75L10.5 5.25"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {menuOpen &&
        menuPosition &&
        createPortal(
          <div
            className="presentation-artifact-menu"
            ref={menuRef}
            role="menu"
            style={{
              position: "fixed",
              top: menuPosition.top,
              left: menuPosition.left,
              right: "auto",
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => handleOpenWithApp("Microsoft PowerPoint")}
            >
              <span className="presentation-artifact-app-icon powerpoint">P</span>
              Microsoft PowerPoint
            </button>
            <button type="button" role="menuitem" onClick={() => handleOpenWithApp("Keynote")}>
              <span className="presentation-artifact-app-icon keynote">K</span>
              Keynote
            </button>
            <button type="button" role="menuitem" onClick={() => handleOpenWithApp("LibreOffice")}>
              <span className="presentation-artifact-app-icon libreoffice">L</span>
              LibreOffice
            </button>
            <button type="button" role="menuitem" onClick={() => handleOpenWithApp("Preview")}>
              <span className="presentation-artifact-app-icon preview">V</span>
              Preview
            </button>
            <div className="presentation-artifact-menu-separator" />
            <button type="button" role="menuitem" onClick={handleShowInFinder}>
              <span className="presentation-artifact-app-icon finder">
                <FolderOpen size={14} />
              </span>
              Open in folder
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
