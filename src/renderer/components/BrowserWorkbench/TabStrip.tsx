import { useEffect, useRef, useState } from "react";
import { Globe, Pin, Plus, Volume2, VolumeX, X } from "lucide-react";
import type { BrowserTab } from "./browser-tabs-model";

export type TabMenuCommand =
  | "new-tab-right"
  | "reload"
  | "duplicate"
  | "toggle-pin"
  | "toggle-mute"
  | "close"
  | "close-others"
  | "close-right"
  | "reopen-closed";

type TabStripProps = {
  tabs: BrowserTab[];
  activeTabId: string;
  canReopenClosed: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
  onMove: (tabId: string, toIndex: number) => void;
  onMenuCommand: (tabId: string, command: TabMenuCommand) => void;
};

function browserTabLabel(tab: Pick<BrowserTab, "url" | "title">): string {
  if (tab.title) return tab.title;
  if (!tab.url) return "New tab";
  try {
    return new URL(tab.url).hostname || tab.url;
  } catch {
    return tab.url;
  }
}

type MenuState = { tabId: string; x: number; y: number } | null;

/** Workbench tab strip: favicons, loading and audio state, pinning, reordering and a tab menu. */
export function TabStrip({
  tabs,
  activeTabId,
  canReopenClosed,
  onActivate,
  onClose,
  onNewTab,
  onMove,
  onMenuCommand,
}: TabStripProps) {
  const [menu, setMenu] = useState<MenuState>(null);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Keep the active tab in view when the strip overflows.
  useEffect(() => {
    const strip = stripRef.current;
    const active = strip?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const menuTab = menu ? tabs.find((tab) => tab.id === menu.tabId) : undefined;
  const menuIndex = menuTab ? tabs.indexOf(menuTab) : -1;
  const runMenu = (command: TabMenuCommand) => {
    if (menu) onMenuCommand(menu.tabId, command);
    setMenu(null);
  };

  return (
    <div className="browser-workbench-tabs" role="tablist" aria-label="Browser tabs" ref={stripRef}>
      {tabs.map((tab, index) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className={`browser-workbench-tab-shell ${active ? "is-active" : ""} ${
              tab.pinned ? "is-pinned" : ""
            } ${dragTabId === tab.id ? "is-dragging" : ""} ${
              dropIndex === index && dragTabId && dragTabId !== tab.id ? "is-drop-target" : ""
            }`}
            draggable
            onDragStart={(event) => {
              setDragTabId(tab.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.url || "");
            }}
            onDragOver={(event) => {
              if (!dragTabId) return;
              event.preventDefault();
              setDropIndex(index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragTabId && dragTabId !== tab.id) onMove(dragTabId, index);
              setDragTabId(null);
              setDropIndex(null);
            }}
            onDragEnd={() => {
              setDragTabId(null);
              setDropIndex(null);
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              // Fixed to the viewport so the strip's overflow never clips the menu.
              setMenu({
                tabId: tab.id,
                x: Math.min(event.clientX, window.innerWidth - 220),
                y: Math.min(event.clientY, window.innerHeight - 320),
              });
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="browser-workbench-tab"
              title={tab.title || tab.url || "New tab"}
              onClick={() => onActivate(tab.id)}
            >
              <span
                className={`browser-workbench-tab-icon ${tab.loading ? "is-loading" : ""}`}
                aria-hidden="true"
              >
                {tab.loading ? null : tab.favicon ? (
                  <img src={tab.favicon} alt="" draggable={false} />
                ) : (
                  <Globe size={13} strokeWidth={2} />
                )}
              </span>
              {!tab.pinned && (
                <span className="browser-workbench-tab-label">{browserTabLabel(tab)}</span>
              )}
              {(tab.audible || tab.muted) && (
                <span
                  className="browser-workbench-tab-audio"
                  title={tab.muted ? "Muted" : "Playing audio"}
                >
                  {tab.muted ? (
                    <VolumeX size={12} aria-label="Muted" />
                  ) : (
                    <Volume2 size={12} aria-label="Playing audio" />
                  )}
                </span>
              )}
            </button>
            {!tab.pinned && tabs.length > 1 && (
              <button
                type="button"
                className="browser-workbench-tab-close"
                aria-label="Close tab"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="browser-workbench-tab-add"
        title="New tab"
        aria-label="New tab"
        onClick={onNewTab}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      {menu && menuTab && (
        <div
          className="browser-workbench-tab-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => runMenu("new-tab-right")}>
            New tab to the right
          </button>
          <div className="browser-workbench-tab-menu-separator" />
          <button
            type="button"
            role="menuitem"
            disabled={!menuTab.url}
            onClick={() => runMenu("reload")}
          >
            Reload
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!menuTab.url}
            onClick={() => runMenu("duplicate")}
          >
            Duplicate
          </button>
          <button type="button" role="menuitem" onClick={() => runMenu("toggle-pin")}>
            {menuTab.pinned ? (
              "Unpin"
            ) : (
              <>
                <Pin size={12} aria-hidden="true" /> Pin
              </>
            )}
          </button>
          <button type="button" role="menuitem" onClick={() => runMenu("toggle-mute")}>
            {menuTab.muted ? "Unmute site" : "Mute site"}
          </button>
          <div className="browser-workbench-tab-menu-separator" />
          <button type="button" role="menuitem" onClick={() => runMenu("close")}>
            Close
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={tabs.length <= 1}
            onClick={() => runMenu("close-others")}
          >
            Close other tabs
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={menuIndex >= tabs.length - 1}
            onClick={() => runMenu("close-right")}
          >
            Close tabs to the right
          </button>
          <div className="browser-workbench-tab-menu-separator" />
          <button
            type="button"
            role="menuitem"
            disabled={!canReopenClosed}
            onClick={() => runMenu("reopen-closed")}
          >
            Reopen closed tab
          </button>
        </div>
      )}
    </div>
  );
}
