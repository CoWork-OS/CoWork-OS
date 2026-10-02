import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
} from "react";
import { CircleArrowUp, Ellipsis, Pin, PinOff, RotateCcw, Settings } from "lucide-react";
import { useIsCalmTheme } from "../../hooks/useIsCalmTheme";
import { useInboxUnreadCount } from "../../hooks/useInboxUnreadCount";
import { useDismissable } from "../calm/useDismissable";
import {
  getSidebarRailLayout,
  getSidebarRailShortcutTargets,
  isCustomSidebarRailOrder,
  moveSidebarDestination,
  readPinnedSidebarDestinations,
  readSidebarRailOrder,
  shiftSidebarDestination,
  togglePinnedSidebarDestination,
  writePinnedSidebarDestinations,
  writeSidebarRailOrder,
  type SidebarDestination,
  type SidebarDestinationId,
} from "./sidebar-destinations";
import "./sidebar-rail.css";

export interface SidebarRailProps {
  activeId: SidebarDestinationId | null;
  /** Settings is open; its rail button reads as the current page. */
  settingsActive?: boolean;
  onNavigate: (id: SidebarDestinationId) => void;
  onOpenSettings: () => void;
  workspaceId?: string;
  updateAvailable?: boolean;
  /** False when this system can't install the update; it then only flags Settings. */
  updateSupported?: boolean;
  /** Opens Settings at the update. An installable update gets its own rail item. */
  onViewUpdate?: () => void;
  /** Test seams; the app reads pins and order from localStorage. */
  initialPinnedIds?: SidebarDestinationId[];
  initialRailOrder?: SidebarDestinationId[];
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

/** Fixed rail items and pinned items reorder separately. */
type RailGroup = "rail" | "pinned";

const RAIL_DRAG_TYPE = "application/x-cowork-rail-destination";

interface RailDrag {
  id: SidebarDestinationId;
  group: RailGroup;
}

interface RailDrop {
  id: SidebarDestinationId;
  position: "before" | "after";
}

interface RailShortcut {
  /** Shown in the tooltip, e.g. "⌘2" or "Ctrl+2". */
  label: string;
  /** For aria-keyshortcuts, e.g. "Meta+2". */
  keys: string;
}

function isMacPlatform(): boolean {
  if (typeof window === "undefined") return false;
  const platform = window.electronAPI?.getPlatform?.();
  if (platform) return platform === "darwin";
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

function railShortcut(index: number, mac: boolean): RailShortcut {
  const digit = index + 1;
  return mac
    ? { label: `⌘${digit}`, keys: `Meta+${digit}` }
    : { label: `Ctrl+${digit}`, keys: `Control+${digit}` };
}

function RailButton({
  destination,
  active,
  badge = 0,
  shortcut,
  dragging = false,
  drop = null,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onKeyboardMove,
}: {
  destination: SidebarDestination;
  active: boolean;
  badge?: number;
  shortcut?: RailShortcut;
  dragging?: boolean;
  drop?: RailDrop["position"] | null;
  onSelect: (id: SidebarDestinationId) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onKeyboardMove: (delta: -1 | 1) => void;
}) {
  const name = destination.label;
  return (
    <button
      type="button"
      className={`sidebar-rail-btn${active ? " active" : ""}${dragging ? " dragging" : ""}${
        drop ? ` drop-${drop}` : ""
      }`}
      onClick={() => onSelect(destination.id)}
      onKeyDown={(event) => {
        // Alt+↑/↓ is the keyboard way to reorder, alongside dragging.
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        onKeyboardMove(event.key === "ArrowUp" ? -1 : 1);
      }}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      aria-current={active ? "page" : undefined}
      aria-label={badge > 0 ? `${name}, ${badge} unread` : name}
      aria-keyshortcuts={shortcut?.keys}
      title={shortcut ? `${name} (${shortcut.label})` : name}
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
  settingsActive = false,
  onNavigate,
  onOpenSettings,
  workspaceId,
  updateAvailable = false,
  updateSupported = true,
  onViewUpdate,
  initialPinnedIds,
  initialRailOrder,
}: SidebarRailProps) {
  const isCalm = useIsCalmTheme();
  const isBrowserHost = typeof window !== "undefined" && window.coworkBrowserHost === true;
  const inboxUnreadCount = useInboxUnreadCount(workspaceId);
  const [pinnedIds, setPinnedIds] = useState<SidebarDestinationId[]>(
    () => initialPinnedIds ?? readPinnedSidebarDestinations(),
  );
  const [railOrder, setRailOrder] = useState<SidebarDestinationId[]>(
    () => initialRailOrder ?? readSidebarRailOrder(),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [drag, setDrag] = useState<RailDrag | null>(null);
  const [drop, setDrop] = useState<RailDrop | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  useDismissable(moreRef, moreOpen, closeMore);
  const mac = useMemo(isMacPlatform, []);

  const layout = useMemo(
    () => getSidebarRailLayout({ isCalm, isBrowserHost }, pinnedIds, railOrder),
    [isBrowserHost, isCalm, pinnedIds, railOrder],
  );
  const railIsCustom = isCustomSidebarRailOrder({ isCalm, isBrowserHost }, railOrder);
  const activeIsHiddenInMore =
    activeId !== null &&
    layout.more.some((item) => item.id === activeId) &&
    !pinnedIds.includes(activeId);

  const shortcutTargets = useMemo(() => getSidebarRailShortcutTargets(layout), [layout]);
  const shortcutFor = (id: SidebarDestinationId) => {
    const index = shortcutTargets.findIndex((destination) => destination.id === id);
    return index === -1 ? undefined : railShortcut(index, mac);
  };

  // ⌘1–⌘9 (Ctrl elsewhere) open the rail's destinations in the order shown.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!primary || event.altKey || event.shiftKey || event.defaultPrevented) return;
      // Leave the page behind an open dialog alone.
      if (document.querySelector('[aria-modal="true"]')) return;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      const target = digit ? shortcutTargets[Number(digit) - 1] : undefined;
      if (!target) return;
      event.preventDefault();
      onNavigate(target.id);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mac, onNavigate, shortcutTargets]);

  const handleTogglePin = (id: SidebarDestinationId) => {
    setPinnedIds((current) => {
      const next = togglePinnedSidebarDestination(current, id);
      writePinnedSidebarDestinations(next);
      return next;
    });
  };

  const groupIds = (group: RailGroup) =>
    (group === "rail" ? layout.rail : layout.pinned).map((destination) => destination.id);

  const applyGroupOrder = (group: RailGroup, next: SidebarDestinationId[]) => {
    if (group === "rail") {
      // An order moved back to the default is stored as no order.
      const stored = isCustomSidebarRailOrder({ isCalm, isBrowserHost }, next) ? next : [];
      setRailOrder(stored);
      writeSidebarRailOrder(stored);
    } else {
      setPinnedIds(next);
      writePinnedSidebarDestinations(next);
    }
  };

  const clearDrag = () => {
    setDrag(null);
    setDrop(null);
  };

  /** Drag and keyboard handlers for one item; items only move within their group. */
  const reorderProps = (destination: SidebarDestination, group: RailGroup) => ({
    dragging: drag?.id === destination.id,
    drop: drop?.id === destination.id ? drop.position : null,
    onDragStart: (event: DragEvent<HTMLButtonElement>) => {
      event.dataTransfer.effectAllowed = "move";
      // A private type, so text fields and other drop targets ignore the drag.
      event.dataTransfer.setData(RAIL_DRAG_TYPE, destination.id);
      setMoreOpen(false);
      setDrag({ id: destination.id, group });
    },
    onDragOver: (event: DragEvent<HTMLButtonElement>) => {
      if (!drag || drag.group !== group) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.getBoundingClientRect();
      const position: RailDrop["position"] =
        event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      const next: RailDrop | null =
        drag.id === destination.id ? null : { id: destination.id, position };
      if (next?.id !== drop?.id || next?.position !== drop?.position) setDrop(next);
    },
    onDrop: (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (drag && drop && drag.group === group) {
        applyGroupOrder(
          group,
          moveSidebarDestination(groupIds(group), drag.id, drop.id, drop.position),
        );
      }
      clearDrag();
    },
    onDragEnd: clearDrag,
    onKeyboardMove: (delta: -1 | 1) => {
      const ids = groupIds(group);
      const next = shiftSidebarDestination(ids, destination.id, delta);
      if (next.join() === ids.join()) return;
      applyGroupOrder(group, next);
      // React moves the node, which can drop focus; keep it on the moved item.
      requestAnimationFrame(() => {
        navRef.current
          ?.querySelector<HTMLButtonElement>(`[data-destination="${destination.id}"]`)
          ?.focus();
      });
    },
  });

  const resetRailOrder = () => {
    setRailOrder([]);
    writeSidebarRailOrder([]);
    setMoreOpen(false);
  };

  const badgeFor = (id: SidebarDestinationId) => (id === "inbox" ? inboxUnreadCount : 0);
  const showUpdateItem = updateAvailable && updateSupported && Boolean(onViewUpdate);
  const flagSettings = updateAvailable && !showUpdateItem;

  return (
    <nav className="sidebar-rail" aria-label="Main" ref={navRef}>
      {layout.rail.map((destination) => (
        <RailButton
          key={destination.id}
          destination={destination}
          active={destination.id === activeId}
          badge={badgeFor(destination.id)}
          shortcut={shortcutFor(destination.id)}
          onSelect={onNavigate}
          {...reorderProps(destination, "rail")}
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
              {railIsCustom && (
                <>
                  <div className="sidebar-rail-menu-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="sidebar-workspace-menu-option"
                    onClick={resetRailOrder}
                  >
                    <RotateCcw size={16} />
                    <span>Reset sidebar order</span>
                  </button>
                </>
              )}
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
              shortcut={shortcutFor(destination.id)}
              onSelect={onNavigate}
              {...reorderProps(destination, "pinned")}
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
        className={`sidebar-rail-btn${settingsActive ? " active" : ""}`}
        onClick={onOpenSettings}
        aria-current={settingsActive ? "page" : undefined}
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
          active={settingsActive}
          dot={flagSettings ? "update" : undefined}
        />
      </button>
    </nav>
  );
}

export const SidebarRail = memo(SidebarRailComponent);
