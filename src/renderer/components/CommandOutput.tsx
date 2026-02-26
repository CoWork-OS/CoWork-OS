import { useRef, useEffect, useState, useCallback } from "react";

interface CommandOutputProps {
  command: string;
  output: string;
  isRunning: boolean;
  exitCode?: number | null;
  taskId?: string;
  onClose?: () => void;
}

export function CommandOutput({
  command,
  output,
  isRunning,
  exitCode,
  taskId,
  onClose,
}: CommandOutputProps) {
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [stdinInput, setStdinInput] = useState("");
  const [stopClicked, setStopClicked] = useState(false);

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (autoScroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, autoScroll]);

  // Detect manual scrolling
  const handleScroll = () => {
    if (!outputRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
    // If user is near the bottom (within 50px), enable auto-scroll
    const nearBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(nearBottom);
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

  return (
    <div className="command-output-container">
      <div className="command-output-header">
        <div className="command-output-title">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M4 17l6-6-6-6M12 19h8" />
          </svg>
          <span className="command-text">{command}</span>
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
        <pre>{output || (isRunning ? "Waiting for output..." : "")}</pre>
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
