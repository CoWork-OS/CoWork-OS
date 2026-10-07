import { useEffect, useState, type ComponentType } from "react";
import { ArrowUpRight, Orbit, X } from "lucide-react";
import { UseCasesGallery } from "../UseCasesGallery";
import { requestUseCasesGallery } from "../use-cases-events";
import "./sidebar-notices.css";

/**
 * Sidebar notification area — the single place for lightweight, dismissable
 * notices in the left sidebar (rendered just above "Automated sessions").
 *
 * To add a notice, append an entry to SIDEBAR_NOTICES below. Each notice:
 * - has a stable `id` (dismissal and "seen" state are keyed on it, so never reuse one),
 * - shows an icon, a short label and an action,
 * - can be dismissed with the X; dismissal persists in localStorage,
 * - slides in with an animation only the first time it is ever shown.
 * Use `isVisible` to gate a notice on runtime conditions. Do not add ad-hoc
 * banners elsewhere in the sidebar. See docs/sidebar-notices.md.
 */
export interface SidebarNotice {
  id: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  label: string;
  /** Runs when the notice body is clicked. */
  onActivate: (ctx: SidebarNoticeContext) => void;
  isVisible?: () => boolean;
}

export interface SidebarNoticeContext {
  openUseCasesFallback: () => void;
}

export const SIDEBAR_NOTICES: SidebarNotice[] = [
  {
    id: "use-cases-gallery-v1",
    icon: Orbit,
    label: "See how people use CoWork OS",
    onActivate: (ctx) => {
      // Prefer the gallery centered over the visible composer; fall back to a window-level one.
      if (!requestUseCasesGallery()) ctx.openUseCasesFallback();
    },
  },
];

const DISMISSED_KEY = "cowork.sidebarNotices.dismissed";
const SEEN_KEY = "cowork.sidebarNotices.seen";

function readIds(key: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeIds(key: string, ids: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable: notices still work for this session.
  }
}

export function SidebarNotices() {
  const [dismissed, setDismissed] = useState(() => readIds(DISMISSED_KEY));
  // Snapshot of notices seen before this mount, so only brand-new ones animate.
  const [seenAtMount] = useState(() => readIds(SEEN_KEY));
  const [galleryOpen, setGalleryOpen] = useState(false);

  const visible = SIDEBAR_NOTICES.filter(
    (notice) => !dismissed.has(notice.id) && (notice.isVisible?.() ?? true),
  );

  useEffect(() => {
    if (visible.length === 0) return;
    const seen = readIds(SEEN_KEY);
    let changed = false;
    for (const notice of visible) {
      if (!seen.has(notice.id)) {
        seen.add(notice.id);
        changed = true;
      }
    }
    if (changed) writeIds(SEEN_KEY, seen);
  }, [visible]);

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    writeIds(DISMISSED_KEY, next);
    setDismissed(next);
  };

  return (
    <>
      {visible.length > 0 && (
        <section className="sidebar-notices" aria-label="Notifications">
          {visible.map((notice) => {
            const Icon = notice.icon;
            return (
              <div
                key={notice.id}
                className={`sidebar-notice${seenAtMount.has(notice.id) ? "" : " sidebar-notice-new"}`}
              >
                <button
                  type="button"
                  className="sidebar-notice-main"
                  onClick={() =>
                    notice.onActivate({ openUseCasesFallback: () => setGalleryOpen(true) })
                  }
                >
                  <span className="sidebar-notice-icon">
                    <Icon size={16} strokeWidth={1.8} aria-hidden />
                  </span>
                  <span className="sidebar-notice-label">{notice.label}</span>
                  <ArrowUpRight className="sidebar-notice-arrow" size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="sidebar-notice-dismiss"
                  onClick={() => dismiss(notice.id)}
                  aria-label={`Dismiss: ${notice.label}`}
                  title="Dismiss"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </section>
      )}
      <UseCasesGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} />
    </>
  );
}
