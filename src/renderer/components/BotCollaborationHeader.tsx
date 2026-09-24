import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  LoaderCircle,
  MessageCircle,
  Users,
  XCircle,
} from "lucide-react";
import type { Task, TaskEvent } from "../../shared/types";
// Keep non-component exports in the helper module so this view can Fast Refresh.
import {
  deriveBotConversationProjection,
  type BotConversationProjection,
  type BotConversationState,
} from "../../shared/bot-lifecycle";
import { BotGlyph } from "./BotGlyph";
import {
  formatHandoffReplyState,
  normalizeCollaboratorLabel,
  resolveCollaboratorConversationIds,
} from "./BotCollaborationHeader.helpers";
import "./BotCollaborationHeader.css";

export interface BotCollaborationHeaderProps {
  task: Pick<Task, "status" | "error" | "resultSummary" | "terminalStatus">;
  botName: string;
  events?: TaskEvent[];
  childEvents?: TaskEvent[];
  childTasks?: Array<
    Pick<Task, "id" | "title" | "status" | "assignedAgentRoleId"> & Partial<Pick<Task, "createdAt">>
  >;
  botConversations?: Array<Pick<Task, "id" | "title">>;
  onOpenBotConversation?: (conversationId: string) => void | Promise<void>;
  conversationProjection?: BotConversationProjection | null;
}

function StateIcon({ state }: { state: BotConversationState }) {
  if (state === "working") return <LoaderCircle size={15} className="bot-collaboration-spin" />;
  if (state === "waiting") return <Clock3 size={15} />;
  if (state === "needs_input" || state === "partial") return <AlertTriangle size={15} />;
  if (state === "completed") return <CheckCircle2 size={15} />;
  if (state === "failed") return <XCircle size={15} />;
  return <CircleDashed size={15} />;
}

function formatHandoffDirection(sender: string, recipient: string): string {
  return `${sender} → ${recipient}`;
}

function withoutCurrentBotCollaborator(
  projection: BotConversationProjection,
  botName: string,
): BotConversationProjection {
  const normalizedBotName = botName.trim().toLocaleLowerCase();
  if (!normalizedBotName) return projection;
  const collaborators = projection.collaborators.filter(
    (label) => label.trim().toLocaleLowerCase() !== normalizedBotName,
  );
  return collaborators.length === projection.collaborators.length
    ? projection
    : { ...projection, collaborators };
}

