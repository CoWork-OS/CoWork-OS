import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { LockKeyhole } from "lucide-react";
import {
  BROWSER_VAULT_FIELD_LABELS,
  type BrowserVaultAnswer,
  type BrowserVaultFields,
  type BrowserVaultPrompt,
} from "../../../shared/browser-vault";
import "./private-browser-prompt.css";

const SECRET_FIELDS = new Set(["password", "otpSecret", "cardNumber", "cvc", "code"]);

export function PrivateBrowserPromptDialog({
  prompt,
  onRespond,
  onDismiss,
}: {
  prompt: BrowserVaultPrompt;
  onRespond: (answer: BrowserVaultAnswer | null) => Promise<boolean>;
  onDismiss?: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [fields, setFields] = useState<BrowserVaultFields>({});
  const canRemember = prompt.canRemember !== false;
  const [remember, setRemember] = useState(canRemember);
  const shouldRemember = canRemember && remember;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const host = new URL(prompt.origin).host;
  const labels =
    prompt.kind === "unlock"
      ? { password: "Master password" }
      : prompt.kind === "code"
        ? { code: "Verification code" }
        : prompt.kind === "card_code"
          ? { cvc: "Security code" }
          : BROWSER_VAULT_FIELD_LABELS[prompt.kind];
  const title =
    prompt.kind === "unlock"
      ? `Unlock ${prompt.source === "onepassword" ? "1Password" : "Bitwarden"}`
      : prompt.kind === "code"
        ? `Verification code for ${host}`
        : prompt.kind === "card_code"
          ? `Card security code for ${host}`
          : prompt.kind === "login"
            ? `Sign in to ${host} privately`
            : prompt.kind === "payment"
              ? `Payment card for ${host}`
              : `Address for ${host}`;
  const send = async (answer: BrowserVaultAnswer | null) => {
    flushSync(() => {
      setFields({});
      setBusy(true);
      setError("");
    });
    try {
      const accepted = await onRespond(answer);
      if (!accepted) setError("This request expired or the page changed. Close it and try again.");
    } catch {
      setError("Could not submit. Your input has been cleared; try again.");
    } finally {
      setFields({});
      setBusy(false);
    }
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void send(null);
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);
  useEffect(
    () => () => {
      // Acknowledge only after the cleared UI has had a chance to paint. The main-process
      // privacy lease remains active across IPC response, unmount, and compositor work.
      requestAnimationFrame(() => requestAnimationFrame(() => onDismiss?.()));
    },
    [prompt.id],
  );
  return (
    <div className="modal-overlay browser-private-overlay" data-private-input="true">
      <form
        ref={formRef}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const nodes = formRef.current?.querySelectorAll<HTMLElement>(
            "input:not(:disabled), button:not(:disabled)",
          );
          if (!nodes?.length) return;
          const first = nodes[0],
            last = nodes[nodes.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className="browser-private-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-private-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void send({ fields: { ...fields }, remember: shouldRemember });
        }}
      >
        <LockKeyhole size={22} aria-hidden="true" />
        <h2 id="browser-private-title">{title}</h2>
        <p>
          Destination: <strong>{prompt.origin}</strong>
        </p>
        <p>
          CoWork enters secret fields directly on this site. Passwords, codes, payment details and
          addresses stay out of chat and AI model input.
        </p>
        {prompt.kind === "login" && (
          <p>Saved usernames may appear when CoWork lists matching accounts.</p>
        )}
        {prompt.kind === "unlock" && prompt.source === "onepassword" && (
          <p>Leave the password empty to use 1Password desktop app integration.</p>
        )}
        {Object.entries(labels).map(([field, label], index) => (
          <label key={field}>
            <span>{label}</span>
            <input
              autoFocus={index === 0}
              aria-label={label}
              type={SECRET_FIELDS.has(field) ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              required={
                prompt.kind === "login"
                  ? ["username", "password"].includes(field)
                  : prompt.kind === "code" ||
                      prompt.kind === "card_code" ||
                      (prompt.kind === "unlock" && prompt.source === "bitwarden")
                    ? true
                    : prompt.kind === "payment"
                      ? ["cardNumber", "expMonth", "expYear", "cvc"].includes(field)
                      : prompt.kind === "address"
                        ? ["addressLine1", "city", "postalCode", "country"].includes(field)
                        : false
              }
              value={fields[field] || ""}
              disabled={busy}
              onChange={(event) =>
                setFields((current) => ({ ...current, [field]: event.target.value }))
              }
            />
          </label>
        ))}
        {["login", "payment", "address"].includes(prompt.kind) && canRemember && (
          <label className="browser-private-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Remember on this device for this site
          </label>
        )}
        {["login", "payment", "address"].includes(prompt.kind) && !canRemember && (
          <p>
            Encrypted storage is unavailable. Your input will be used once and will not be saved.
          </p>
        )}
        {prompt.kind === "unlock" && (
          <p>
            Install and sign in to the manager CLI first. Access locks after 30 minutes idle, or
            when you choose Lock in the autofill menu.
          </p>
        )}
        {prompt.kind === "payment" && (
          <p>
            The security code is used once and never saved. Filling card details requires approval;
            placing an order needs separate approval.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="browser-private-actions">
          <button type="button" disabled={busy} onClick={() => void send(null)}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy
              ? "Continuing…"
              : prompt.kind === "unlock"
                ? "Unlock"
                : prompt.kind === "login"
                  ? shouldRemember
                    ? "Save & sign in"
                    : "Sign in once"
                  : "Continue privately"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Mounted outside chat: no composer, task message, draft persistence, or analytics path. */
export function PrivateBrowserPrompts() {
  const [prompts, setPrompts] = useState<BrowserVaultPrompt[]>([]);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const next = await window.electronAPI.listBrowserVaultPrompts?.();
        if (!disposed && request === revision) setPrompts(next || []);
      } catch {
        if (!disposed) setPrompts([]);
      }
    };
    const unsubscribe = window.electronAPI.onBrowserVaultPromptChanged?.(() => void refresh());
    void refresh();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);
  const prompt = prompts[0];
  return prompt ? (
    <PrivateBrowserPromptDialog
      key={prompt.id}
      prompt={prompt}
      onDismiss={() => {
        void window.electronAPI.dismissBrowserVaultPrompt(prompt.id);
      }}
      onRespond={async (answer) => {
        const result = await window.electronAPI.respondBrowserVaultPrompt(prompt.id, answer);
        if (result.success)
          setPrompts((current) => current.filter((item) => item.id !== prompt.id));
        return result.success;
      }}
    />
  ) : null;
}
