import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowRight,
  MessageSquare,
  Search,
  Settings as SettingsIcon,
  TextSearch,
} from "lucide-react";
import type { Task, UnifiedRecallResult } from "../../../shared/types";
import { ModalDialog } from "../ModalDialog";
import {
  COMMAND_MENU_SCOPES,
  MIN_MESSAGE_QUERY_LENGTH,
  buildCommandMenuSections,
  buildSettingsIndex,
  flattenCommandMenuSections,
  moveCommandMenuSelection,
  normalizeCommandMenuQuery,
  type CommandMenuAction,
  type CommandMenuActionSpec,
  type CommandMenuItem,
  type CommandMenuScope,
  type CommandMenuSettingsEntry,
} from "./command-menu-model";
import "./command-menu.css";

const MESSAGE_SEARCH_DELAY_MS = 250;
const MESSAGE_SEARCH_LIMIT = 30;
const LIST_ID = "command-menu-list";

export interface CommandMenuProps {
  /** Sessions already loaded in the app. */
  tasks: readonly Task[];
  /** Message search covers this workspace. Without one the Messages scope stays empty. */
  workspaceId?: string;
  actions: readonly CommandMenuActionSpec[];
  /** Settings sections, for hosts that already have them. Loaded on open otherwise. */
  settingsIndex?: readonly CommandMenuSettingsEntry[];
  onClose: () => void;
  onRunAction: (action: CommandMenuAction) => void;
  onOpenSession: (taskId: string) => void;
  /** A message hit may be in a session that is not loaded yet. */
  onOpenMessageHit: (taskId: string) => void;
  onOpenSettingsTab: (tab: string) => void;
}

function ItemIcon({ kind }: { kind: CommandMenuItem["kind"] }) {
  const props = { size: 15, strokeWidth: 1.75 } as const;
  if (kind === "session") return <MessageSquare {...props} />;
  if (kind === "setting") return <SettingsIcon {...props} />;
  if (kind === "message") return <TextSearch {...props} />;
  return <ArrowRight {...props} />;
}

/**
 * One search box over actions, loaded sessions, Settings sections and message text.
 * Arrow keys move, Enter runs the selected row, Escape closes.
 */
