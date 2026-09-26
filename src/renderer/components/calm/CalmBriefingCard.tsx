import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Clock, ShieldCheck, XCircle } from "lucide-react";

type BriefingStatus = "success" | "warning" | "error" | "info" | "pending";

interface BriefingItem {
  label: string;
  status?: BriefingStatus;
}

interface BriefingSection {
  type: string;
  enabled?: boolean;
  items: BriefingItem[];
}

interface Briefing {
  generatedAt: number;
  sections: BriefingSection[];
}

const MAX_CHIPS = 7;
const MAX_BRIEFING_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function isBriefing(value: unknown): value is Briefing {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Briefing>;
  return typeof candidate.generatedAt === "number" && Array.isArray(candidate.sections);
}

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "long" })}, ${time}`;
}

function headlineFor(items: BriefingItem[]): string {
  const attention = items.filter(
    (item) => item.status === "warning" || item.status === "error",
  ).length;
  const done = items.filter((item) => item.status === "success").length;
  if (attention > 0 && done > 0) {
    return `${done} done, ${attention} ${attention === 1 ? "needs" : "need"} you.`;
  }
  if (attention > 0) return `${attention} ${attention === 1 ? "thing needs" : "things need"} you.`;
  if (done > 0) return "Here's what moved forward.";
  return "Here's what changed.";
}

function StatusIcon({ status }: { status?: BriefingStatus }) {
  if (status === "success") return <CheckCircle2 size={15} aria-hidden="true" />;
  if (status === "warning") return <AlertTriangle size={15} aria-hidden="true" />;
  if (status === "error") return <XCircle size={15} aria-hidden="true" />;
  if (status === "pending") return <Clock size={15} aria-hidden="true" />;
  return <Circle size={13} aria-hidden="true" />;
}

interface CalmBriefingCardProps {
  workspaceId?: string;
  /** Current access profile, shown as the trust indicator. */
  accessLabel?: string;
  onOpen?: () => void;
}

/**
 * Compact "what changed" card for the calm Home screen, built from the latest
 * daily briefing. Renders nothing until a recent briefing exists.
 */
export function CalmBriefingCard({ workspaceId, accessLabel, onOpen }: CalmBriefingCardProps) {
  const [briefing, setBriefing] = useState<Briefing | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) {
      setBriefing(null);
      return;
    }
    void (async () => {
      try {
        const latest: unknown = await window.electronAPI.getLatestBriefing(workspaceId);
        if (!cancelled) setBriefing(isBriefing(latest) ? latest : null);
      } catch {
        if (!cancelled) setBriefing(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (!briefing || Date.now() - briefing.generatedAt > MAX_BRIEFING_AGE_MS) return null;

  const items = briefing.sections
    .filter((section) => section.enabled !== false)
    .flatMap((section) => section.items || [])
    .filter((item) => typeof item?.label === "string" && item.label.trim().length > 0);
  if (items.length === 0) return null;

  // Surface anything needing attention first.
  const rank = (status?: BriefingStatus) =>
    status === "error" ? 0 : status === "warning" ? 1 : status === "pending" ? 2 : 3;
  const chips = [...items].sort((a, b) => rank(a.status) - rank(b.status)).slice(0, MAX_CHIPS);

  return (
    <section className="calm-card calm-result-card calm-briefing-card" aria-label="Briefing">
      <div className="calm-result-when">{formatWhen(briefing.generatedAt)}</div>
      <h2 className="calm-result-headline">{headlineFor(items)}</h2>
      <div className="calm-status-chips">
        {chips.map((item, index) => (
          <span
            key={`${item.label}-${index}`}
            className={`calm-status-chip status-${item.status || "info"}`}
            title={item.label}
          >
            <StatusIcon status={item.status} />
            <span>{item.label}</span>
          </span>
        ))}
      </div>
      <div className="calm-result-footer">
        {accessLabel && (
          <span className="calm-trust-badge" title="Current access profile">
            <ShieldCheck size={16} aria-hidden="true" />
            {accessLabel}
          </span>
        )}
        {onOpen && (
          <button type="button" className="calm-link-button" onClick={onOpen}>
            Open briefing
          </button>
        )}
      </div>
    </section>
  );
}
