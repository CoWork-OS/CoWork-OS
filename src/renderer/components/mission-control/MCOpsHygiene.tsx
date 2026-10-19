import { useCallback, useEffect, useState } from "react";
import type { HygieneFlag, HygieneItem, HygieneReport, LifecycleKind } from "../../../shared/types";

const KIND_LABEL: Record<LifecycleKind, string> = {
  skill: "Skill",
  playbook: "Playbook entry",
  automation: "Automation",
  trigger: "Trigger",
  rule: "Rule",
};

/** What Retire does to each kind, shown on its button. */
const RETIRE_LABEL: Record<LifecycleKind, string> = {
  skill: "Disable",
  playbook: "Stop recalling",
  automation: "Disable",
  trigger: "Disable",
  rule: "Archive",
};

const FLAG_LABEL: Record<HygieneFlag, string> = {
  unused_90: "Unused 90+ days",
  unused_60: "Unused 60+ days",
  ownerless: "No owner",
  broken_dependency: "Broken dependency",
  rule_without_evidence: "No evidence",
};

/**
 * Mission Control > Operations > Hygiene (agent-first roadmap WP9): generated software nobody
 * uses, owns, or that depends on something gone. Proposals only: Retire disables or archives
 * an item where its store can, Keep restarts its idle timer, and nothing is deleted.
 */