export function CommandMenu({
  tasks,
  workspaceId,
  actions,
  settingsIndex: providedSettingsIndex,
  onClose,
  onRunAction,
  onOpenSession,
  onOpenMessageHit,
  onOpenSettingsTab,
}: CommandMenuProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<CommandMenuScope>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [loadedSettingsIndex, setLoadedSettingsIndex] = useState<
    readonly CommandMenuSettingsEntry[]
  >([]);
  const [messages, setMessages] = useState<readonly UnifiedRecallResult[]>([]);
  const [searchingMessages, setSearchingMessages] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const settingsIndex = providedSettingsIndex ?? loadedSettingsIndex;

  // The Settings section list lives in the lazily loaded Settings chunk.
  useEffect(() => {
    if (providedSettingsIndex) return;
    let cancelled = false;
    void import("../Settings")
      .then((module) => {
        if (cancelled) return;
        const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
        setLoadedSettingsIndex(
          buildSettingsIndex(module.settingsSidebarItems, module.sidebarSearchEntries, isMac),
        );
      })
      .catch(() => {
        // The menu still works without the Settings rows.
      });
    return () => {
      cancelled = true;
    };
  }, [providedSettingsIndex]);

  const normalizedQuery = normalizeCommandMenuQuery(query);
  const wantsMessages = scope === "all" || scope === "messages";
  const canSearchMessages =
    wantsMessages &&
    !!workspaceId &&
    normalizedQuery.length >= MIN_MESSAGE_QUERY_LENGTH &&
    typeof window !== "undefined" &&
    typeof window.electronAPI?.queryUnifiedRecall === "function";

  useEffect(() => {
    if (!canSearchMessages || !workspaceId) {
      setMessages([]);
      setSearchingMessages(false);
      return;
    }
    let cancelled = false;
    setSearchingMessages(true);
    const timer = setTimeout(() => {
      void window.electronAPI
        .queryUnifiedRecall({
          workspaceId,
          query: normalizedQuery,
          limit: MESSAGE_SEARCH_LIMIT,
          sourceTypes: ["message", "conversation"],
        })
        .then((response) => {
          if (!cancelled) setMessages(response?.results ?? []);
        })
        .catch(() => {
          if (!cancelled) setMessages([]);
        })
        .finally(() => {
          if (!cancelled) setSearchingMessages(false);
        });
    }, MESSAGE_SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canSearchMessages, normalizedQuery, workspaceId]);

  const sections = useMemo(
    () =>
      buildCommandMenuSections({ scope, query, actions, tasks, settings: settingsIndex, messages }),
    [scope, query, actions, tasks, settingsIndex, messages],
  );
  const items = useMemo(() => flattenCommandMenuSections(sections), [sections]);
  const selectedIndex = Math.min(activeIndex, Math.max(items.length - 1, 0));
  const selectedItem = items[selectedIndex];

  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedQuery, scope]);

  useEffect(() => {
    if (!selectedItem) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(selectedItem.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedItem]);

  const runItem = (item: CommandMenuItem) => {
    if (item.kind === "action") onRunAction(item.action);
    else if (item.kind === "session") onOpenSession(item.taskId);
    else if (item.kind === "message") onOpenMessageHit(item.taskId);
    else onOpenSettingsTab(item.tab);
    onClose();
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        moveCommandMenuSelection(selectedIndex, event.key === "ArrowDown" ? 1 : -1, items.length),
      );
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (selectedItem) runItem(selectedItem);
    }
  };

  const emptyText =
    searchingMessages && wantsMessages
      ? "Searching messages…"
      : scope === "messages" && !workspaceId
        ? "Open a workspace to search its messages."
        : scope === "messages" && normalizedQuery.length < MIN_MESSAGE_QUERY_LENGTH
          ? `Type at least ${MIN_MESSAGE_QUERY_LENGTH} characters to search messages.`
          : "No results";

  return (
    <div
      className="command-menu-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <ModalDialog className="command-menu" aria-label="Command menu" onClose={onClose}>
        <div className="command-menu-input-row">
          <span className="command-menu-input-icon" aria-hidden="true">
            <Search size={16} strokeWidth={1.75} />
          </span>
          <input
            className="command-menu-input"
            type="text"
            role="combobox"
            aria-label="Search sessions, actions, settings and messages"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-activedescendant={selectedItem ? `command-menu-${selectedItem.id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search sessions, actions, settings and messages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
        </div>

        <div className="command-menu-list" id={LIST_ID} role="listbox" ref={listRef}>
          {sections.map((section) => (
            <div
              key={section.id}
              className="command-menu-section"
              role="group"
              aria-label={section.label}
            >
              <div className="command-menu-section-label" aria-hidden="true">
                {section.label}
              </div>
              {section.items.map((item) => {
                const selected = item.id === selectedItem?.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    id={`command-menu-${item.id}`}
                    data-item-id={item.id}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    className={`command-menu-item${selected ? " is-selected" : ""}`}
                    onMouseMove={() => {
                      const index = items.indexOf(item);
                      if (index >= 0 && index !== selectedIndex) setActiveIndex(index);
                    }}
                    onClick={() => runItem(item)}
                  >
                    <span className="command-menu-item-icon" aria-hidden="true">
                      <ItemIcon kind={item.kind} />
                    </span>
                    <span className="command-menu-item-text">
                      <span className="command-menu-item-title">{item.title}</span>
                      {item.subtitle && (
                        <span className="command-menu-item-subtitle">{item.subtitle}</span>
                      )}
                    </span>
                    {item.kind === "action" && item.shortcut && (
                      <kbd className="command-menu-item-shortcut">{item.shortcut}</kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {items.length === 0 && <div className="command-menu-empty">{emptyText}</div>}
        </div>

        <div className="command-menu-scopes" role="tablist" aria-label="Search scope">
          {COMMAND_MENU_SCOPES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={scope === entry.id}
              className={`command-menu-scope${scope === entry.id ? " is-active" : ""}`}
              onClick={() => setScope(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </ModalDialog>
    </div>
  );
}
