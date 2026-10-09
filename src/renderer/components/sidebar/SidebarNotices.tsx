import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Orbit, Sparkles, X } from "lucide-react";
import { useComposerPredictionAvailable } from "../../hooks/useComposerPredictions";
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
  isVisible?: (ctx: { composerPredictionAvailable: boolean }) => boolean;
  /** A feature-discovery tooltip opens automatically only on its first display. */
  tip?: { title: string; description: string };
}

export interface SidebarNoticeContext {
  openUseCasesFallback: () => void;
}

export const SIDEBAR_NOTICES: SidebarNotice[] = [
  {
    id: "composer-predictions-v1",
    icon: Sparkles,
    label: "New: Composer predictions",
    tip: {
      title: "Your next message, suggested",
      description:
        "Predictions appear after a response. Press Tab to accept, then edit and send. Uses your selected LLM provider and consumes tokens. Turn them on or off in Settings → Appearance → Composer.",
    },
    isVisible: ({ composerPredictionAvailable }) =>
      composerPredictionAvailable &&
      typeof window !== "undefined" &&
      Boolean(window.electronAPI?.getComposerPrediction),
    onActivate: () => {
      window.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "appearance" } }));
    },
  },
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

/** Returns a new feature tip once, retaining the existing animation/dismissal keys. */
export function recordShownSidebarNotices(
  notices: SidebarNotice[],
  seen = readIds(SEEN_KEY),
): SidebarNotice | undefined {
  const firstTip = notices.find((notice) => notice.tip && !seen.has(notice.id));
  let changed = false;
  for (const notice of notices) {
    if (!seen.has(notice.id)) {
      seen.add(notice.id);
      changed = true;
    }
  }
  if (changed) writeIds(SEEN_KEY, seen);
  return firstTip;
}

function SidebarNoticeTip({
  notice,
  anchor,
  onClose,
  onActivate,
}: {
  notice: SidebarNotice;
  anchor: HTMLElement;
  onClose: () => void;
  onActivate: () => void;
}) {
  const tipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const positionTip = () => {
      const rect = anchor.getBoundingClientRect();
      const tip = tipRef.current;
      if (!tip) return;
      setPosition({
        left: Math.max(12, Math.min(rect.right + 12, window.innerWidth - tip.offsetWidth - 12)),
        top: Math.max(12, Math.min(rect.top, window.innerHeight - tip.offsetHeight - 12)),
      });
    };
    positionTip();
    window.addEventListener("resize", positionTip);
    window.addEventListener("scroll", positionTip, true);
    return () => {
      window.removeEventListener("resize", positionTip);
      window.removeEventListener("scroll", positionTip, true);
    };
  }, [anchor]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onOutside = (event: PointerEvent) => {
      if (!tipRef.current?.contains(event.target as Node) && !anchor.contains(event.target as Node))
        onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onOutside);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onOutside);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={tipRef}
      className="sidebar-notice-tip"
      style={position}
      role="dialog"
      aria-labelledby={`sidebar-notice-tip-${notice.id}`}
      aria-live="polite"
    >
      <h4 id={`sidebar-notice-tip-${notice.id}`}>{notice.tip?.title}</h4>
      <p>{notice.tip?.description}</p>
      <div className="sidebar-notice-tip-actions">
        <button type="button" className="button-secondary" onClick={onActivate}>
          Open settings
        </button>
        <button type="button" className="button-primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function SidebarNotices() {
  const composerPredictionAvailable = useComposerPredictionAvailable();
  const [dismissed, setDismissed] = useState(() => readIds(DISMISSED_KEY));
  // Snapshot of notices seen before this mount, so only brand-new ones animate.
  const [seenAtMount] = useState(() => readIds(SEEN_KEY));
  const seen = useRef(new Set(seenAtMount));
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [activeTip, setActiveTip] = useState<string | null>(null);
  const anchors = useRef(new Map<string, HTMLButtonElement>());

  const visible = SIDEBAR_NOTICES.filter(
    (notice) =>
      !dismissed.has(notice.id) && (notice.isVisible?.({ composerPredictionAvailable }) ?? true),
  );

  useEffect(() => {
    if (visible.length === 0) return;
    const firstTip = recordShownSidebarNotices(visible, seen.current);
    if (firstTip) setActiveTip(firstTip.id);
  }, [visible]);

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    writeIds(DISMISSED_KEY, next);
    setDismissed(next);
    if (activeTip === id) setActiveTip(null);
  };

  const activate = (notice: SidebarNotice) => {
    setActiveTip(null);
    notice.onActivate({ openUseCasesFallback: () => setGalleryOpen(true) });
  };
  const tipNotice = visible.find((notice) => notice.id === activeTip);
  const tipAnchor = tipNotice ? anchors.current.get(tipNotice.id) : undefined;

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
                  ref={(element) => {
                    if (element) anchors.current.set(notice.id, element);
                    else anchors.current.delete(notice.id);
                  }}
                  title={notice.tip?.description}
                  onClick={() => activate(notice)}
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
      {tipNotice && tipAnchor && (
        <SidebarNoticeTip
          notice={tipNotice}
          anchor={tipAnchor}
          onClose={() => setActiveTip(null)}
          onActivate={() => activate(tipNotice)}
        />
      )}
      <UseCasesGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} />
    </>
  );
}
