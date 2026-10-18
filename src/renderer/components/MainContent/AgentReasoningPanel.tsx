import { withoutAnswerSurfaceBlocks } from "../../../shared/answer-surfaces/blocks";
import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { hasAgentReasoningPanelContent, type AgentReasoningPanelState } from "./task-feed-logic";

export function AgentReasoningPanel(props: {
  currentStep: { description: string } | null;
  state: AgentReasoningPanelState;
}) {
  const { currentStep, state } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [followStream, setFollowStream] = useState(true);
  const stepLabel = currentStep?.description?.trim() || "";
  // The answer renders its interactive blocks itself; the preview shows only the prose.
  const activeStreamText = withoutAnswerSurfaceBlocks(state.activeStreamText);
  const streamSignature = activeStreamText;

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nextFollow = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    setFollowStream((prev) => (prev === nextFollow ? prev : nextFollow));
  }, []);

  useEffect(() => {
    if (!scrollRef.current || !followStream) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [followStream, streamSignature]);

  useEffect(() => {
    if (state.isStreaming) {
      setFollowStream(true);
    }
  }, [currentStep?.description, state.isStreaming]);

  if (!hasAgentReasoningPanelContent(state)) return null;

  return (
    <div className="agent-reasoning-panel">
      <div className="agent-reasoning-panel-header">
        <div className="agent-reasoning-panel-title">
          <Sparkles size={13} strokeWidth={1.8} />
          <span>Reasoning</span>
        </div>
        {stepLabel ? (
          <span className="agent-reasoning-step" title={stepLabel}>
            {stepLabel === "Thinking..." ? "Thinking" : stepLabel}
          </span>
        ) : null}
        {!followStream && (
          <button
            type="button"
            className="agent-reasoning-follow-btn"
            onClick={() => {
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
              setFollowStream(true);
            }}
          >
            Jump to latest
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        className={`agent-reasoning-stream ${state.isStreaming ? "is-streaming" : ""}`}
        onScroll={handleScroll}
      >
        <div className="agent-reasoning-stream-text markdown-content">
          <MarkdownRenderer withBreaks>{activeStreamText}</MarkdownRenderer>
        </div>
      </div>
    </div>
  );
}
