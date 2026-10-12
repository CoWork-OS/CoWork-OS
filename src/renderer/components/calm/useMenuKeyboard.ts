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
    const readItems = () =>
      Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter(
        (item) => !item.hasAttribute("disabled"),
      );
    const focus = (index: number) => {
      const items = readItems();
      items.forEach((item, i) => {
        item.tabIndex = i === index ? 0 : -1;
      });
      items[index]?.focus({ preventScroll: true });
    };
    const items = readItems();
    const initial = items.findIndex((item) => item.getAttribute("aria-checked") === "true");
    focus(Math.max(0, initial));
    const observer = new MutationObserver(() => {
      const currentItems = readItems();
      const activeIndex = currentItems.indexOf(document.activeElement as HTMLElement);
      const checkedIndex = currentItems.findIndex(
        (item) => item.getAttribute("aria-checked") === "true",
      );
      const tabStop = activeIndex >= 0 ? activeIndex : Math.max(0, checkedIndex);
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
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        trigger?.focus({ preventScroll: true });
      }
    };
    menu.addEventListener("keydown", handleKey);
    return () => {
      observer.disconnect();
      menu.removeEventListener("keydown", handleKey);
      if (menu.contains(document.activeElement)) trigger?.focus({ preventScroll: true });
    };
  }, [ref, open, onClose]);
}
