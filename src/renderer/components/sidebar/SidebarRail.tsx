import { memo, useCallback, useMemo, useRef, useState, type ComponentType } from "react";
import { CircleArrowUp, Ellipsis, Pin, PinOff, Settings } from "lucide-react";
import { useIsCalmTheme } from "../../hooks/useIsCalmTheme";
import { useInboxUnreadCount } from "../../hooks/useInboxUnreadCount";
import { useDismissable } from "../calm/useDismissable";
import {
  getSidebarRailLayout,
  readPinnedSidebarDestinations,
  togglePinnedSidebarDestination,
  writePinnedSidebarDestinations,
  type SidebarDestination,
  type SidebarDestinationId,
} from "./sidebar-destinations";
import "./sidebar-rail.css";

export interface SidebarRailProps {
  activeId: SidebarDestinationId | null;
  onNavigate: (id: SidebarDestinationId) => void;
  onOpenSettings: () => void;
  workspaceId?: string;
  updateAvailable?: boolean;
  /** False when this system can't install the update; it then only flags Settings. */
  updateSupported?: boolean;
  /** Opens Settings at the update. An installable update gets its own rail item. */
  onViewUpdate?: () => void;
  /** Test seam; the app reads pins from localStorage. */
  initialPinnedIds?: SidebarDestinationId[];
}

/** Icon with its caption underneath; the caption is visual, the button's label is spoken. */
function RailItemContent({
  icon: Icon,
  caption,
  active = false,
  dot,
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  caption: string;
  active?: boolean;
  dot?: "unread" | "update";
}) {
  return (
    <>
      <span className="sidebar-rail-icon" aria-hidden="true">
        <Icon size={18} strokeWidth={active ? 2.1 : 1.75} />
        {dot && <span className={`sidebar-rail-dot sidebar-rail-dot-${dot}`} />}
      </span>
      <span className="sidebar-rail-label" aria-hidden="true">
        {caption}
      </span>
    </>
  );
}

function RailButton({
  destination,
  active,
  badge = 0,
  onSelect,
}: {
  destination: SidebarDestination;
  active: boolean;
  badge?: number;
  onSelect: (id: SidebarDestinationId) => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar-rail-btn${active ? " active" : ""}`}
      onClick={() => onSelect(destination.id)}
      aria-current={active ? "page" : undefined}
      aria-label={badge > 0 ? `${destination.label}, ${badge} unread` : destination.label}
      title={destination.railLabel ? destination.label : undefined}
      data-destination={destination.id}
    >
      <RailItemContent
        icon={destination.icon}
        caption={destination.railLabel ?? destination.label}
        active={active}
        dot={badge > 0 ? "unread" : undefined}
      />
    </button>
  );
}

/** Left rail: labelled destinations, pinned More items, and the More menu. */
function SidebarRailComponent({
  activeId,
  onNavigate,
  onOpenSettings,
  workspaceId,
  updateAvailable = false,
  updateSupported = true,
  onViewUpdate,
  initialPinnedIds,
}: SidebarRailProps) {
  const isCalm = useIsCalmTheme();
  const isBrowserHost = typeof window !== "undefined" && window.coworkBrowserHost === true;
  const inboxUnreadCount = useInboxUnreadCount(workspaceId);
  const [pinnedIds, setPinnedIds] = useState<SidebarDestinationId[]>(
    () => initialPinnedIds ?? readPinnedSidebarDestinations(),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  useDismissable(moreRef, moreOpen, closeMore);

  const layout = useMemo(
    () => getSidebarRailLayout({ isCalm, isBrowserHost }, pinnedIds),
    [isBrowserHost, isCalm, pinnedIds],
  );
  const activeIsHiddenInMore =
    activeId !== null &&
    layout.more.some((item) => item.id === activeId) &&
    !pinnedIds.includes(activeId);

  const handleTogglePin = (id: SidebarDestinationId) => {
    setPinnedIds((current) => {
      const next = togglePinnedSidebarDestination(current, id);
      writePinnedSidebarDestinations(next);
      return next;
    });
  };

  const badgeFor = (id: SidebarDestinationId) => (id === "inbox" ? inboxUnreadCount : 0);
  const showUpdateItem = updateAvailable && updateSupported && Boolean(onViewUpdate);
  const flagSettings = updateAvailable && !showUpdateItem;

  return (
    <nav className="sidebar-rail" aria-label="Main">
      {layout.rail.map((destination) => (
        <RailButton
          key={destination.id}
          destination={destination}
          active={destination.id === activeId}
          badge={badgeFor(destination.id)}
          onSelect={onNavigate}
        />
      ))}

      {layout.more.length > 0 && (
        <div className="sidebar-rail-more" ref={moreRef}>
          <button
            type="button"
            className={`sidebar-rail-btn${activeIsHiddenInMore ? " active" : ""}${moreOpen ? " open" : ""}`}
            onClick={() => setMoreOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="More"
          >
            <RailItemContent icon={Ellipsis} caption="More" active={activeIsHiddenInMore} />
          </button>
          {moreOpen && (
            <div
              className="task-item-menu sidebar-workspace-menu sidebar-rail-menu"
              role="menu"
              aria-label="More destinations"
            >
              {layout.more.map((destination) => {
                const Icon = destination.icon;
                const pinned = pinnedIds.includes(destination.id);
                return (
                  <div key={destination.id} className="sidebar-rail-menu-row" role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className={`sidebar-workspace-menu-option${destination.id === activeId ? " active" : ""}`}
                      onClick={() => {
                        setMoreOpen(false);
                        onNavigate(destination.id);
                      }}
                    >
                      <Icon size={16} />
                      <span>{destination.label}</span>
                    </button>
                    <button
                      type="button"
                      className={`sidebar-rail-pin${pinned ? " pinned" : ""}`}
                      onClick={() => handleTogglePin(destination.id)}
                      aria-pressed={pinned}
                      aria-label={
                        pinned
                          ? `Unpin ${destination.label} from the sidebar`
                          : `Pin ${destination.label} to the sidebar`
                      }
                      title={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                    >
                      {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {layout.pinned.length > 0 && (
        <>
          <div className="sidebar-rail-divider" role="separator" />
          {layout.pinned.map((destination) => (
            <RailButton
              key={destination.id}
              destination={destination}
              active={destination.id === activeId}
              badge={badgeFor(destination.id)}
              onSelect={onNavigate}
            />
          ))}
        </>
      )}

      <div className="sidebar-rail-spacer" />

      {showUpdateItem && (
        <button
          type="button"
          className="sidebar-rail-btn sidebar-rail-update"
          onClick={onViewUpdate}
          aria-label="Update available"
          title="An update is ready. Open update settings"
        >
          <RailItemContent icon={CircleArrowUp} caption="Update" />
        </button>
      )}

      <button
        type="button"
        className="sidebar-rail-btn"
        onClick={onOpenSettings}
        aria-label={flagSettings ? "Settings, update available" : "Settings"}
        title={
          flagSettings
            ? updateSupported
              ? "Update available"
              : "An update is available but needs a newer macOS"
            : undefined
        }
      >
        <RailItemContent
          icon={Settings}
          caption="Settings"
          dot={flagSettings ? "update" : undefined}
        />
      </button>
    </nav>
  );
}

export const SidebarRail = memo(SidebarRailComponent);
