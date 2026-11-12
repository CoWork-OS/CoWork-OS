/**
 * Browser sessions only: the tab title and favicon show when tasks wait on the user, so a
 * background tab still says "come back". Desktop never creates a controller.
 */

import { classifyTaskActivity } from "../../shared/attention";
import type { Task } from "../../shared/types";

/**
 * Sessions waiting on the user, by the task list's own rule. This is what the needs-you
 * queue counts as waiting sessions, for a host that has no queue (a Node daemon): a waiting
 * sub-agent is represented by its parent, as in the sidebar.
 */
export function waitingSessionsFromTasks(tasks: readonly Task[]): Map<string, string> {
  const waiting = new Map<string, string>();
  for (const task of tasks) {
    if (task.parentTaskId) continue;
    const activity = classifyTaskActivity(task);
    if (activity?.category === "needs-you") waiting.set(task.id, activity.label);
  }
  return waiting;
}

/** How often the title alternates while the user is away. */
export const TAB_ATTENTION_ALTERNATE_MS = 1000;
/** Used when the theme's warning token can't be read. */
export const TAB_ATTENTION_DOT_FALLBACK = "#d97706";
const DOT_COLOR_TOKEN = "--color-warning";
const ICON_SELECTOR = 'link[rel~="icon"]';
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type AwayDocument = Pick<Document, "hidden" | "hasFocus">;

/** The user is in another tab, another window, or another app. */
export function isUserAway(doc: AwayDocument): boolean {
  try {
    return doc.hidden || !doc.hasFocus();
  } catch {
    return false;
  }
}

export function prefersReducedMotion(win: Pick<Window, "matchMedia">): boolean {
  try {
    return win.matchMedia?.(REDUCED_MOTION_QUERY)?.matches === true;
  } catch {
    return false;
  }
}

/** `(N) base` while tasks wait, the base title otherwise. */
export function formatAttentionTitle(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

/** The alternate title for the given tasks: one task's reason, or "Needs you" for several. */
export function formatAttentionReasonTitle(
  base: string,
  waiting: ReadonlyMap<string, string>,
): string {
  let reason = "Needs you";
  if (waiting.size === 1) {
    const only = [...waiting.values()][0]?.trim();
    if (only) reason = only;
  }
  return `${reason} · ${base}`;
}

/** Reads the badge colour from the theme so the dot matches the bell's count. */
export function readAttentionDotColor(doc: Document, win: Pick<Window, "getComputedStyle">) {
  try {
    const value = win
      .getComputedStyle(doc.documentElement)
      .getPropertyValue(DOT_COLOR_TOKEN)
      .trim();
    return value || TAB_ATTENTION_DOT_FALLBACK;
  } catch {
    return TAB_ATTENTION_DOT_FALLBACK;
  }
}

export interface FaviconBadge {
  show(): void;
  clear(): void;
}

/**
 * Draws the page's own icon with a dot in the top-right corner and swaps it onto every icon
 * link; `clear` puts each link's original href back. Fails quietly without image or canvas.
 */
export function createFaviconBadge(
  doc: Document,
  win: Pick<Window, "getComputedStyle">,
): FaviconBadge {
  const originals = new Map<HTMLLinkElement, string | null>();
  let active = false;
  let generation = 0;
  let badgedHref: string | null = null;

  const links = () => Array.from(doc.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR));

  const apply = (href: string) => {
    for (const link of links()) {
      if (!originals.has(link)) originals.set(link, link.getAttribute("href"));
      link.setAttribute("href", href);
    }
  };

  const draw = (image: HTMLImageElement): string | null => {
    const canvas = doc.createElement("canvas");
    const size = 64;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, size, size);
    const radius = size * 0.2;
    const ring = size * 0.06;
    const cx = size - radius - ring;
    const cy = radius + ring;
    // A thin light ring keeps the dot readable on dark tab strips.
    context.beginPath();
    context.arc(cx, cy, radius + ring, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    // A canvas ignores a colour it can't parse, so the fallback stays if the token is odd.
    context.fillStyle = TAB_ATTENTION_DOT_FALLBACK;
    context.fillStyle = readAttentionDotColor(doc, win);
    context.fill();
    return canvas.toDataURL("image/png");
  };

  return {
    show() {
      if (active) return;
      active = true;
      if (badgedHref) {
        apply(badgedHref);
        return;
      }
      const first = links()[0];
      const source = first?.href || first?.getAttribute("href");
      if (!source) return;
      const loading = ++generation;
      try {
        const image = doc.createElement("img");
        image.onload = () => {
          // The count may have dropped to zero while the icon loaded.
          if (loading !== generation || !active) return;
          try {
            const href = draw(image);
            if (!href) return;
            badgedHref = href;
            apply(href);
          } catch {
            // A tainted or unavailable canvas leaves the plain icon.
          }
        };
        image.onerror = () => undefined;
        image.src = source;
      } catch {
        // No image support: keep the plain icon.
      }
    },
    clear() {
      active = false;
      generation += 1;
      for (const [link, href] of originals) {
        if (href === null) link.removeAttribute("href");
        else link.setAttribute("href", href);
      }
      originals.clear();
    },
  };
}

