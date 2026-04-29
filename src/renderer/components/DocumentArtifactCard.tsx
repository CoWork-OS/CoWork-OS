import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, FolderOpen } from "lucide-react";
import {
  canPreviewDocumentInApp,
  getDocumentFileExtension,
  getDocumentFormatLabel,
} from "../../shared/document-formats";

type DocumentArtifactCardProps = {
  filePath: string;
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
};

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function getDocumentIconLabel(filePath: string): string {
  const extension = getDocumentFileExtension(filePath);
  if (extension === ".pages") return "P";
  if (extension === ".rtf") return "R";
  if (extension === ".odt" || extension === ".ott") return "O";
  return "W";
}

export function DocumentArtifactCard({
  filePath,
  workspacePath,
  onOpenViewer,
}: DocumentArtifactCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileName = getFileName(filePath);
  const formatLabel = getDocumentFormatLabel(filePath);
  const canOpenInViewer = canPreviewDocumentInApp(filePath);
  const iconLabel = getDocumentIconLabel(filePath);

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
      const menuWidth = 250;
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
    <div className="document-artifact-card">
      <div className="document-artifact-icon" aria-hidden="true">
        <span>{iconLabel}</span>
      </div>
      <button
        type="button"
        className="document-artifact-file"
        onClick={handleOpenViewer}
        title={fileName}
      >
        <span className="document-artifact-name">{fileName}</span>
        <span className="document-artifact-meta">Document · {formatLabel}</span>
      </button>
      <div className="document-artifact-actions" ref={actionsRef}>
        <button
          type="button"
          className="document-artifact-open"
          onClick={handleOpenViewer}
          title="Open document preview"
        >
          <ArrowUpRight size={18} strokeWidth={2} />
          <span>Open</span>
        </button>
        <button
          type="button"
          className="document-artifact-menu-btn"
          onClick={() => setMenuOpen((current) => !current)}
          title="Open options"
          aria-label="Open options"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <svg
            className="document-artifact-chevron-down"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <path d="M3.5 5.25L7 8.75L10.5 5.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {menuOpen &&
        menuPosition &&
        createPortal(
          <div
            className="document-artifact-menu"
            ref={menuRef}
            role="menu"
            style={{ position: "fixed", top: menuPosition.top, left: menuPosition.left, right: "auto" }}
          >
            <button type="button" role="menuitem" onClick={() => handleOpenWithApp("Microsoft Word")}>
              <span className="document-artifact-app-icon word">W</span>
              Microsoft Word
            </button>
            <button type="button" role="menuitem" onClick={() => handleOpenWithApp("Pages")}>
              <span className="document-artifact-app-icon pages">P</span>
              Pages
            </button>
            <button type="button" role="menuitem" onClick={() => handleOpenWithApp("TextEdit")}>
              <span className="document-artifact-app-icon textedit">T</span>
              TextEdit
            </button>
            <div className="document-artifact-menu-separator" />
            <button type="button" role="menuitem" onClick={handleShowInFinder}>
              <span className="document-artifact-app-icon finder">
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
