import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { BOT_MASCOT_IDS, botMascotIcon, resolveBotMascot } from "../../../shared/bot-mascots";
import { botIconLabel } from "../../utils/twin-icons";
import { BotMascot } from "./BotMascot";
import { MASCOT_CATALOG } from "./mascot-catalog";
import type { MascotExpression } from "./mascot-eyes";
import "./bot-icon-picker.css";

export interface BotIconBadgeProps {
  icon: string;
  size: number;
  expression?: MascotExpression;
  className?: string;
}

/** A bot's icon as it appears on its avatar: its character (see `resolveBotMascot`). */
export function BotIconBadge({ icon, size, expression, className }: BotIconBadgeProps) {
  return (
    <BotMascot
      mascot={resolveBotMascot(icon)}
      size={size}
      expression={expression}
      className={className}
    />
  );
}

export interface BotIconPickerProps {
  value: string;
  onChange: (icon: string) => void;
  "aria-labelledby"?: string;
  className?: string;
}

/**
 * Every character a bot can use. A bot saved with a simple icon or emoji shows
 * the character it is drawn as, selected.
 */
export function BotIconPicker({
  value,
  onChange,
  "aria-labelledby": labelledBy,
  className,
}: BotIconPickerProps) {
  const selectedMascot = resolveBotMascot(value);
  return (
    <div
      className={["bot-icon-picker", className].filter(Boolean).join(" ")}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : "Character"}
    >
      {BOT_MASCOT_IDS.map((id) => {
        const selected = selectedMascot === id;
        const label = MASCOT_CATALOG[id].label;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            className={`bot-icon-picker-tile${selected ? " selected" : ""}`}
            onClick={() => onChange(botMascotIcon(id))}
          >
            {/* The chosen character smiles back. */}
            <BotMascot mascot={id} size={30} expression={selected ? "happy" : "idle"} />
          </button>
        );
      })}
    </div>
  );
}

export interface BotIconSelectProps {
  value: string;
  onChange: (icon: string) => void;
  /** Controlled so a host dialog can close the menu before itself on Escape. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labelId?: string;
  className?: string;
}

/** The visible area a popover inside `element` can use: its nearest clipping ancestor, or the window. */
function clipBounds(element: HTMLElement): { top: number; bottom: number } {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowY)) {
      const rect = node.getBoundingClientRect();
      return { top: Math.max(rect.top, 0), bottom: Math.min(rect.bottom, window.innerHeight) };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

/** A trigger showing the current icon that opens the picker in a popover. */
export function BotIconSelect({
  value,
  onChange,
  open,
  onOpenChange,
  labelId,
  className,
}: BotIconSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [opensUp, setOpensUp] = useState(false);

  // Open upwards when the picker would run past the bottom of its dialog and
  // there is more room above the trigger.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const menu = menuRef.current;
    if (!open || !root || !menu) return;
    const trigger = root.getBoundingClientRect();
    const bounds = clipBounds(root);
    const below = bounds.bottom - trigger.bottom;
    const above = trigger.top - bounds.top;
    setOpensUp(below < menu.offsetHeight + 8 && above > below);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    // Capture phase: the dialogs hosting this stop mousedown from bubbling.
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className={["bot-icon-select", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="bot-icon-select-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-labelledby={labelId}
        onClick={() => onOpenChange(!open)}
      >
        <BotIconBadge icon={value} size={24} />
        <span className="bot-icon-select-name">{botIconLabel(value)}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={`bot-icon-select-menu${opensUp ? " bot-icon-select-menu-up" : ""}`}
        >
          <BotIconPicker
            value={value}
            aria-labelledby={labelId}
            onChange={(icon) => {
              onChange(icon);
              onOpenChange(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