export interface TabAttentionController {
  update(waiting: ReadonlyMap<string, string>): void;
  dispose(): void;
}

type TabAttentionWindow = Pick<
  Window,
  | "addEventListener"
  | "removeEventListener"
  | "setInterval"
  | "clearInterval"
  | "matchMedia"
  | "getComputedStyle"
>;

/**
 * Owns the tab title and favicon for one mounted app. The base title is whatever the page
 * had when this was created, and is restored at zero and on dispose.
 *
 * The count and the dot stay while tasks wait. The title only alternates for tasks that
 * started waiting while the user was away, and stops when they come back, so a task left
 * waiting on purpose doesn't flash the tab forever.
 */
export function createTabAttentionController(
  doc: Document,
  win: TabAttentionWindow,
): TabAttentionController {
  const base = doc.title;
  const favicon = createFaviconBadge(doc, win);
  let waiting: ReadonlyMap<string, string> = new Map();
  /** Waiting tasks the user has already had in front of them. */
  let seen = new Set<string>();
  let timer: number | null = null;
  let showReason = false;
  let disposed = false;

  const setTitle = (title: string) => {
    if (doc.title !== title) doc.title = title;
  };

  const stopAlternating = () => {
    if (timer !== null) win.clearInterval(timer);
    timer = null;
    showReason = false;
  };

  /** Tasks that started waiting since the user last looked. */
  const unseen = (): Map<string, string> => {
    const fresh = new Map<string, string>();
    for (const [taskId, reason] of waiting) {
      if (!seen.has(taskId)) fresh.set(taskId, reason);
    }
    return fresh;
  };

  const awayTitle = () => {
    const fresh = unseen();
    return showReason && fresh.size > 0
      ? formatAttentionReasonTitle(base, fresh)
      : formatAttentionTitle(base, waiting.size);
  };

  const render = () => {
    if (disposed) return;
    const count = waiting.size;
    // A task that stopped waiting and waits again later is new again.
    for (const taskId of seen) {
      if (!waiting.has(taskId)) seen.delete(taskId);
    }
    if (count === 0) {
      stopAlternating();
      setTitle(base);
      favicon.clear();
      return;
    }
    favicon.show();
    if (!isUserAway(doc)) {
      seen = new Set(waiting.keys());
      stopAlternating();
      setTitle(formatAttentionTitle(base, count));
      return;
    }
    if (unseen().size > 0 && !prefersReducedMotion(win)) {
      if (timer === null) {
        timer = win.setInterval(() => {
          showReason = !showReason;
          setTitle(awayTitle());
        }, TAB_ATTENTION_ALTERNATE_MS);
      }
      setTitle(awayTitle());
      return;
    }
    stopAlternating();
    setTitle(formatAttentionTitle(base, count));
  };

  doc.addEventListener("visibilitychange", render);
  win.addEventListener("focus", render);
  win.addEventListener("blur", render);

  return {
    update(next) {
      waiting = next;
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      doc.removeEventListener("visibilitychange", render);
      win.removeEventListener("focus", render);
      win.removeEventListener("blur", render);
      stopAlternating();
      setTitle(base);
      favicon.clear();
    },
  };
}