export function BotCollaborationHeader({
  task,
  botName,
  events = [],
  childEvents = [],
  childTasks = [],
  botConversations = [],
  onOpenBotConversation,
  conversationProjection = null,
}: BotCollaborationHeaderProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const derivedProjection = useMemo(
    () =>
      deriveBotConversationProjection({
        task,
        botName,
        events,
        childEvents,
        childTasks,
      }),
    [botName, childEvents, childTasks, events, task],
  );
  const projection = withoutCurrentBotCollaborator(
    conversationProjection ?? derivedProjection,
    botName,
  );
  const collaboratorConversationIds = useMemo(() => {
    return resolveCollaboratorConversationIds({
      conversations: botConversations,
      events,
      handoffs: projection.handoffs,
    });
  }, [botConversations, events, projection.handoffs]);
  const handoffCount = projection.handoffs.length;
  const hasDetails = handoffCount > 0 || projection.collaborators.length > 0 || projection.outcome;
  const visibleCollaborators = projection.collaborators.slice(0, 3);

  return (
    <section
      className={`bot-collaboration-header bot-collaboration-${projection.state}`}
      aria-label="Bot collaboration status"
      data-testid="bot-collaboration-header"
      data-bot-state={projection.state}
    >
      <div className="bot-collaboration-header-row">
        <span className="bot-collaboration-avatar" aria-hidden="true">
          <BotGlyph size={16} />
        </span>
        <div className="bot-collaboration-copy">
          <div className="bot-collaboration-status-line">
            <span className="bot-collaboration-bot-name">{botName}</span>
            <span className="bot-collaboration-status" data-testid="bot-collaboration-state">
              <StateIcon state={projection.state} />
              <span>{projection.stateLabel}</span>
            </span>
          </div>
          <div
            className="bot-collaboration-activity"
            data-testid="bot-collaboration-activity"
            title={projection.stateDetail}
            aria-live="polite"
          >
            {projection.activityLabel}
          </div>
        </div>
        {projection.collaborators.length > 0 && (
          <div className="bot-collaboration-team" aria-label="Collaborating bots">
            <Users size={14} aria-hidden="true" />
            <span className="bot-collaboration-team-label">Collaborating with</span>
            {visibleCollaborators.map((label, index) => {
              const conversationId = collaboratorConversationIds.get(
                normalizeCollaboratorLabel(label),
              );
              const canOpen = Boolean(conversationId && onOpenBotConversation);
              return (
                <span className="bot-collaboration-team-member" key={label}>
                  {index > 0 && <span aria-hidden="true"> · </span>}
                  {canOpen ? (
                    <button
                      type="button"
                      className="bot-collaboration-team-link"
                      aria-label={`Open ${label} conversation`}
                      title={`Open ${label} conversation`}
                      onClick={() => void onOpenBotConversation?.(conversationId!)}
                    >
                      {label}
                    </button>
                  ) : (
                    <span>{label}</span>
                  )}
                </span>
              );
            })}
            {projection.collaborators.length > 3 && (
              <span className="bot-collaboration-team-more">
                +{projection.collaborators.length - 3}
              </span>
            )}
          </div>
        )}
        {projection.teammates.length > 0 && (
          <span className="bot-collaboration-summary" data-testid="bot-collaboration-summary">
            {projection.collaborationSummary}
          </span>
        )}
        {hasDetails && (
          <button
            type="button"
            className="bot-collaboration-details-toggle"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            aria-controls="bot-collaboration-details"
          >
            <MessageCircle size={14} aria-hidden="true" />
            <span>
              {handoffCount > 0
                ? `${handoffCount} handoff${handoffCount === 1 ? "" : "s"}`
                : "Details"}
            </span>
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={detailsOpen ? "bot-collaboration-chevron-open" : undefined}
            />
          </button>
        )}
      </div>

      {projection.attention && (
        <div
          className={`bot-collaboration-attention bot-collaboration-attention-${projection.attention.kind}`}
          role="status"
          data-testid="bot-collaboration-attention"
        >
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            <strong>{projection.attention.title}</strong>
            <span>{projection.attention.detail}</span>
          </span>
        </div>
      )}

      {detailsOpen && (
        <div id="bot-collaboration-details" className="bot-collaboration-details">
          {projection.outcome && (
            <div className="bot-collaboration-outcome" data-testid="bot-collaboration-outcome">
              <span className="bot-collaboration-detail-label">Latest outcome</span>
              <span>{projection.outcome.summary}</span>
            </div>
          )}
          {projection.handoffs.length > 0 && (
            <div className="bot-collaboration-handoffs" aria-label="Recent bot handoffs">
              <span className="bot-collaboration-detail-label">Recent handoffs</span>
              {projection.handoffs.map((handoff) => (
                <div
                  className="bot-collaboration-handoff"
                  key={`${handoff.id}:${handoff.timestamp}`}
                  data-delivery-state={handoff.state}
                >
                  <span className="bot-collaboration-handoff-main">
                    <span>
                      {formatHandoffDirection(handoff.senderLabel, handoff.recipientLabel)}
                    </span>
                    {handoff.preview && <small>{handoff.preview}</small>}
                  </span>
                  <span className={`bot-collaboration-handoff-state state-${handoff.state}`}>
                    {formatHandoffReplyState(handoff)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {projection.collaborators.length > 0 && (
            <div className="bot-collaboration-detail-team">
              <span className="bot-collaboration-detail-label">Team</span>
              <span>{projection.collaborators.join(" · ")}</span>
            </div>
          )}
          {projection.teammates.length > 0 && (
            <div className="bot-collaboration-detail-team">
              <span className="bot-collaboration-detail-label">Teammate status</span>
              <div className="bot-collaboration-teammates" aria-label="Teammate status">
                {projection.teammates.map((teammate) => (
                  <div className="bot-collaboration-teammate" key={teammate.id}>
                    <span>{teammate.label}</span>
                    <span className={`teammate-state teammate-state-${teammate.state}`}>
                      {teammate.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="bot-collaboration-disclosure-note">
            Execution details stay hidden from the conversation. The task activity timeline remains
            available when you need the full trace.
          </div>
        </div>
      )}
    </section>
  );
}
