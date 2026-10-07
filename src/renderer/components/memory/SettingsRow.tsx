import type { ReactNode } from "react";

/**
 * The building blocks of the Memory Hub Settings tab: a section with its scope caption,
 * a group inside Advanced, and one row (label and hint on the left, the control on the
 * right). Pure components without state.
 */

export function SettingsSection(props: {
  id: string;
  title: string;
  /** The quiet caption: "this workspace: <name>" or "all workspaces". */
  scope: string;
  children?: ReactNode;
}) {
  return (
    <section
      className="memory-settings-section"
      data-section={props.id}
      aria-labelledby={`memory-settings-${props.id}`}
    >
      <div className="memory-settings-section-head">
        <h3 id={`memory-settings-${props.id}`}>{props.title}</h3>
        <span className="memory-settings-scope">{props.scope}</span>
      </div>
      {props.children}
    </section>
  );
}

/** A labelled group inside Advanced. */
export function SettingsGroup(props: {
  id: string;
  title: string;
  scope?: string;
  children?: ReactNode;
}) {
  return (
    <section className="memory-settings-group" data-group={props.id}>
      <h4>
        {props.title}
        {props.scope && <span className="memory-settings-scope">{props.scope}</span>}
      </h4>
      {props.children}
    </section>
  );
}

export interface SettingsRowProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Id of the single field the label names. */
  htmlFor?: string;
  /** The controls on the right (a switch, a field, buttons). */
  children?: ReactNode;
  /** Full-width content under the row: a status line, an opened panel. */
  below?: ReactNode;
  testId?: string;
}

export function SettingsRow({ label, hint, htmlFor, children, below, testId }: SettingsRowProps) {
  return (
    <div className="memory-settings-row" data-testid={testId}>
      <div className="memory-settings-row-main">
        <div className="memory-settings-row-text">
          {htmlFor ? (
            <label className="memory-settings-row-label" htmlFor={htmlFor}>
              {label}
            </label>
          ) : (
            <div className="memory-settings-row-label">{label}</div>
          )}
          {hint ? <p className="settings-form-hint">{hint}</p> : null}
        </div>
        {children ? <div className="memory-settings-row-control">{children}</div> : null}
      </div>
      {below}
    </div>
  );
}

/** The on/off switch of a row (settings-toggle look, exposed as a switch). */
export function SettingsSwitch(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="settings-toggle memory-settings-switch" title={props.title}>
      <input
        type="checkbox"
        role="switch"
        aria-label={props.label}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="toggle-slider" />
    </label>
  );
}

export type BadgeTone = "neutral" | "success" | "warning" | "error";

export function SettingsBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`settings-badge settings-badge--${tone}`}>{children}</span>;
}

/** The button that opens a row's panel ("Manage", "Set up"); "Hide" while it is open. */
export function DisclosureButton(props: {
  expanded: boolean;
  onToggle: () => void;
  label: string;
  controls: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="settings-button"
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      disabled={props.disabled}
      onClick={props.onToggle}
    >
      {props.expanded ? "Hide" : props.label}
    </button>
  );
}

/** The inline result of an action (one look for success and error). */
export function SettingsFeedback({
  message,
}: {
  message: { tone: "success" | "error"; text: string } | null;
}) {
  if (!message) return null;
  return (
    <div
      role={message.tone === "error" ? "alert" : "status"}
      className={`settings-feedback ${message.tone}`}
    >
      {message.text}
    </div>
  );
}
