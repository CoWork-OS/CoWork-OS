import { useEffect, useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import "./title-bar-more-menu.css";

export interface TitleBarMoreMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  /** Shown as a checked toggle (e.g. the terminal while it is open). */
  active?: boolean;
}

/**
 * The title bar's secondary actions (browser, terminal, theme, density) behind
 * one "More" button, so the bar keeps a single icon there instead of a row.
 */
export function TitleBarMoreMenu({ items }: { items: TitleBarMoreMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  const moveFocus = (from: number, delta: number) => {
    const next = (from + delta + items.length) % items.length;
    itemRefs.current[next]?.focus();
  };

  return (
    <div className="title-bar-more" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`title-bar-btn title-bar-more-btn${open ? " active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Ellipsis size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div className="title-bar-more-menu" role="menu" aria-label="More">
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role={item.active === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.active === undefined ? undefined : item.active}
              className={`title-bar-more-item${item.active ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveFocus(index, 1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveFocus(index, -1);
                }
              }}
            >
              <span className="title-bar-more-item-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="title-bar-more-item-label">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
