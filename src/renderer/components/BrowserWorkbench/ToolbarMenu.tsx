import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Camera,
  Check,
  Ellipsis,
  ExternalLink,
  ImagePlus,
  Maximize,
  ScanLine,
} from "lucide-react";

export type ToolbarViewportOption = {
  label: string;
  width: number;
  height: number;
  icon: LucideIcon;
};

/**
 * The toolbar's "More" menu: the actions a browser keeps out of sight until
 * asked for (screenshots, page size, developer views, open elsewhere).
 */
export function ToolbarMenu({
  hasPage,
  viewports,
  activeViewport,
  snapshotOverlay,
  diagnosticsOpen,
  onAnnotateScreenshot,
  onScreenshot,
  onOpenExternal,
  onViewport,
  onToggleSnapshotOverlay,
  onToggleDiagnostics,
}: {
  hasPage: boolean;
  viewports: ToolbarViewportOption[];
  /** Label of the forced page size, or null for the automatic size. */
  activeViewport: string | null;
  snapshotOverlay: boolean;
  diagnosticsOpen: boolean;
  onAnnotateScreenshot: () => void;
  onScreenshot: () => void;
  onOpenExternal: () => void;
  /** null returns to the automatic size. */
  onViewport: (viewport: ToolbarViewportOption | null) => void;
  onToggleSnapshotOverlay: () => void;
  onToggleDiagnostics: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const item = (
    label: string,
    Icon: LucideIcon,
    action: () => void,
    options: { disabled?: boolean; checked?: boolean } = {},
  ) => (
    <button
      type="button"
      role={options.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={options.checked}
      disabled={options.disabled}
      onClick={run(action)}
    >
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
      {options.checked && (
        <Check className="browser-workbench-menu-check" size={14} aria-hidden="true" />
      )}
    </button>
  );

  return (
    <div className="browser-workbench-toolbar-menu" ref={rootRef}>
      <button
        type="button"
        className={`browser-workbench-nav-btn ${open ? "is-active" : ""}`}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Ellipsis size={17} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div className="browser-workbench-tab-menu browser-workbench-toolbar-popover" role="menu">
          {item("Annotate screenshot", ImagePlus, onAnnotateScreenshot, { disabled: !hasPage })}
          {item("Save screenshot", Camera, onScreenshot, { disabled: !hasPage })}
          {item("Open in system browser", ExternalLink, onOpenExternal, { disabled: !hasPage })}
          <div className="browser-workbench-tab-menu-separator" />
          <div className="browser-workbench-menu-heading">Page size</div>
          {item("Fit to panel", Maximize, () => onViewport(null), {
            checked: activeViewport === null,
          })}
          {viewports.map((viewport) => (
            <span key={viewport.label} className="browser-workbench-menu-row">
              {item(viewport.label, viewport.icon, () => onViewport(viewport), {
                checked: activeViewport === viewport.label,
              })}
              <span className="browser-workbench-menu-hint">
                {viewport.width}×{viewport.height}
              </span>
            </span>
          ))}
          <div className="browser-workbench-tab-menu-separator" />
          {item("Element outlines", ScanLine, onToggleSnapshotOverlay, {
            checked: snapshotOverlay,
          })}
          {item("Diagnostics", Activity, onToggleDiagnostics, { checked: diagnosticsOpen })}
        </div>
      )}
    </div>
  );
}
