import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import type { BrowserFindResult } from "./BrowserTabView";

export type FindBarHandle = { focus: () => void; findNext: (forward: boolean) => void };

type FindBarProps = {
  result: BrowserFindResult | null;
  onFind: (
    text: string,
    options: { forward: boolean; findNext: boolean; matchCase: boolean },
  ) => void;
  onClose: () => void;
};

/** Find in page: match count, next/previous, match case. Esc closes and clears highlights. */
export const FindBar = forwardRef<FindBarHandle, FindBarProps>(function FindBar(
  { result, onFind, onClose },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [matchCase, setMatchCase] = useState(false);

  /** `followUp` moves to the next/previous match; otherwise a new search starts. */
  const find = (forward: boolean, followUp: boolean, nextText = text, nextCase = matchCase) => {
    // Electron's findNext means "start a new find session": true for the first request.
    if (nextText) onFind(nextText, { forward, findNext: !followUp, matchCase: nextCase });
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
    findNext: (forward) => find(forward, true),
  }));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const count =
    text && result ? `${result.matches ? result.activeMatchOrdinal : 0} of ${result.matches}` : "";

  return (
    <div className="browser-workbench-findbar" role="search">
      <input
        ref={inputRef}
        value={text}
        placeholder="Find in page"
        aria-label="Find in page"
        onChange={(event) => {
          setText(event.target.value);
          find(true, false, event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            find(!event.shiftKey, true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="browser-workbench-findbar-count" aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className={matchCase ? "is-active" : ""}
        title="Match case"
        aria-pressed={matchCase}
        onClick={() => {
          setMatchCase((current) => !current);
          find(true, false, text, !matchCase);
        }}
      >
        <CaseSensitive size={14} aria-hidden="true" />
      </button>
      <button type="button" title="Previous match" onClick={() => find(false, true)}>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button type="button" title="Next match" onClick={() => find(true, true)}>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" title="Close find bar" onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
});
