import { formatHomeSessionTime, type HomeSessions } from "../../utils/home-sessions";

interface CalmHomeSessionsProps {
  sessions: HomeSessions;
  onSelect: (taskId: string) => void;
}

/** The home screen's quiet work list: what's waiting on you, then what you touched last. */
export function CalmHomeSessions({ sessions, onSelect }: CalmHomeSessionsProps) {
  const now = Date.now();
  const groups = [
    { key: "needs-you", title: "Needs you", items: sessions.needsYou },
    { key: "recent", title: "Recent", items: sessions.recent },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="calm-home-sessions">
      {groups.map((group) => (
        <section key={group.key} className="calm-home-group" aria-label={group.title}>
          <h2 className="calm-home-group-title">
            {group.title}
            {group.key === "needs-you" && (
              <span className="calm-home-group-count">{group.items.length}</span>
            )}
          </h2>
          <ul className="calm-home-list">
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`calm-home-row${item.attention ? " attention" : ""}`}
                  onClick={() => onSelect(item.id)}
                  title={item.title}
                >
                  <span className="calm-home-row-mark" aria-hidden="true" />
                  <span className="calm-home-row-title">{item.title}</span>
                  {item.attention && <span className="calm-home-row-reason">{item.attention}</span>}
                  <span className="calm-home-row-time">
                    {formatHomeSessionTime(item.updatedAt, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
