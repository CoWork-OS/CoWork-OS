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

const MIN_MENU_HEIGHT = 160;
const MENU_OFFSET = 8;

/**
 * The menus open upward from the composer. When the composer sits high in the view (Calm
 * Home with Today cards under it), the menu ran past the top of the window and its first
 * options could not be seen. Cap the menu to the room above the composer, or open it below
 * when there is too little room above and more below.
 */
export function fitComposerMenuHeight(menu: HTMLElement | null): void {
  if (!menu) return;
  const anchor = menu.parentElement;
  if (!anchor) return;
  menu.style.removeProperty("--composer-menu-max-height");
  menu.removeAttribute("data-placement");
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = anchor.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== "visible") {
      const rect = node.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
      break;
    }
  }
  const anchorRect = anchor.getBoundingClientRect();
  const above = Math.floor(anchorRect.top - MENU_OFFSET - top - EDGE_GAP);
  const below = Math.floor(bottom - anchorRect.bottom - MENU_OFFSET - EDGE_GAP);
  const placeBelow = above < MIN_MENU_HEIGHT && below > above;
  if (placeBelow) menu.setAttribute("data-placement", "below");
  const room = placeBelow ? below : above;
  menu.style.setProperty("--composer-menu-max-height", `${Math.max(MIN_MENU_HEIGHT, room)}px`);
}
