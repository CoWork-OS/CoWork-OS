import { useId, useState } from "react";
import {
  Brain,
  CalendarClock,
  ChevronRight,
  FolderOpen,
  ListChecks,
  Monitor,
  Plug,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { BotCapabilitySummary } from "../../shared/bot-capabilities";
import { botCapabilityRows, type BotCapabilityRowId } from "../utils/bot-capabilities-copy";

const ROW_ICONS: Record<BotCapabilityRowId, LucideIcon> = {
  where: Monitor,
  files: FolderOpen,
  services: Plug,
  schedules: CalendarClock,
  memory: Brain,
  ok: ShieldCheck,
};

/**
 * "What it can do": where the bot works, which services it may use, when it runs, what it
 * remembers and what stops it, as one summary. Each row opens to the details behind it.
 */
export function BotCapabilitySection({
  summary,
  failed,
  memorySaved,
  now,
}: {
  summary: BotCapabilitySummary | null;
  failed?: boolean;
  /** The Memory section's live count, so the two never disagree after Forget or Undo. */
  memorySaved?: number;
  now?: number;
}) {
  const [open, setOpen] = useState<BotCapabilityRowId | null>(null);
  const baseId = useId();
  if (!summary) {
    if (!failed) return null;
    return (
      <section className="bot-details-section" aria-label="What it can do">
        <h3 className="bot-details-section-heading">
          <ListChecks size={13} />
          <span>What it can do</span>
        </h3>
        <p className="bot-details-hint" role="status">
          Couldn't read this bot's setup.
        </p>
      </section>
    );
  }
  const rows = botCapabilityRows(summary, { memorySaved, now });
  return (
    <section className="bot-details-section" aria-label="What it can do">
      <h3 className="bot-details-section-heading">
        <ListChecks size={13} />
        <span>What it can do</span>
      </h3>
      <ul className="bot-capability-list">
        {rows.map((row) => {
          const Icon = ROW_ICONS[row.id];
          const expanded = open === row.id;
          const detailsId = `${baseId}-${row.id}`;
          const hasDetails = row.details.length > 0 && !row.unavailable;
          return (
            <li key={row.id} className="bot-capability-row">
              <button
                type="button"
                className="bot-capability-toggle"
                aria-expanded={hasDetails ? expanded : undefined}
                aria-controls={hasDetails ? detailsId : undefined}
                disabled={!hasDetails}
                onClick={() => setOpen(expanded ? null : row.id)}
              >
                <Icon size={14} className="bot-capability-icon" aria-hidden="true" />
                <span className="bot-capability-text">
                  <span className="bot-capability-label">{row.label}</span>
                  <span className="bot-capability-summary">
                    {row.unavailable ? "Couldn't read this right now" : row.summary}
                  </span>
                </span>
                {hasDetails && (
                  <ChevronRight
                    size={13}
                    className={`bot-capability-chevron${expanded ? " open" : ""}`}
                    aria-hidden="true"
                  />
                )}
              </button>
              {hasDetails && expanded && (
                <ul id={detailsId} className="bot-capability-details">
                  {row.details.map((detail) =>
                    typeof detail === "string" ? (
                      <li key={detail}>{detail}</li>
                    ) : (
                      <li key={detail.lead}>
                        {detail.lead}
                        <ul className="bot-capability-sublist">
                          {detail.items.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
