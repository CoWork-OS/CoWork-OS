import { TaskEvent, DEFAULT_QUIRKS } from '../../shared/types';
import { isVerificationStepDescription } from '../../shared/plan-utils';
import { ThemeIcon } from './ThemeIcon';
import {
  AlertTriangleIcon,
  BanIcon,
  CheckIcon,
  ClipboardIcon,
  DotIcon,
  ShieldIcon,
  FileIcon,
  PackageIcon,
  PauseIcon,
  PlayIcon,
  SlidersIcon,
  StopIcon,
  TargetIcon,
  TrashIcon,
  XIcon,
  ZapIcon,
} from './LineIcons';
import type { AgentContext } from '../hooks/useAgentContext';
import { getUiCopy, type UiCopyKey } from '../utils/agentMessages';

interface TaskTimelineProps {
  events: TaskEvent[];
  agentContext?: AgentContext;
}

export function TaskTimeline({ events, agentContext }: TaskTimelineProps) {
  const fallbackContext = {
    agentName: 'CoWork',
    userName: undefined,
    personality: 'professional' as const,
    persona: undefined,
    emojiUsage: 'minimal' as const,
    quirks: DEFAULT_QUIRKS,
  };
  const uiCopy = (key: UiCopyKey) =>
    agentContext?.getUiCopy ? agentContext.getUiCopy(key) : getUiCopy(key, fallbackContext);
  const isCompanion = agentContext?.persona === 'companion';
  // Filter out internal events that don't provide value to end users
  const internalEventTypes = [
    'tool_blocked',        // deduplication blocks
    'follow_up_completed', // internal follow-up tracking
    'follow_up_failed',    // internal follow-up tracking
  ];

  const isVerificationNoiseEvent = (event: TaskEvent): boolean => {
    if (event.type === 'assistant_message') return event.payload?.internal === true;
    if (event.type === 'step_started' || event.type === 'step_completed') {
      return isVerificationStepDescription(event.payload?.step?.description);
    }
    if (event.type === 'verification_started' || event.type === 'verification_passed') return true;
    return false;
  };

  const blockedEvents = events.filter(e => e.type === 'tool_blocked');
  const visibleEvents = events.filter(e => !internalEventTypes.includes(e.type) && !isVerificationNoiseEvent(e));

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getEventIcon = (type: TaskEvent['type']) => {
    switch (type) {
      case 'task_created':
        return <ThemeIcon emoji="🎯" icon={<TargetIcon size={16} />} />;
      case 'plan_created':
        return <ThemeIcon emoji="📋" icon={<ClipboardIcon size={16} />} />;
      case 'step_started':
        return <ThemeIcon emoji="▶️" icon={<PlayIcon size={16} />} />;
      case 'step_completed':
        return <ThemeIcon emoji="✅" icon={<CheckIcon size={16} />} />;
      case 'tool_call':
        return <ThemeIcon emoji="🔧" icon={<SlidersIcon size={16} />} />;
      case 'tool_result':
        return <ThemeIcon emoji="📦" icon={<PackageIcon size={16} />} />;
      case 'file_created':
      case 'file_modified':
        return <ThemeIcon emoji="📄" icon={<FileIcon size={16} />} />;
      case 'file_deleted':
        return <ThemeIcon emoji="🗑️" icon={<TrashIcon size={16} />} />;
      case 'error':
        return <ThemeIcon emoji="❌" icon={<XIcon size={16} />} />;
      case 'task_cancelled':
        return <ThemeIcon emoji="🛑" icon={<StopIcon size={16} />} />;
      case 'approval_requested':
        return <ThemeIcon emoji="⚠️" icon={<AlertTriangleIcon size={16} />} />;
      case 'approval_granted':
        return <ThemeIcon emoji="✅" icon={<CheckIcon size={16} />} />;
      case 'approval_denied':
        return <ThemeIcon emoji="⛔" icon={<BanIcon size={16} />} />;
      case 'task_paused':
        return <ThemeIcon emoji="⏸️" icon={<PauseIcon size={16} />} />;
      case 'task_resumed':
        return <ThemeIcon emoji="▶️" icon={<PlayIcon size={16} />} />;
      case 'executing':
        return <ThemeIcon emoji="⚡" icon={<ZapIcon size={16} />} />;
      case 'task_completed':
        return <ThemeIcon emoji="✅" icon={<CheckIcon size={16} />} />;
      case 'follow_up_completed':
        return <ThemeIcon emoji="✅" icon={<CheckIcon size={16} />} />;
      default:
        return <ThemeIcon emoji="•" icon={<DotIcon size={8} />} />;
    }
  };

  const getEventTitle = (event: TaskEvent) => {
    switch (event.type) {
      case 'task_created':
        return isCompanion ? "Session started - I'm here." : 'Session started';
      case 'plan_created':
        return isCompanion ? "Here's the path I'm taking" : "Here's our approach";
      case 'step_started':
        return `Working on: ${event.payload.step?.description || 'Getting started'}`;
      case 'step_completed':
        return event.payload.step?.description || event.payload.message || 'Done';
      case 'tool_call':
        return `Using: ${event.payload.tool}`;
      case 'tool_result':
        return `${event.payload.tool} done`;
      case 'file_created':
        return `Created: ${event.payload.path}`;
      case 'file_modified':
        return `Updated: ${event.payload.path || event.payload.from}`;
      case 'file_deleted':
        return `Removed: ${event.payload.path}`;
      case 'error':
        return isCompanion ? 'I ran into a snag' : 'Hit a snag';
      case 'task_cancelled':
        return 'Session stopped';
      case 'approval_requested':
        return event.payload?.autoApproved === true
          ? isCompanion
            ? `Auto-approved: ${event.payload.approval?.description}`
            : `Auto-approved: ${event.payload.approval?.description}`
          : isCompanion
            ? `I need your input: ${event.payload.approval?.description}`
            : `Need your input: ${event.payload.approval?.description}`;
      case 'approval_granted':
        return 'Approval granted';
      case 'approval_denied':
        return 'Approval denied';
      case 'task_paused':
        return event.payload.message || (isCompanion
          ? 'I paused to check with you before moving on'
          : 'Paused to get your call');
      case 'task_resumed':
        return isCompanion ? 'Back in motion' : 'Resumed';
      case 'executing':
        return event.payload.message || 'Working on it';
      case 'task_completed':
        return isCompanion ? 'All done.' : 'All done!';
      case 'follow_up_completed':
        return 'All done!';
      case 'log':
        return event.payload.message;
      default:
        return event.type;
    }
  };

  const renderEventDetails = (event: TaskEvent) => {
    switch (event.type) {
      case 'plan_created':
        return (
          <div className="event-details">
            <div className="plan-description">{event.payload.plan?.description}</div>
            {event.payload.plan?.steps && (
              <ul className="plan-steps">
                {event.payload.plan.steps
                  .filter((step: any) => !isVerificationStepDescription(step?.description))
                  .map((step: any, i: number) => (
                  <li key={i}>{step.description}</li>
                ))}
              </ul>
            )}
          </div>
        );
      case 'tool_call':
        return (
          <div className="event-details">
            <pre>{JSON.stringify(event.payload.input, null, 2)}</pre>
          </div>
        );
      case 'tool_result':
        return (
          <div className="event-details">
            <pre>{JSON.stringify(event.payload.result, null, 2)}</pre>
          </div>
        );
      case 'error': {
        const errorMessage = event.payload.error || event.payload.message;
        const actionHint = event.payload.actionHint;
        return (
          <div className="event-details error">
            <div>{errorMessage}</div>
            {actionHint?.type === 'open_settings' && (
              <button
                className="button-primary button-small"
                onClick={() => window.dispatchEvent(new CustomEvent('open-settings'))}
              >
                {actionHint.label || 'Open Settings'}
              </button>
            )}
          </div>
        );
      }
      case 'task_cancelled':
        return (
          <div className="event-details cancelled">
            {event.payload.message || 'Session was stopped'}
          </div>
        );
      default:
        return null;
    }
  };

  if (visibleEvents.length === 0 && blockedEvents.length === 0) {
    return (
      <div className="timeline-empty">
        <p>{uiCopy('timelineEmpty')}</p>
      </div>
    );
  }

  return (
    <div className="timeline">
      <h3>{uiCopy('timelineTitle')}</h3>
      <div className="timeline-events">
        {visibleEvents.map(event => (
          <div key={event.id} className="timeline-event">
            <div className="event-icon">{getEventIcon(event.type)}</div>
            <div className="event-content">
              <div className="event-header">
                <div className="event-title">{getEventTitle(event)}</div>
                <div className="event-time">{formatTime(event.timestamp)}</div>
              </div>
              {renderEventDetails(event)}
            </div>
          </div>
        ))}
        {/* Show summary of blocked events if any - collapsed for cleaner UI */}
        {blockedEvents.length > 0 && (
          <div className="timeline-event timeline-event-muted">
            <div className="event-icon">
              <ThemeIcon emoji="🛡️" icon={<ShieldIcon size={16} />} />
            </div>
            <div className="event-content">
              <div className="event-header">
                <div className="event-title">
                  {blockedEvents.length} duplicate tool call{blockedEvents.length > 1 ? 's' : ''} prevented
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
