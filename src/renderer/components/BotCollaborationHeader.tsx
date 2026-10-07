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
import { BotMascot } from "./bot-mascot/BotMascot";
import { mascotExpressionForConversation } from "./bot-mascot/mascot-expressions";
import { resolveBotMascot } from "../../shared/bot-mascots";
import {
  formatHandoffReplyState,
  normalizeCollaboratorLabel,
  resolveCollaboratorConversationIds,
} from "./BotCollaborationHeader.helpers";
import "./BotCollaborationHeader.css";

export interface BotCollaborationHeaderProps {
  task: Pick<Task, "status" | "error" | "resultSummary" | "terminalStatus">;
  botName: string;
  /** The bot's icon value; a mascot icon shows the character instead of the generic mark. */
  botIcon?: string;
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
  botIcon,
  events = [],
  childEvents = [],
  childTasks = [],
  botConversations = [],
  onOpenBotConversation,
  conversationProjection = null,
}: BotCollaborationHeaderProps) {
  const mascot = resolveBotMascot(botIcon);
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
  const hasTeamContext =
    handoffCount > 0 || projection.collaborators.length > 0 || projection.teammates.length > 0;
  // A completed outcome is the bot's last reply, already in the transcript.
  const outcome = projection.outcome?.state === "completed" ? null : projection.outcome;
  const hasDetails = hasTeamContext || Boolean(outcome);
  const visibleCollaborators = projection.collaborators.slice(0, 3);
  // A solo bot that has answered has nothing to add: the title bar already
  // shows who it is and its mascot mirrors the state.
  if (!hasTeamContext && !projection.attention && !outcome) {
    if (projection.state === "completed" || projection.state === "ready") return null;
  }
  const stateLabel =
    projection.state === "working" && !hasTeamContext ? "Working" : projection.stateLabel;

  return (
    <section
      className={`bot-collaboration-header bot-collaboration-${projection.state}`}
      aria-label="Bot collaboration status"
      data-testid="bot-collaboration-header"
      data-bot-state={projection.state}
    >
      <div className="bot-collaboration-header-row">
        <span
          className="bot-collaboration-avatar bot-collaboration-avatar-mascot"
          aria-hidden="true"
        >
          <BotMascot
            mascot={mascot}
            size={28}
            expression={mascotExpressionForConversation(projection.state)}
          />
        </span>
        <div className="bot-collaboration-copy">
          <div className="bot-collaboration-status-line">
            <span className="bot-collaboration-bot-name">{botName}</span>
            <span className="bot-collaboration-status" data-testid="bot-collaboration-state">
              <StateIcon state={projection.state} />
              <span>{stateLabel}</span>
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
          {outcome && (
            <div className="bot-collaboration-outcome" data-testid="bot-collaboration-outcome">
              <span className="bot-collaboration-detail-label">Latest outcome</span>
              <span>{outcome.summary}</span>
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
        </div>
      )}
    </section>
  );
}
