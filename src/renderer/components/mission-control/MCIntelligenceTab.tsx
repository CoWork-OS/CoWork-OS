import type { MissionControlCategory, MissionControlItem } from "../../../shared/types";
import type { MissionControlData } from "./useMissionControlData";

interface MCIntelligenceTabProps {
  data: MissionControlData;
}

const INTELLIGENCE_GROUPS: Array<{ category: MissionControlCategory; title: string; empty: string }> = [
  { category: "learnings", title: "Learnings", empty: "No grouped learnings yet." },
  { category: "awareness", title: "Awareness", empty: "No awareness clusters yet." },
  { category: "reviews", title: "Reviews", empty: "No review decisions yet." },
];

function IntelligenceItem({
  item,
  formatRelativeTime,
}: {
  item: MissionControlItem;
  formatRelativeTime: MissionControlData["formatRelativeTime"];
}) {
  return (
    <article className="mc-v2-intelligence-row">
      <div className="mc-v2-intelligence-row-main">
        <div className="mc-v2-brief-item-top">
          <span className={`mc-v2-status-pill ${item.severity === "failed" ? "danger" : item.severity === "action_needed" ? "attention" : item.severity === "successful" ? "healthy" : ""}`}>
            {item.severity.replace(/_/g, " ")}
          </span>
          <span className="mc-v2-feed-time">{formatRelativeTime(item.timestamp)}</span>
        </div>
        <h3>{item.title}</h3>
        <p>{item.summary}</p>
      </div>
      {(item.decision || item.nextStep) && (
        <div className="mc-v2-intelligence-row-side">
          {item.decision && <span>{item.decision}</span>}
          {item.nextStep && <strong>{item.nextStep}</strong>}
        </div>
      )}
    </article>
  );
}

export function MCIntelligenceTab({ data }: MCIntelligenceTabProps) {
  const { missionControlItems, formatRelativeTime, setActiveTab, setFeedFilter } = data;

  return (
    <div className="mc-v2-intelligence">
      <div className="mc-v2-intelligence-header">
        <div>
          <h1>Intelligence</h1>
        </div>
        <button
          className="mc-v2-icon-btn"
          onClick={() => {
            setFeedFilter("all");
            setActiveTab("feed");
          }}
        >
          Open Evidence Feed
        </button>
      </div>

      <div className="mc-v2-intelligence-grid">
        {INTELLIGENCE_GROUPS.map((group) => {
          const items = missionControlItems.filter((item) => item.category === group.category).slice(0, 12);
          return (
            <section key={group.category} className="mc-v2-intelligence-section">
              <div className="mc-v2-brief-section-header">
                <h2>{group.title}</h2>
                <span>{items.length}</span>
              </div>
              {items.length === 0 ? (
                <div className="mc-v2-empty mc-v2-empty-compact">{group.empty}</div>
              ) : (
                <div className="mc-v2-intelligence-list">
                  {items.map((item) => (
                    <IntelligenceItem key={item.id} item={item} formatRelativeTime={formatRelativeTime} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
