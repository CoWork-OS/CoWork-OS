import { useLayoutEffect, type RefObject } from "react";

/** One tab stop per menu, with arrow/Home/End navigation including unavailable choices. */
export function useMenuKeyboard(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const container = ref.current;
    const menu = container.querySelector<HTMLElement>('[role="menu"]');
    if (!menu) return;
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
    return bindMenuKeyboard(menu, trigger, onClose);
  }, [ref, open, onClose]);
}

export function bindMenuKeyboard(
  menu: HTMLElement,
  trigger: HTMLButtonElement | null,
  onClose: () => void,
  portalled = false,
): () => void {
  const readItems = () =>
    Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter(
      (item) => !item.hasAttribute("disabled"),
    );
  const selectedRadioIndex = (items: HTMLElement[]) =>
    items.findIndex((item) => item.matches('[role="menuitemradio"][aria-checked="true"]'));
  const focus = (index: number, preventScroll = false) => {
    const items = readItems();
    items.forEach((item, i) => {
      item.tabIndex = i === index ? 0 : -1;
    });
    items[index]?.focus({ preventScroll });
  };
  focus(Math.max(0, selectedRadioIndex(readItems())), portalled);
  const observer = new MutationObserver(() => {
    const currentItems = readItems();
    const activeIndex = currentItems.indexOf(document.activeElement as HTMLElement);
    const tabStop = activeIndex >= 0 ? activeIndex : Math.max(0, selectedRadioIndex(currentItems));
    currentItems.forEach((item, index) => {
      item.tabIndex = index === tabStop ? 0 : -1;
    });
  });
  observer.observe(menu, { childList: true, subtree: true });
  const handleKey = (event: KeyboardEvent) => {
    const items = readItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length) {
      event.preventDefault();
      focus(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : index < 0
              ? event.key === "ArrowDown"
                ? 0
                : items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length,
      );
    } else if (
      event.key === "Escape" ||
      (event.key === "Tab" && event.shiftKey && trigger && menu.contains(document.activeElement))
    ) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      trigger?.focus({ preventScroll: true });
    } else if (
      event.key === "Tab" &&
      portalled &&
      trigger &&
      menu.contains(document.activeElement)
    ) {
      // Continue tabbing from the trigger, rather than from the end of the portal.
      onClose();
      trigger.focus({ preventScroll: true });
    }
  };
  const handleFocusOut = (event: FocusEvent) => {
    // The trigger still has a click to handle when a pointer moves focus back to it.
    if (
      event.relatedTarget instanceof Node &&
      event.relatedTarget !== trigger &&
      !menu.contains(event.relatedTarget)
    ) {
      onClose();
    }
  };
  menu.addEventListener("keydown", handleKey);
  trigger?.addEventListener("keydown", handleKey);
  menu.addEventListener("focusout", handleFocusOut);
  return () => {
    observer.disconnect();
    menu.removeEventListener("keydown", handleKey);
    trigger?.removeEventListener("keydown", handleKey);
    menu.removeEventListener("focusout", handleFocusOut);
    if (menu.contains(document.activeElement)) trigger?.focus({ preventScroll: true });
  };
}