export function OpsHygiene({ formatRelativeTime }: { formatRelativeTime: (t?: number) => string }) {
  const api = window.electronAPI;
  const available = Boolean(api?.getHygieneReport);
  const [report, setReport] = useState<HygieneReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!api?.getHygieneReport) return;
    setLoading(true);
    try {
      setReport(await api.getHygieneReport({ includeAll: showAll }));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not load Hygiene.");
    } finally {
      setLoading(false);
    }
  }, [api, showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (item: HygieneItem, action: "retire" | "keep") => {
    if (busyKey || !api) return;
    const key = `${item.kind}:${item.id}`;
    setBusyKey(key);
    setMessage(null);
    try {
      const result =
        action === "retire"
          ? await api.retireLifecycleItem({ kind: item.kind, id: item.id })
          : await api.keepLifecycleItem({ kind: item.kind, id: item.id });
      if (!result.success) {
        const error = "error" in result ? result.error : undefined;
        setMessage(typeof error === "string" && error ? error : "That did not work.");
        return;
      }
      setMessage(
        action === "retire"
          ? `${KIND_LABEL[item.kind]} "${item.name}" retired.`
          : `Keeping ${KIND_LABEL[item.kind].toLowerCase()} "${item.name}".`,
      );
      await load();
    } finally {
      setBusyKey(null);
    }
  };

  const saveMeta = async (
    item: HygieneItem,
    patch: { owner?: string; protects?: string; evidence?: string },
  ) => {
    if (!api?.setLifecycleMeta) return;
    const result = await api.setLifecycleMeta({ kind: item.kind, id: item.id, ...patch });
    if (!result.success) setMessage(result.error || "Could not save.");
    else await load();
  };

  if (!available) {
    return (
      <div className="mc-v2-empty mc-v2-empty-compact">
        Hygiene is not available in this browser session.
      </div>
    );
  }

  const items = report?.items ?? [];
  const count = (flag: HygieneFlag) => items.filter((item) => item.flags.includes(flag)).length;

  return (
    <div className="mc-v2-ops-stack">
      <div className="mc-v2-ops-stats">
        {[
          { label: "Checked", value: report?.checked ?? 0 },
          { label: "Unused 90+ days", value: count("unused_90") },
          { label: "Unused 60+ days", value: count("unused_60") },
          { label: "No owner", value: count("ownerless") },
          { label: "Broken", value: count("broken_dependency") },
        ].map((stat) => (
          <div key={stat.label} className="mc-v2-ops-stat-card">
            <span className="mc-v2-ops-stat-value">{stat.value}</span>
            <span className="mc-v2-ops-stat-label">{stat.label}</span>
          </div>
        ))}
      </div>
      <div>
        <h3 className="mc-v2-ops-heading">Skills, playbooks, automations, triggers and rules</h3>
        <p className="mc-v2-ops-row-subtitle">
          Nothing here is deleted. Retire disables or archives an item; Keep restarts its 90-day
          timer. An automation with a next scheduled run is never counted as unused.
        </p>
        <label className="mc-v2-planner-field checkbox">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />
          <span>Show everything, to set owners and rule evidence</span>
        </label>
        <div className="mc-v2-ops-list">
          {loading && !report ? (
            <div className="mc-v2-empty mc-v2-empty-compact">Checking…</div>
          ) : items.length === 0 ? (
            <div className="mc-v2-empty mc-v2-empty-compact">
              Everything checked is in use, owned and complete.
            </div>
          ) : (
            items.map((item) => {
              const key = `${item.kind}:${item.id}`;
              return (
                <div key={key} className="mc-v2-ops-row">
                  <div className="mc-v2-ops-row-main">
                    <div className="mc-v2-ops-row-title">{item.name}</div>
                    <div className="mc-v2-ops-row-subtitle">
                      {KIND_LABEL[item.kind]} ·{" "}
                      {item.lastUsedAt
                        ? `last used ${formatRelativeTime(item.lastUsedAt)}`
                        : "never used"}{" "}
                      · {item.useCount} {item.useCount === 1 ? "use" : "uses"}
                      {item.nextRunAt ? ` · next run ${formatRelativeTime(item.nextRunAt)}` : ""}
                    </div>
                    {item.brokenDependencies.length > 0 && (
                      <div className="mc-v2-ops-row-subtitle">
                        Depends on missing or retired:{" "}
                        {item.brokenDependencies.map((ref) => `${ref.kind} ${ref.id}`).join(", ")}
                      </div>
                    )}
                    <label className="mc-v2-planner-field">
                      <span>Owner</span>
                      <input
                        type="text"
                        defaultValue={item.owner ?? ""}
                        placeholder="Nobody"
                        maxLength={200}
                        onBlur={(event) => {
                          const owner = event.target.value.trim();
                          if (owner !== (item.owner ?? "")) void saveMeta(item, { owner });
                        }}
                      />
                    </label>
                    {item.kind === "rule" && (
                      <>
                        <label className="mc-v2-planner-field">
                          <span>Protects</span>
                          <input
                            type="text"
                            defaultValue={item.protects ?? ""}
                            placeholder="The decision this rule protects"
                            maxLength={500}
                            onBlur={(event) => {
                              const protects = event.target.value.trim();
                              if (protects !== (item.protects ?? ""))
                                void saveMeta(item, { protects });
                            }}
                          />
                        </label>
                        <label className="mc-v2-planner-field">
                          <span>Evidence</span>
                          <input
                            type="text"
                            defaultValue={item.evidence ?? ""}
                            placeholder="Eval case, fixture or task of the failure it prevents"
                            maxLength={500}
                            onBlur={(event) => {
                              const evidence = event.target.value.trim();
                              if (evidence !== (item.evidence ?? ""))
                                void saveMeta(item, { evidence });
                            }}
                          />
                        </label>
                      </>
                    )}
                  </div>
                  <div className="mc-v2-ops-row-actions">
                    {item.flags.map((flag) => (
                      <span key={flag} className={`mc-v2-ops-pill status-${flag}`}>
                        {FLAG_LABEL[flag]}
                      </span>
                    ))}
                    <button
                      type="button"
                      className="mc-v2-ops-retry"
                      disabled={Boolean(busyKey)}
                      onClick={() => void act(item, "keep")}
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      className="mc-v2-ops-retry"
                      disabled={Boolean(busyKey)}
                      onClick={() => void act(item, "retire")}
                    >
                      {busyKey === key ? "Working…" : RETIRE_LABEL[item.kind]}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {message ? <div className="mc-v2-empty mc-v2-empty-compact">{message}</div> : null}
      </div>
    </div>
  );
}
