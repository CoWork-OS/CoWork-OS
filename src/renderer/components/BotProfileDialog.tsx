import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, ChevronDown, LoaderCircle, Save, Trash2, X } from "lucide-react";
import type { AgentRoleData } from "../../electron/preload";
import {
  BOT_PROFILE_DESCRIPTION_MAX_LENGTH,
  BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH,
  normalizeBotProfileText,
} from "../utils/bot-profile";
import { TWIN_ICON_KEYS, resolveTwinIcon, type TwinIconKey } from "../utils/twin-icons";
import { BOT_COLOR_PRESETS, DEFAULT_BOT_COLOR } from "../utils/bot-colors";
import "./BotProfileDialog.css";

export const BOT_PROFILE_UPDATED_EVENT = "cowork:bot-profile-updated";
export const BOT_PROFILE_DELETED_EVENT = "cowork:bot-profile-deleted";

export interface BotProfileDialogProps {
  botId: string;
  onClose: () => void;
  onSaved?: (role: AgentRoleData) => void | Promise<void>;
  onDeleted?: (botId: string) => void | Promise<void>;
}

export function BotProfileDialog({ botId, onClose, onSaved, onDeleted }: BotProfileDialogProps) {
  const [role, setRole] = useState<AgentRoleData | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_BOT_COLOR);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iconMenuOpen, setIconMenuOpen] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const iconFieldRef = useRef<HTMLDivElement>(null);

  const requestClose = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);

  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      returnFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await window.electronAPI.getAgentRole(botId);
        if (cancelled) return;
        if (!loaded) throw new Error("Bot could not be found.");
        setRole(loaded);
        setDisplayName(loaded.displayName || "");
        setDescription(loaded.description || "");
        setSystemPrompt(loaded.systemPrompt || "");
        setIcon(
          loaded.icon && TWIN_ICON_KEYS.includes(loaded.icon as TwinIconKey) ? loaded.icon : "Bot",
        );
        setColor(loaded.color || DEFAULT_BOT_COLOR);
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Could not load this bot.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId]);

  useEffect(() => {
    if (!iconMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!iconFieldRef.current?.contains(event.target as Node)) setIconMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [iconMenuOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button, input, textarea, select, [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (iconMenuOpen) {
          setIconMenuOpen(false);
          return;
        }
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [iconMenuOpen, loading, requestClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!role || !displayName.trim()) {
      setError("Enter a name for this bot.");
      return;
    }
    if (!window.electronAPI?.updateAgentRole) {
      setError("Bot editing is unavailable in this session.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await window.electronAPI.updateAgentRole({
        id: role.id,
        displayName: normalizeBotProfileText(displayName),
        description: normalizeBotProfileText(description),
        systemPrompt: normalizeBotProfileText(systemPrompt),
        icon,
        color,
      });
      if (!updated) throw new Error("Could not save this bot.");
      await onSaved?.(updated);
      window.dispatchEvent(new CustomEvent(BOT_PROFILE_UPDATED_EVENT, { detail: updated }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this bot.");
    } finally {
      setSaving(false);
    }
  };

  const deleteBot = async () => {
    if (!role || role.isSystem || saving) return;
    if (!window.electronAPI?.deleteAgentRole) {
      setError("Bot deletion is unavailable in this session.");
      return;
    }
    if (
      !window.confirm(
        `Delete ${displayName.trim() || "this bot"}? Existing conversations and history will be kept.`,
      )
    ) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const deleted = await window.electronAPI.deleteAgentRole(role.id);
      if (!deleted) throw new Error("Could not delete this bot.");
      await onDeleted?.(role.id);
      window.dispatchEvent(new CustomEvent(BOT_PROFILE_DELETED_EVENT, { detail: role.id }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this bot.");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="bot-profile-dialog-backdrop" role="presentation" onMouseDown={requestClose}>
      <form
        ref={dialogRef}
        className="bot-profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-profile-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="bot-profile-dialog-header">
          <div>
            <span className="bot-profile-eyebrow">Bot profile</span>
            <h2 id="bot-profile-title">Edit bot</h2>
          </div>
          <button type="button" onClick={requestClose} disabled={saving} aria-label="Close">
            <X size={17} />
          </button>
        </header>
        <div className="bot-profile-dialog-content">
          {loading ? (
            <div className="bot-profile-state" aria-busy="true">
              <LoaderCircle className="spinning" size={20} /> Loading bot...
            </div>
          ) : (
            <>
              <p className="bot-profile-note">
                Changes apply when this bot starts its next run. An already running run may retain
                its current context.
              </p>
              <label>
                Name
                <input
                  autoComplete="off"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  maxLength={80}
                />
              </label>
              <label>
                Description
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={BOT_PROFILE_DESCRIPTION_MAX_LENGTH}
                  rows={5}
                />
                <small>Shown in the bot context. Line breaks are preserved.</small>
              </label>
              <label>
                Instructions
                <textarea
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  maxLength={BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH}
                  rows={5}
                />
                <small>Instructions used when this bot starts its next run.</small>
              </label>
              <div className="bot-profile-appearance">
                {/* A native <select> can only render text, so this is a custom
                    listbox that shows each icon beside its name — and the chosen
                    icon on the trigger. */}
                <div
                  className="bot-profile-field bot-profile-icon-field"
                  ref={iconFieldRef}
                  style={{ "--bot-profile-color": color } as CSSProperties}
                >
                  <span className="bot-profile-field-label" id="bot-profile-icon-label">
                    Icon
                  </span>
                  <button
                    type="button"
                    className="bot-profile-icon-trigger"
                    aria-haspopup="listbox"
                    aria-expanded={iconMenuOpen}
                    aria-labelledby="bot-profile-icon-label"
                    onClick={() => setIconMenuOpen((open) => !open)}
                  >
                    <span className="bot-profile-icon-swatch" aria-hidden="true">
                      {(() => {
                        const SelectedIcon = resolveTwinIcon(icon);
                        return <SelectedIcon size={16} />;
                      })()}
                    </span>
                    <span className="bot-profile-icon-trigger-name">{icon}</span>
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                  {iconMenuOpen && (
                    <ul
                      className="bot-profile-icon-menu"
                      role="listbox"
                      aria-labelledby="bot-profile-icon-label"
                    >
                      {TWIN_ICON_KEYS.map((iconKey) => {
                        const Icon = resolveTwinIcon(iconKey);
                        const selected = icon === iconKey;
                        return (
                          <li key={iconKey}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              className={`bot-profile-icon-menu-item${selected ? " selected" : ""}`}
                              onClick={() => {
                                setIcon(iconKey);
                                setIconMenuOpen(false);
                              }}
                            >
                              <Icon size={16} aria-hidden="true" />
                              <span>{iconKey}</span>
                              {selected ? <Check size={14} aria-hidden="true" /> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                <div className="bot-profile-field">
                  <span className="bot-profile-field-label" id="bot-profile-color-label">
                    Color
                  </span>
                  <div
                    className="bot-profile-color-row"
                    role="radiogroup"
                    aria-labelledby="bot-profile-color-label"
                  >
                    {BOT_COLOR_PRESETS.map((preset) => {
                      const selected = color.toLowerCase() === preset.value.toLowerCase();
                      return (
                        <button
                          key={preset.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={preset.label}
                          title={preset.label}
                          className={`bot-profile-color-swatch${selected ? " selected" : ""}`}
                          style={{ "--bot-profile-swatch": preset.value } as CSSProperties}
                          onClick={() => setColor(preset.value)}
                        />
                      );
                    })}
                    {/* Kept so an existing bot with a colour outside the palette
                        can still be edited rather than forced onto a preset. */}
                    <input
                      type="color"
                      className="bot-profile-color-custom"
                      aria-label="Custom color"
                      title="Custom color"
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
          {error && (
            <div className="bot-profile-error" role="alert">
              <AlertCircle size={14} />
              {error}
            </div>
          )}
        </div>
        <footer className="bot-profile-actions">
          {role && !role.isSystem && (
            <button
              type="button"
              className="bot-profile-delete-button"
              onClick={() => void deleteBot()}
              disabled={loading || saving}
            >
              <Trash2 size={14} />
              {saving ? "Deleting..." : "Delete bot"}
            </button>
          )}
          <button type="button" onClick={requestClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" disabled={loading || saving || !role}>
            <Save size={14} />
            {saving ? "Saving..." : "Save changes"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
