import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import type { BrowserColorScheme } from "../../../shared/browser-settings";
import {
  Activity,
  Camera,
  Check,
  Ellipsis,
  ExternalLink,
  ImagePlus,
  Maximize,
  Moon,
  ScanLine,
  Sun,
  SunMoon,
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
  colorScheme,
  onColorScheme,
  viewports,
  activeViewport,
  snapshotOverlay,
  diagnosticsOpen,
  nativeMenu = false,
  onAnnotateScreenshot,
  onScreenshot,
  onOpenExternal,
  onViewport,
  onToggleSnapshotOverlay,
  onToggleDiagnostics,
}: {
  hasPage: boolean;
  /** The saved browser choice; null follows the app's theme. */
  colorScheme: BrowserColorScheme | null;
  /** null clears the saved choice so pages follow the app's theme again. */
  onColorScheme: (colorScheme: BrowserColorScheme | null) => void;
  viewports: ToolbarViewportOption[];
  /** Label of the forced page size, or null for the automatic size. */
  activeViewport: string | null;
  snapshotOverlay: boolean;
  diagnosticsOpen: boolean;
  /** Native pages stay live underneath an OS popup; DOM menus require a screenshot handoff. */
  nativeMenu?: boolean;
  onAnnotateScreenshot: () => void;
  onScreenshot: () => void;
  onOpenExternal: () => void;
  /** null returns to the automatic size. */
  onViewport: (viewport: ToolbarViewportOption | null) => void;
  onToggleSnapshotOverlay: () => void;
  onToggleDiagnostics: () => void;
} & {
  /** Appearance controls are supplied by clients with browser theme settings. */
  colorScheme?: "light" | "dark" | null;
  onColorScheme?: (colorScheme: "light" | "dark" | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const useNativeMenu = nativeMenu && Boolean(window.electronAPI?.popupBrowserToolbarMenu);

  useEffect(() => {
    if (!open || useNativeMenu) return;
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
  }, [open, useNativeMenu]);

  const toggleMenu = async () => {
    if (!useNativeMenu) {
      setOpen((current) => !current);
      return;
    }
    if (open) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setOpen(true);
    try {
      const action = await window.electronAPI.popupBrowserToolbarMenu({
        x: rect.left,
        y: rect.bottom,
        hasPage,
        viewports: viewports.map(({ label, width, height }) => ({ label, width, height })),
        activeViewport,
        snapshotOverlay,
        diagnosticsOpen,
        colorScheme: typeof onColorScheme === "function" ? (colorScheme ?? null) : undefined,
      });
      switch (action) {
        case "appearance:app":
          onColorScheme?.(null);
          break;
        case "appearance:light":
          onColorScheme?.("light");
          break;
        case "appearance:dark":
          onColorScheme?.("dark");
          break;
        case "annotate":
          onAnnotateScreenshot();
          break;
        case "screenshot":
          onScreenshot();
          break;
        case "external":
          onOpenExternal();
          break;
        case "fit":
          onViewport(null);
          break;
        case "outlines":
          onToggleSnapshotOverlay();
          break;
        case "diagnostics":
          onToggleDiagnostics();
          break;
        default: {
          if (action?.startsWith("viewport:")) {
            const viewport = viewports[Number(action.slice("viewport:".length))];
            if (viewport) onViewport(viewport);
          }
        }
      }
    } catch {
      // A closing window can cancel the popup IPC; leave the live page intact.
    } finally {
      setOpen(false);
    }
  };

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
        onClick={() => void toggleMenu()}
      >
        <Ellipsis size={17} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && !useNativeMenu && (
        <div className="browser-workbench-tab-menu browser-workbench-toolbar-popover" role="menu">
          {item("Annotate screenshot", ImagePlus, onAnnotateScreenshot, { disabled: !hasPage })}
          {item("Save screenshot", Camera, onScreenshot, { disabled: !hasPage })}
          {item("Open in system browser", ExternalLink, onOpenExternal, { disabled: !hasPage })}
          <div className="browser-workbench-tab-menu-separator" />
          <div className="browser-workbench-menu-heading">Appearance</div>
          {item("Match app", SunMoon, () => onColorScheme(null), {
            checked: colorScheme === null,
          })}
          {item("Light", Sun, () => onColorScheme("light"), {
            checked: colorScheme === "light",
          })}
          {item("Dark", Moon, () => onColorScheme("dark"), {
            checked: colorScheme === "dark",
          })}
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
