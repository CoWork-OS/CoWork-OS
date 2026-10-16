import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Copy, Play, SquareTerminal, X } from "lucide-react";
import { ansiToLines, type AnsiSpan } from "../utils/ansi-lines";
import {
  extractRunnableCommand,
  startCodeBlockRun,
  stopCodeBlockRun,
  useCodeBlockRun,
  type CodeBlockRunScope,
} from "../utils/code-block-runs";
import { LazyHighlightedCodeBlock } from "./lazy-renderers";
import "./runnable-code-block.css";

const COPY_CONFIRM_MS = 1500;

function spanClassName(span: AnsiSpan): string | undefined {
  const classes: string[] = [];
  if (span.fg !== undefined) classes.push(`ansi-fg-${span.fg}`);
  if (span.bold) classes.push("ansi-bold");
  if (span.dim) classes.push("ansi-dim");
  if (span.italic) classes.push("ansi-italic");
  if (span.underline) classes.push("ansi-underline");
  return classes.length > 0 ? classes.join(" ") : undefined;
}

/** The command's terminal output, styled, under the block it ran from. */
function CodeBlockRunOutput({
  output,
  running,
  footer,
  onOpenTerminal,
}: {
  output: string;
  running: boolean;
  footer: ReactNode;
  onOpenTerminal?: () => void;
}) {
  const lines = useMemo(() => ansiToLines(output), [output]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // Follow new output while the reader stays at the bottom, like a terminal.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <div className={`code-block-run-output${running ? " running" : ""}`}>
      {onOpenTerminal && (
        <button
          type="button"
          className="code-block-run-terminal"
          aria-label="Show in terminal"
          data-tooltip="Show in terminal"
          onClick={onOpenTerminal}
        >
          <SquareTerminal size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      <div
        ref={scrollRef}
        className="code-block-run-output-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {lines.length === 0 ? (
          <div className="code-block-run-output-empty">{running ? "Running…" : "No output"}</div>
        ) : (
          <pre>
            {lines.map((line, lineIndex) => (
              <div className="code-block-run-output-line" key={lineIndex}>
                {line.length === 0
                  ? "\n"
                  : line.map((span, spanIndex) => (
                      <span key={spanIndex} className={spanClassName(span)}>
                        {span.text}
                      </span>
                    ))}
              </div>
            ))}
          </pre>
        )}
      </div>
      {footer && <div className="code-block-run-output-footer">{footer}</div>}
    </div>
  );
}

/**
 * A shell code block in an answer that the user can run: the command runs in their
 * terminal tab, its output streams in under the block, and when it finishes the
 * output goes to the agent as the next message.
 */
export function RunnableCodeBlock({
  scope,
  blockKey,
  code,
  language,
  className,
  codeProps,
}: {
  scope: CodeBlockRunScope;
  blockKey: string;
  code: string;
  language: string;
  className?: string;
  codeProps: Record<string, unknown>;
}) {
  const run = useCodeBlockRun(blockKey);
  const [copied, setCopied] = useState(false);
  const command = useMemo(() => extractRunnableCommand(code), [code]);
  const running = run?.status === "running";

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const { target } = scope;
  const tabId = run?.tabId;
  const openTerminal =
    tabId && target.openTerminalTab ? () => target.openTerminalTab?.(tabId) : undefined;

  let footer: ReactNode = null;
  if (run?.status === "error") footer = <span className="error">{run.error || "Run failed."}</span>;
  else if (run?.status === "stopped") footer = "Stopped";
  else if (run?.status === "done" && typeof run.exitCode === "number" && run.exitCode !== 0) {
    footer = `Exit code ${run.exitCode}`;
  }

  return (
    <div className={`code-block-runnable${run ? " has-run" : ""}`}>
      <div className="code-block-wrapper code-block-runnable-command">
        <Suspense fallback={<code className={className}>{code}</code>}>
          <LazyHighlightedCodeBlock
            code={code}
            language={language}
            className={className}
            codeProps={codeProps}
          />
        </Suspense>
        <div className="code-block-runnable-actions">
          {running ? (
            <button
              type="button"
              className="code-block-run-button running"
              aria-label="Stop"
              data-tooltip="Stop"
              onClick={() => stopCodeBlockRun(blockKey)}
            >
              <span className="code-block-run-spinner" aria-hidden="true" />
              <X
                className="code-block-run-stop-icon"
                size={14}
                strokeWidth={2}
                aria-hidden="true"
              />
            </button>
          ) : (
            <button
              type="button"
              className="code-block-run-button"
              aria-label="Run in terminal"
              data-tooltip="Run in terminal and send output to the agent"
              onClick={(event) => {
                // Only a real click runs a command; scripted clicks do nothing.
                if (!event.isTrusted) return;
                void startCodeBlockRun(blockKey, command, target);
              }}
            >
              <Play size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className={`code-block-run-copy${copied ? " copied" : ""}`}
            aria-label={copied ? "Copied" : "Copy"}
            data-tooltip={copied ? "Copied" : "Copy"}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
              } catch {
                // Clipboard access can be refused; the button simply stays as it was.
              }
            }}
          >
            {copied ? (
              <Check size={14} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {run && (
        <CodeBlockRunOutput
          output={run.output}
          running={running}
          footer={footer}
          onOpenTerminal={openTerminal}
        />
      )}
    </div>
  );
}
