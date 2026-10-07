import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { Check, ChevronDown, ChevronRight, Copy, SquareTerminal, X } from "lucide-react";
import type { CommandOutputStyle } from "../../shared/types";

const DIR_NAME_MAX_LEN = 12;
const DEFAULT_VISIBLE_OUTPUT_LINES = 300;
/** How long the copy buttons show their "Copied" confirmation. */
const COPY_CONFIRM_MS = 1500;

function getDirName(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function truncateDirName(name: string): string {
  if (name.length <= DIR_NAME_MAX_LEN) return name;
  return name.slice(0, DIR_NAME_MAX_LEN) + "...";
}

/** Icon button that copies text, with a tooltip naming what it copies. */
function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={`command-shell-copy${copied ? " copied" : ""}`}
      aria-label={label}
      data-tooltip={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // Clipboard access can be refused; the button simply stays as it was.
        }
      }}
    >
      {copied ? (
        <Check size={13} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
      )}
    </button>
  );
}

interface CommandOutputProps {
  command: string;
  output: string;
  isRunning: boolean;
  exitCode?: number | null;
  cwd?: string;
  taskId?: string;
  onClose?: () => void;
  /** "terminal" (default) renders the classic window; "minimal" renders a compact shell card. */
  variant?: CommandOutputStyle;
}

