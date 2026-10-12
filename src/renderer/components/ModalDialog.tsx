import { useLayoutEffect, useRef, type HTMLAttributes, type RefObject } from "react";

const dialogs: HTMLElement[] = [];
const focusableSelector =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
      element.getClientRects().length > 0,
  );
}

export function isTopModal(element: HTMLElement | null) {
  return Boolean(element && dialogs.at(-1) === element);
}

export function useModalDialog(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const descendant = dialogs.findIndex((other) => dialog.contains(other));
    if (descendant >= 0) dialogs.splice(descendant, 0, dialog);
    else dialogs.push(dialog);
    const isTop = () => dialogs.at(-1) === dialog;
    const focusFirst = () =>
      (focusableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    if (!dialog.contains(document.activeElement)) focusFirst();

    const handleFocus = (event: FocusEvent) => {
      if (isTop() && !dialog.contains(event.target as Node)) focusFirst();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (!isTop() || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const elements = focusableElements(dialog);
        const index = elements.indexOf(document.activeElement as HTMLElement);
        if (
          !elements.length ||
          (event.shiftKey ? index <= 0 : index < 0 || index === elements.length - 1)
        ) {
          event.preventDefault();
          (event.shiftKey ? (elements.at(-1) ?? dialog) : (elements[0] ?? dialog)).focus({
            preventScroll: true,
          });
        }
      }
    };
    document.addEventListener("focusin", handleFocus);
    document.addEventListener("keydown", handleKey);
    return () => {
      const wasTop = isTop();
      const index = dialogs.indexOf(dialog);
      if (index >= 0) dialogs.splice(index, 1);
      document.removeEventListener("focusin", handleFocus);
      document.removeEventListener("keydown", handleKey);
      if (wasTop) {
        const parent = dialogs.at(-1);
        if (opener?.isConnected && (!parent || parent.contains(opener)))
          opener.focus({ preventScroll: true });
        else if (parent) (focusableElements(parent)[0] ?? parent).focus({ preventScroll: true });
      }
    };
  }, [ref]);
}

/** Shared modal behavior; keeps the existing container classes and portal placement. */
export function ModalDialog({
  onClose,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalDialog(ref, onClose);
  return (
    <div {...props} ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
      {children}
    </div>
  );
}
