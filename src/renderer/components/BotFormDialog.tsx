import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, LoaderCircle, X } from "lucide-react";
import { resolveBotMascot } from "../../shared/bot-mascots";
import {
  BOT_PROFILE_DESCRIPTION_MAX_LENGTH,
  BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH,
} from "../utils/bot-profile";
import { BotMascot } from "./bot-mascot/BotMascot";
import { BotIconPicker } from "./bot-mascot/BotIconPicker";
import "./bot-form.css";

export interface BotFormValues {
  displayName: string;
  description: string;
  systemPrompt: string;
  /** `mascot:<id>`; older icon values show as the character they map to. */
  icon: string;
}

export interface BotFormDialogProps {
  title: string;
  subtitle: string;
  values: BotFormValues;
  onChange: (values: BotFormValues) => void;
  onSubmit: () => void;
  onClose: () => void;
  submitLabel: string;
  busyLabel: string;
  submitIcon?: ReactNode;
  /** Shown left of the actions, e.g. when changes take effect. */
  footnote?: string;
  loading?: boolean;
  /** The bot could not be loaded: show only the error, with nothing to edit or save. */
  unavailable?: boolean;
  busy?: boolean;
  error?: string | null;
  /** Offers Delete bot at the start of the action bar. */
  onDelete?: () => void;
}

/** The create and edit dialog for a bot: its character, name, purpose and instructions. */
export function BotFormDialog({
  title,
  subtitle,
  values,
  onChange,
  onSubmit,
  onClose,
  submitLabel,
  busyLabel,
  submitIcon,
  footnote,
  loading = false,
  unavailable = false,
  busy = false,
  error = null,
  onDelete,
}: BotFormDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const requestClose = () => {
    if (!busy) onClose();
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  // Return focus to whatever opened the dialog.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener?.focus();
  }, []);

  // Focus the name field once loaded.
  useEffect(() => {
    if (loading) return;
    dialogRef.current?.querySelector<HTMLInputElement>(".bot-form-name")?.focus();
  }, [loading]);

  // Close on Escape and keep Tab inside the dialog, including while it loads.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button, input, textarea, select, [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
    // Until the fields load, hold focus inside the dialog rather than on the page behind it.
    if (!dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>(".bot-form-icon-button")?.focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestCloseRef.current();
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
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && !loading && !unavailable) onSubmit();
  };
  const set = (patch: Partial<BotFormValues>) => onChange({ ...values, ...patch });

  return createPortal(
    <div className="bot-form-backdrop" role="presentation" onMouseDown={requestClose}>
      <form
        ref={dialogRef}
        className="bot-form-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-form-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="bot-form-header">
          <BotMascot mascot={resolveBotMascot(values.icon)} size={52} expression="happy" />
          <div className="bot-form-heading">
            <h2 id="bot-form-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            type="button"
            className="bot-form-icon-button"
            onClick={requestClose}
            disabled={busy}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="bot-form-content">
          {loading ? (
            <div className="bot-form-state" aria-busy="true">
              <LoaderCircle className="spinning" size={18} />
              Loading bot…
            </div>
          ) : unavailable ? null : (
            <>
              <div className="bot-form-field">
                <span id="bot-form-character-label">Character</span>
                <BotIconPicker
                  value={values.icon}
                  onChange={(icon) => set({ icon })}
                  aria-labelledby="bot-form-character-label"
                />
              </div>
              <label className="bot-form-field">
                <span>Name</span>
                <input
                  className="bot-form-name"
                  autoComplete="off"
                  value={values.displayName}
                  onChange={(event) => set({ displayName: event.target.value })}
                  placeholder="Research bot"
                  maxLength={80}
                />
              </label>
              <label className="bot-form-field">
                <span>What it helps with</span>
                <textarea
                  value={values.description}
                  onChange={(event) => set({ description: event.target.value })}
                  placeholder="Keeps an eye on our metrics and flags what changed."
                  maxLength={BOT_PROFILE_DESCRIPTION_MAX_LENGTH}
                  rows={2}
                />
              </label>
              <label className="bot-form-field">
                <span>
                  Instructions <small>optional</small>
                </span>
                <textarea
                  value={values.systemPrompt}
                  onChange={(event) => set({ systemPrompt: event.target.value })}
                  placeholder="How it should work, what to avoid, how to report back."
                  maxLength={BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH}
                  rows={4}
                />
              </label>
            </>
          )}
          {error ? (
            <div className="bot-form-error" role="alert">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <footer className="bot-form-actions">
          {onDelete ? (
            <button
              type="button"
              className="bot-form-danger"
              onClick={onDelete}
              disabled={loading || busy || unavailable}
            >
              Delete bot
            </button>
          ) : footnote ? (
            <span className="bot-form-footnote">{footnote}</span>
          ) : null}
          <span className="bot-form-actions-end">
            <button
              type="button"
              className="bot-form-secondary"
              onClick={requestClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="bot-form-primary"
              disabled={loading || busy || unavailable}
            >
              {busy ? <LoaderCircle className="spinning" size={14} /> : submitIcon}
              {busy ? busyLabel : submitLabel}
            </button>
          </span>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
