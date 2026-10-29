const MIN_MENU_WIDTH = 220;
const EDGE_GAP = 12;

/**
 * The "/" and "@" menus are anchored to the composer's text field and want to
 * be 720px wide. With the right panel open the chat column is narrower than
 * that, so the menu was clipped at the column edge, or scrolled the whole chat
 * sideways to bring the highlighted option into view. Cap the menu to the room
 * between its left edge and the first scrolling or clipping ancestor's right edge.
 */
export function fitComposerMenuWidth(menu: HTMLElement | null): void {
  if (!menu) return;
  menu.style.removeProperty("--composer-menu-max-width");
  const left = menu.getBoundingClientRect().left;
  let right = window.innerWidth;
  for (let node = menu.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowX !== "visible") {
      right = Math.min(right, node.getBoundingClientRect().right);
      break;
    }
  }
  const available = Math.floor(right - left - EDGE_GAP);
  menu.style.setProperty("--composer-menu-max-width", `${Math.max(MIN_MENU_WIDTH, available)}px`);
}
