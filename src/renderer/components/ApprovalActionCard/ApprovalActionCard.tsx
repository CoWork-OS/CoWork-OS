import { memo, type ReactNode } from "react";
import { CalendarDays, Check, MapPin, Users, X } from "lucide-react";
import {
  actionCardProviderLabel,
  actionCardReceipt,
  formatActionCardWhen,
  type ApprovalActionCard as ApprovalActionCardData,
} from "../../../shared/approval-action-card";
import "./approval-action-card.css";

type ApprovalActionCardProps = {
  card: ApprovalActionCardData;
  /** pending: still waiting on the person, with `actions` as the buttons. */
  state: "pending" | "approved" | "declined";
  actions?: ReactNode;
  /** A reply typed instead of choosing ("Use Wednesday instead"), shown on the receipt. */
  reply?: string;
  /** Extra controls under the event (Details, Reply instead) while pending. */
  footer?: ReactNode;
};

const OPERATION_EYEBROW: Record<ApprovalActionCardData["operation"], string> = {
  create: "New event",
  update: "Event change",
  delete: "Delete event",
};

/** Initials for an attendee chip: "Sophie Laurent" → "SL", "sophie@x.com" → "S". */
export function attendeeInitials(attendee: string): string {
  const name = attendee.includes("@") ? attendee.split("@")[0] : attendee;
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters =
    parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0]?.[0] ?? "?");
  return letters.toUpperCase();
}

/**
 * A calendar change drawn as the event: the approval card while it waits, and its receipt in the
 * conversation once answered. All text is the stored card's, rendered as text.
 */
export const ApprovalActionCard = memo(function ApprovalActionCard({
  card,
  state,
  actions,
  reply,
  footer,
}: ApprovalActionCardProps) {
  const when = formatActionCardWhen(card);
  const attendeeCount = card.attendees.length + card.attendeesOmitted;
  const isDelete = card.operation === "delete";
  return (
    <section
      className="approval-action-card"
      data-state={state}
      data-operation={card.operation}
      aria-label={`${OPERATION_EYEBROW[card.operation]}: ${card.title}`}
    >
      <header className="approval-action-card-header">
        <span className="approval-action-card-icon" aria-hidden="true">
          <CalendarDays size={15} strokeWidth={1.8} />
        </span>
        <span className="approval-action-card-eyebrow">
          {OPERATION_EYEBROW[card.operation]} · {actionCardProviderLabel(card)}
          {card.calendar ? ` · ${card.calendar}` : ""}
        </span>
      </header>

      <div className="approval-action-card-body">
        <div className="approval-action-card-title" data-struck={isDelete ? "true" : undefined}>
          {card.title}
        </div>
        {when && <div className="approval-action-card-when">{when}</div>}
        {card.location && (
          <div className="approval-action-card-line">
            <MapPin size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>{card.location}</span>
          </div>
        )}
        {attendeeCount > 0 && (
          <div className="approval-action-card-attendees">
            <Users size={13} strokeWidth={1.8} aria-hidden="true" />
            <ul aria-label={`${attendeeCount} ${attendeeCount === 1 ? "attendee" : "attendees"}`}>
              {card.attendees.map((attendee, index) => (
                <li key={`${attendee}-${index}`} title={attendee}>
                  <span className="approval-action-card-avatar" aria-hidden="true">
                    {attendeeInitials(attendee)}
                  </span>
                  <span className="approval-action-card-attendee">{attendee}</span>
                </li>
              ))}
              {card.attendeesOmitted > 0 && (
                <li className="approval-action-card-more">+{card.attendeesOmitted} more</li>
              )}
            </ul>
          </div>
        )}
        {card.description && state === "pending" && (
          <p className="approval-action-card-description">{card.description}</p>
        )}
      </div>

      {state === "pending" ? (
        <>
          {actions && <div className="approval-action-card-actions">{actions}</div>}
          {footer}
        </>
      ) : (
        <footer className="approval-action-card-receipt" role="status">
          {state === "approved" ? (
            <Check size={14} strokeWidth={2.2} aria-hidden="true" />
          ) : (
            <X size={14} strokeWidth={2.2} aria-hidden="true" />
          )}
          <span>{actionCardReceipt(card, state === "approved")}</span>
          {reply && <span className="approval-action-card-reply">“{reply}”</span>}
        </footer>
      )}
    </section>
  );
});
