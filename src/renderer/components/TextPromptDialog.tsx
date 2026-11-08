import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmDialog } from "./ConfirmDialog";

export interface TextPromptOptions {
  title: string;
  /** A sentence under the title. */
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}

export interface TextPromptDialogProps extends TextPromptOptions {
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** A ConfirmDialog with one text field. Enter submits; Escape, Cancel or a click outside cancel. */
export function TextPromptDialog({
  title,
  message,
  defaultValue = "",
  placeholder,
  confirmLabel = "OK",
  onSubmit,
  onCancel,
}: TextPromptDialogProps) {
  const [value, setValue] = useState(defaultValue);
  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      onConfirm={() => onSubmit(value)}
      onCancel={onCancel}
    >
      <input
        type="text"
        className="confirm-dialog-input"
        aria-label={title}
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSubmit(value);
          }
        }}
      />
    </ConfirmDialog>
  );
}

/**
 * The in-app stand-in for `window.prompt`, which Electron does not implement: there it throws
 * "prompt() is not supported." Resolves to the entered text, or null when cancelled.
 */
export function promptForText(options: TextPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const finish = (value: string | null) => {
      root.unmount();
      host.remove();
      resolve(value);
    };
    root.render(
      <TextPromptDialog
        {...options}
        onSubmit={(value) => finish(value)}
        onCancel={() => finish(null)}
      />,
    );
  });
}