export function CommandOutput({
  command,
  output,
  isRunning,
  exitCode,
  cwd,
  taskId,
  onClose,
  variant = "terminal",
}: CommandOutputProps) {
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [stdinInput, setStdinInput] = useState("");
  const [stopClicked, setStopClicked] = useState(false);
  const [shellScroll, setShellScroll] = useState({ overflowing: false, atBottom: true });
  // A finished command opens folded to its "Ran <command>" line; a running one
  // opens so its Stop control is reachable.
  const [shellCollapsed, setShellCollapsed] = useState(() => !isRunning);
  const isMinimal = variant === "minimal";

  // The shell card fades its bottom edge while more output sits below.
  const updateShellScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    const overflowing = el.scrollHeight > el.clientHeight + 1;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    setShellScroll((prev) =>
      prev.overflowing === overflowing && prev.atBottom === atBottom
        ? prev
        : { overflowing, atBottom },
    );
  }, []);

  // Auto-scroll to bottom when new output arrives. A finished command in the
  // shell card opens at the top of its output, like a transcript.
  useEffect(() => {
    if (autoScroll && outputRef.current && (!isMinimal || isRunning)) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
    if (isMinimal) updateShellScroll();
  }, [output, autoScroll, isMinimal, isRunning, updateShellScroll]);

  // Detect manual scrolling
  const handleScroll = () => {
    if (!outputRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
    // If user is near the bottom (within 50px), enable auto-scroll
    const nearBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(nearBottom);
    if (isMinimal) updateShellScroll();
  };

  // Send stdin input to the running command
  const sendInput = useCallback(async () => {
    if (!taskId || !stdinInput || !isRunning) return;

    try {
      // Append newline to simulate pressing Enter
      const inputWithNewline = stdinInput + "\n";
      await window.electronAPI.sendStdin(taskId, inputWithNewline);
      setStdinInput("");
    } catch (error) {
      console.error("Failed to send stdin:", error);
    }
  }, [taskId, stdinInput, isRunning]);

  // Kill the running command (Ctrl+C) - graceful stop
  const killCommand = useCallback(async () => {
    if (!taskId || !isRunning) return;

    try {
      setStopClicked(true);
      await window.electronAPI.killCommand(taskId, false);
    } catch (error) {
      console.error("Failed to kill command:", error);
    }
  }, [taskId, isRunning]);

  // Force kill the running command (SIGKILL) - immediate termination
  const forceKillCommand = useCallback(async () => {
    if (!taskId || !isRunning) return;

    try {
      await window.electronAPI.killCommand(taskId, true);
    } catch (error) {
      console.error("Failed to force kill command:", error);
    }
  }, [taskId, isRunning]);

  // Reset stopClicked when command finishes
  useEffect(() => {
    if (!isRunning) {
      setStopClicked(false);
    }
  }, [isRunning]);

  // Handle Enter key in input field
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendInput();
    }
  };

  // Determine status indicator
  const dirName = cwd ? truncateDirName(getDirName(cwd)) : "";
  const fullDirName = cwd ? getDirName(cwd) : "";

  // Ensure first line shows folder prefix (e.g. "$ todo-app % ") when cwd is known
  const displayOutput = (() => {
    if (!fullDirName || !output) return output;
    const prefix = `$ ${fullDirName} % `;
    if (output.startsWith("$ ") && !output.startsWith(prefix)) {
      return prefix + output.slice(2);
    }
    return output;
  })();
  const visibleOutput = (() => {
    const lines = displayOutput.split("\n");
    if (isRunning || lines.length <= DEFAULT_VISIBLE_OUTPUT_LINES) return displayOutput;
    const omitted = lines.length - DEFAULT_VISIBLE_OUTPUT_LINES;
    return [
      `[... ${omitted} earlier line${omitted === 1 ? "" : "s"} hidden ...]`,
      ...lines.slice(-DEFAULT_VISIBLE_OUTPUT_LINES),
    ].join("\n");
  })();

  // The shell card shows the raw command output (no shell prompt chrome) in
  // full; its body scrolls under the pinned command. The stream opens with an
  // echo of the prompt and command ("$ dir % cmd"), which the pinned command
  // already shows, so that line is dropped.
  const shell = useMemo(() => {
    let text = output.replace(/\n+$/, "");
    const firstBreak = text.indexOf("\n");
    const firstLine = firstBreak === -1 ? text : text.slice(0, firstBreak);
    if (firstLine.startsWith("$ ") && firstLine.trimEnd().endsWith(command.trim())) {
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }
    return { text };
  }, [output, command]);

  const getStatusIndicator = () => {
    if (isRunning) {
      return <span className="command-status running">Running...</span>;
    }
    if (exitCode === 0) {
      return <span className="command-status success">Exit: 0</span>;
    }
    if (exitCode !== null && exitCode !== undefined) {
      return <span className="command-status error">Exit: {exitCode}</span>;
    }
    return null;
  };

  if (isMinimal) {
    const failed = !isRunning && exitCode !== null && exitCode !== undefined && exitCode !== 0;
    const succeeded = !isRunning && exitCode === 0;
    const statusClass = isRunning ? "running" : failed ? "error" : "success";
    const hasOutput = shell.text.length > 0;
    const commandLine = command.trim().split("\n")[0] ?? "";

    return (
      <div className={`command-output-minimal command-shell ${statusClass}`}>
        {/* What the agent ran, in the timeline's words; it folds the card. */}
        <button
          type="button"
          className="command-shell-summary"
          onClick={() => setShellCollapsed((prev) => !prev)}
          aria-expanded={!shellCollapsed}
          title={command}
        >
          <SquareTerminal size={15} strokeWidth={1.8} aria-hidden="true" />
          <span className="command-shell-summary-text">
            {isRunning ? "Running" : "Ran"}{" "}
            <span className="command-shell-summary-command">{commandLine}</span>
          </span>
          {shellCollapsed ? (
            <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
          )}
        </button>

        {!shellCollapsed && (
          <div className="command-shell-card">
            <div className="command-shell-header">
              <span className="command-shell-label">Shell</span>
              {cwd && (
                <span className="command-shell-cwd" title={cwd}>
                  {dirName}
                </span>
              )}
              <div className="command-shell-actions">
                {isRunning && taskId && !stopClicked && (
                  <button
                    type="button"
                    className="command-shell-action"
                    onClick={killCommand}
                    title="Stop command (Ctrl+C)"
                  >
                    Stop
                  </button>
                )}
                {isRunning && taskId && stopClicked && (
                  <button
                    type="button"
                    className="command-shell-action"
                    onClick={forceKillCommand}
                    title="Force kill (SIGKILL) - immediate termination"
                  >
                    Force kill
                  </button>
                )}
                {!isRunning && onClose && (
                  <button
                    type="button"
                    className="command-shell-action command-shell-close"
                    onClick={onClose}
                    title="Close output"
                    aria-label="Close output"
                  >
                    <X size={13} strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            {/* The command stays put; only the output below it scrolls. */}
            <div className="command-shell-command">
              <pre>
                <span className="command-shell-prompt" aria-hidden="true">
                  ${" "}
                </span>
                {command}
              </pre>
              <CopyTextButton text={command} label="Copy command" />
            </div>

            {(hasOutput || isRunning) && (
              <div className="command-shell-output">
                <div
                  ref={outputRef}
                  className={`command-shell-scroll${shellScroll.overflowing && !shellScroll.atBottom ? " has-more" : ""}`}
                  onScroll={handleScroll}
                >
                  <pre>{hasOutput ? shell.text : "Waiting for output…"}</pre>
                </div>
                {hasOutput && <CopyTextButton text={shell.text} label="Copy output" />}
              </div>
            )}

            {(isRunning || failed || succeeded) && (
              <div className={`command-shell-status ${statusClass}`}>
                {isRunning ? (
                  <>
                    <span className="command-shell-status-dot" aria-hidden="true" />
                    Running
                  </>
                ) : failed ? (
                  <>
                    <X size={13} strokeWidth={2} aria-hidden="true" />
                    Exit {exitCode}
                  </>
                ) : (
                  <>
                    <Check size={13} strokeWidth={2} aria-hidden="true" />
                    Success
                  </>
                )}
              </div>
            )}

            {isRunning && taskId && (
              <div className="command-shell-stdin">
                <span className="command-shell-stdin-prompt" aria-hidden="true">
                  &gt;
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  className="command-shell-stdin-input"
                  placeholder="Type input and press Enter..."
                  value={stdinInput}
                  onChange={(e) => setStdinInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="command-output-container">
      <div className="command-output-header">
        <div className="command-output-title">
          <div className="command-window-controls" aria-hidden="true">
            <span className="command-window-dot close" />
            <span className="command-window-dot minimize" />
            <span className="command-window-dot zoom" />
          </div>
          <span className="command-prompt-glyph" aria-hidden="true">
            &gt;_
          </span>
          <span className="command-text" title={command}>
            {command}
          </span>
          {cwd && (
            <span className="command-cwd" title={cwd}>
              {dirName}
            </span>
          )}
        </div>
        <div className="command-output-actions">
          {isRunning && taskId && !stopClicked && (
            <button
              className="command-stop-btn"
              onClick={killCommand}
              title="Stop command (Ctrl+C)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
              Stop
            </button>
          )}
          {isRunning && taskId && stopClicked && (
            <>
              <span className="command-stopping">Stopping...</span>
              <button
                className="command-force-kill-btn"
                onClick={forceKillCommand}
                title="Force kill (SIGKILL) - immediate termination"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Force Kill
              </button>
            </>
          )}
          {getStatusIndicator()}
          {/* Close button - only show when not running */}
          {!isRunning && onClose && (
            <button className="command-close-btn" onClick={onClose} title="Close output">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              Close output
            </button>
          )}
        </div>
      </div>
      <div ref={outputRef} className="command-output-content" onScroll={handleScroll}>
        <pre>
          {isRunning
            ? visibleOutput || "Waiting for output..."
            : (visibleOutput || "") +
              (visibleOutput.endsWith("\n") ? "" : "\n") +
              `$ ${dirName ? dirName + " " : ""}%`}
        </pre>
      </div>
      {!autoScroll && isRunning && (
        <button
          className="command-scroll-to-bottom"
          onClick={() => {
            setAutoScroll(true);
            if (outputRef.current) {
              outputRef.current.scrollTop = outputRef.current.scrollHeight;
            }
          }}
        >
          Scroll to bottom
        </button>
      )}
      {/* Input field for interactive commands */}
      {isRunning && taskId && (
        <div className="command-stdin-container">
          <span className="command-stdin-prompt">&gt;</span>
          <input
            ref={inputRef}
            type="text"
            className="command-stdin-input"
            placeholder="Type input and press Enter..."
            value={stdinInput}
            onChange={(e) => setStdinInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="command-stdin-send"
            onClick={sendInput}
            disabled={!stdinInput}
            title="Send input (Enter)"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
