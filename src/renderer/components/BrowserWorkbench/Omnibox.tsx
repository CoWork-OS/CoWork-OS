import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Globe2, History, Laptop, Lock, Search, ShieldAlert, ShieldOff } from "lucide-react";
import {
  type OmniboxSource,
  type OmniboxSuggestion,
  SEARCH_ENGINES,
  type SearchEngineId,
  buildOmniboxSuggestions,
  displayUrl,
  isSearchEngineId,
  parseOmniboxInput,
  securityStateFor,
} from "./omnibox-input";
import { zoomLevelToPercent } from "./browser-zoom";

export type OmniboxHandle = { focusAndSelect: () => void };

type OmniboxProps = {
  url: string;
  blocked: boolean;
  zoomLevel: number;
  engine: SearchEngineId;
  source: OmniboxSource;
  onNavigate: (url: string) => void;
  onSwitchTab: (tabId: string) => void;
  onUnsupported: (scheme: string) => void;
  onResetZoom: () => void;
  onEngineChange: (engine: SearchEngineId) => void;
  onNotice: (message: string) => void;
  /** Typed text, for loading history matches into `source`. */
  onQueryChange?: (text: string) => void;
};

/** Address bar: URL or search, suggestions from open tabs and recent pages, security chip, zoom badge. */
export const Omnibox = forwardRef<OmniboxHandle, OmniboxProps>(function Omnibox(
  {
    url,
    blocked,
    zoomLevel,
    engine,
    source,
    onNavigate,
    onSwitchTab,
    onUnsupported,
    onResetZoom,
    onEngineChange,
    onNotice,
    onQueryChange,
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);

  useImperativeHandle(ref, () => ({
    focusAndSelect: () => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    },
  }));

  const suggestions = useMemo<OmniboxSuggestion[]>(
    () => (editing && open ? buildOmniboxSuggestions(text, source, engine) : []),
    [editing, engine, open, source, text],
  );

  const commit = (suggestion?: OmniboxSuggestion) => {
    setOpen(false);
    setEditing(false);
    inputRef.current?.blur();
    if (suggestion?.kind === "switch-tab") {
      onSwitchTab(suggestion.tabId);
      return;
    }
    if (suggestion) {
      onNavigate(suggestion.url);
      return;
    }
    const intent = parseOmniboxInput(text, engine);
    if (intent.kind === "url" || intent.kind === "search") onNavigate(intent.url);
    else if (intent.kind === "unsupported") onUnsupported(intent.scheme);
  };

  const security = blocked ? "blocked" : securityStateFor(url);
  const SecurityIcon =
    security === "secure"
      ? Lock
      : security === "insecure"
        ? ShieldAlert
        : security === "blocked"
          ? ShieldOff
          : security === "local"
            ? Laptop
            : Globe2;
  const securityLabel =
    security === "secure"
      ? "Connection is secure"
      : security === "insecure"
        ? "Not secure"
        : security === "blocked"
          ? "Blocked by access settings"
          : security === "local"
            ? "Local page"
            : "";
  const zoomPercent = zoomLevelToPercent(zoomLevel);

  return (
    <form
      className="browser-workbench-url-form browser-workbench-omnibox"
      onSubmit={(event) => {
        event.preventDefault();
        commit(suggestions[highlight] && highlight > 0 ? suggestions[highlight] : undefined);
      }}
    >
      {url && (
        <button
          type="button"
          className={`browser-workbench-security is-${security}`}
          title={`${securityLabel ? `${securityLabel}. ` : ""}Click to copy the address`}
          aria-label={`${securityLabel || "Page"}: copy address`}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(url)
              .then(() => onNotice("Address copied"))
              .catch(() => onNotice("Copy failed"));
          }}
        >
          <SecurityIcon size={13} aria-hidden="true" />
          {security === "insecure" && <span>Not secure</span>}
        </button>
      )}
      <input
        ref={inputRef}
        value={editing ? text : displayUrl(url)}
        onChange={(event) => {
          setText(event.target.value);
          setHighlight(0);
          setOpen(true);
          onQueryChange?.(event.target.value);
        }}
        onFocus={(event) => {
          // Returning from the engine picker keeps what was typed.
          if (editing) return;
          setEditing(true);
          setText(url);
          setHighlight(0);
          const input = event.currentTarget;
          requestAnimationFrame(() => input.select());
        }}
        onBlur={(event) => {
          // Focus moving to the engine picker in the list keeps the list open.
          const next = event.relatedTarget as Node | null;
          if (next && event.currentTarget.form?.contains(next)) return;
          setEditing(false);
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (open && suggestions.length > 0) {
              setOpen(false);
            } else {
              setText(url);
              event.currentTarget.blur();
            }
          } else if (event.key === "ArrowDown" && suggestions.length > 0) {
            event.preventDefault();
            setHighlight((current) => (current + 1) % suggestions.length);
          } else if (event.key === "ArrowUp" && suggestions.length > 0) {
            event.preventDefault();
            setHighlight((current) => (current - 1 + suggestions.length) % suggestions.length);
          }
        }}
        placeholder={`Search ${SEARCH_ENGINES[engine].label} or enter address`}
        aria-label="Browser URL"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      {zoomPercent !== 100 && (
        <button
          type="button"
          className="browser-workbench-zoom-badge"
          title="Reset zoom"
          onClick={onResetZoom}
        >
          {zoomPercent}%
        </button>
      )}
      {suggestions.length > 0 && (
        <div className="browser-workbench-suggestions" role="listbox">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.id}
              type="button"
              role="option"
              aria-selected={index === highlight}
              className={`browser-workbench-suggestion ${index === highlight ? "is-highlighted" : ""}`}
              // Keep focus in the input so blur doesn't close the list before the click.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => commit(suggestion)}
            >
              <span className="browser-workbench-suggestion-icon" aria-hidden="true">
                {suggestion.kind === "search" ? (
                  <Search size={13} />
                ) : suggestion.kind === "page" ? (
                  <History size={13} />
                ) : (
                  <Globe2 size={13} />
                )}
              </span>
              <span className="browser-workbench-suggestion-label">{suggestion.label}</span>
              {suggestion.kind === "switch-tab" && (
                <span className="browser-workbench-suggestion-detail">Switch to tab</span>
              )}
              {suggestion.kind === "page" && (
                <span className="browser-workbench-suggestion-detail">
                  {displayUrl(suggestion.detail)}
                </span>
              )}
            </button>
          ))}
          <label
            className="browser-workbench-suggestions-footer"
            onMouseDown={(event) => event.stopPropagation()}
          >
            Search engine
            <select
              value={engine}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => {
                if (isSearchEngineId(event.target.value)) onEngineChange(event.target.value);
                inputRef.current?.focus();
              }}
              onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                if (next && event.currentTarget.form?.contains(next)) return;
                setEditing(false);
                setOpen(false);
              }}
            >
              {Object.entries(SEARCH_ENGINES).map(([id, entry]) => (
                <option key={id} value={id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </form>
  );
});
