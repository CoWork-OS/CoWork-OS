import { botNotificationOptionsSchema } from "../../shared/bot-notification";
import { useEffect, useRef, useState } from "react";
import type {
  BotNotificationRetry,
  BotNotificationRoute,
  BotNotificationOptions,
  BotNotificationUpdate,
  BotNotificationReceipt,
} from "../../shared/bot-notification";
import type { BotNotificationPolicy } from "../../shared/types";
import { hasHostMethods } from "../host/browser-capabilities";

/** Fired after the per-bot event toggles change, so every surface showing them agrees. */
export const BOT_NOTIFICATION_POLICY_UPDATED_EVENT = "cowork:bot-notification-policy-updated";

export function BotNotificationPanel({
  workspaceId,
  botId,
}: {
  workspaceId: string;
  botId: string;
}) {
  const [route, setRoute] = useState<BotNotificationRoute | null>(null),
    [options, setOptions] = useState<BotNotificationOptions | null>(null),
    [receipts, setReceipts] = useState<BotNotificationReceipt[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [policy, setPolicy] = useState<BotNotificationPolicy | null>(null),
    [savingPolicy, setSavingPolicy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true),
    pending = useRef<BotNotificationUpdate | null>(null),
    retryPending = useRef<BotNotificationRetry | null>(null);
  const available = hasHostMethods(
    "getBotNotificationRoute",
    "updateBotNotificationRoute",
    "listBotNotificationReceipts",
  );
  const scope = { workspaceId, agentRoleId: botId };
  const refresh = async () => {
    const activeGeneration = ++generation.current;
    try {
      const [current, history] = await Promise.all([
        window.electronAPI.getBotNotificationRoute(scope),
        window.electronAPI.listBotNotificationReceipts(scope),
      ]);
      if (!mounted.current || generation.current !== activeGeneration) return;
      if (
        current.scope.workspaceId !== workspaceId ||
        current.scope.agentRoleId !== botId ||
        history.some((r) => r.scope.workspaceId !== workspaceId || r.scope.agentRoleId !== botId)
      )
        throw Error("Notification response belongs to another scope");
      setRoute(current);
      if (!pending.current)
        setOptions({
          enabled: current.enabled,
          destination: current.destination,
          quietHours: current.quietHours,
          digestMinutes: current.digestMinutes,
        });
      setReceipts(history);
      setError(null);
    } catch (cause) {
      if (mounted.current && generation.current === activeGeneration)
        setError(cause instanceof Error ? cause.message : "Could not load notification settings.");
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (available) void refresh();
    return () => {
      mounted.current = false;
      ++generation.current;
    };
  }, [workspaceId, botId, available]);
  // Which events reach the person at all; shared with the chat's details panel.
  const policyAvailable = hasHostMethods("getBotNotificationPolicy", "updateBotNotificationPolicy");
  useEffect(() => {
    if (!policyAvailable) return;
    let cancelled = false;
    void window.electronAPI
      .getBotNotificationPolicy(botId)
      .then((loaded) => {
        if (!cancelled) setPolicy(loaded);
      })
      .catch(() => undefined);
    const onUpdated = (event: Event) => {
      const updated = (event as CustomEvent<BotNotificationPolicy>).detail;
      if (updated?.agentRoleId === botId) setPolicy(updated);
    };
    window.addEventListener(BOT_NOTIFICATION_POLICY_UPDATED_EVENT, onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(BOT_NOTIFICATION_POLICY_UPDATED_EVENT, onUpdated);
    };
  }, [botId, policyAvailable]);
  const updatePolicy = async (
    patch: Partial<Pick<BotNotificationPolicy, "onFinish" | "onInputRequired">>,
  ) => {
    setSavingPolicy(true);
    try {
      const updated = await window.electronAPI.updateBotNotificationPolicy({
        agentRoleId: botId,
        ...patch,
      });
      if (!mounted.current) return;
      setPolicy(updated);
      window.dispatchEvent(
        new CustomEvent(BOT_NOTIFICATION_POLICY_UPDATED_EVENT, { detail: updated }),
      );
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not save notification settings.");
    } finally {
      if (mounted.current) setSavingPolicy(false);
    }
  };
  const dirty =
    !!route &&
    !!options &&
    (options.enabled !== route.enabled ||
      options.destination !== route.destination ||
      options.digestMinutes !== route.digestMinutes ||
      JSON.stringify(options.quietHours) !== JSON.stringify(route.quietHours));
  const retry = async (intentId: string) => {
    if (!route || busy || pending.current || !hasHostMethods("retryBotNotification")) return;
    if (retryPending.current && retryPending.current.intentId !== intentId) return;
    retryPending.current ??= {
      scope,
      requestId: crypto.randomUUID(),
      intentId,
      expectedRouteVersion: route.version,
    };
    setBusy(true);
    const activeGeneration = generation.current;
    try {
      const receipt = await window.electronAPI.retryBotNotification(retryPending.current);
      if (!mounted.current || generation.current !== activeGeneration) return;
      if (
        receipt.id !== intentId ||
        receipt.scope.workspaceId !== workspaceId ||
        receipt.scope.agentRoleId !== botId
      )
        throw Error("Notification retry response belongs to another scope");
      retryPending.current = null;
      await refresh();
    } catch (cause) {
      if (mounted.current && generation.current === activeGeneration) {
        const message =
          cause instanceof Error ? cause.message : "Could not retry notification delivery.";
        if (
          [
            "Notification route version changed",
            "Notification is not an unknown delivery",
            "Notification routing is disabled",
            "Notification task scope changed",
            "Decision is no longer pending",
            "Notification result or policy changed",
            "Notification outcome is no longer actionable",
          ].some((value) => message.includes(value))
        ) {
          retryPending.current = null;
          await refresh();
        }
        setError(message);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const save = async () => {
    if (!route || !options || busy || retryPending.current) return;
    if (!pending.current) {
      const checked = botNotificationOptionsSchema.safeParse(options);
      if (!checked.success) {
        setError(checked.error.issues[0]?.message ?? "Invalid notification options");
        return;
      }
    }
    setBusy(true);
    const saveGeneration = generation.current;
    pending.current ??= {
      scope,
      requestId: crypto.randomUUID(),
      expectedVersion: route.version,
      options: structuredClone(options),
    };
    try {
      await window.electronAPI.updateBotNotificationRoute(pending.current);
      if (!mounted.current || generation.current !== saveGeneration) return;
      pending.current = null;
      await refresh();
    } catch (cause) {
      if (mounted.current && generation.current === saveGeneration) {
        const message =
          cause instanceof Error ? cause.message : "Could not save notification settings.";
        if (message.includes("Notification route version changed")) {
          pending.current = null;
          await refresh();
          if (mounted.current)
            setError(
              "Settings changed in another window. Review the current settings before saving.",
            );
        } else setError(message + " Retry uses the same saved request.");
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (!available)
    return (
      <section className="bot-result-card">
        <h3>Notifications</h3>
        <p>Notification routing is unavailable in this runtime.</p>
      </section>
    );
  return (
    <section className="bot-notification-card" aria-label="Bot notification routing">
      <h3>Notifications</h3>
      <p className="bot-work-note">
        Decisions arrive right away. Quiet hours and bundling apply to results and failures.
      </p>
      {error && <p role="alert">{error}</p>}
      {policy && (
        <fieldset className="bot-notification-events" disabled={savingPolicy}>
          <legend>Tell me when it</legend>
          <label>
            <input
              type="checkbox"
              checked={policy.onInputRequired}
              onChange={(e) => void updatePolicy({ onInputRequired: e.target.checked })}
            />
            needs a decision
          </label>
          <label>
            <input
              type="checkbox"
              checked={policy.onFinish}
              onChange={(e) => void updatePolicy({ onFinish: e.target.checked })}
            />
            finishes or fails
          </label>
        </fieldset>
      )}
      {!options ? (
        <p>Loading notification settings…</p>
      ) : (
        <fieldset
          disabled={busy || !!pending.current || !!retryPending.current}
          className="bot-notification-fields"
        >
          <label>
            <input
              type="checkbox"
              checked={options.enabled}
              onChange={(e) => setOptions({ ...options, enabled: e.target.checked })}
            />
            Also send to the inbox or desktop, with quiet hours and bundling
          </label>
          {options.enabled && (
            <>
              <label>
                Where
                <select
                  value={options.destination}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      destination: e.target.value as BotNotificationOptions["destination"],
                    })
                  }
                >
                  <option value="inbox">App inbox</option>
                  <option value="desktop">App inbox and desktop alert</option>
                </select>
              </label>
              <label>
                Results and failures
                <select
                  value={options.digestMinutes}
                  onChange={(e) =>
                    setOptions({ ...options, digestMinutes: Number(e.target.value) })
                  }
                >
                  <option value={0}>As they happen</option>
                  <option value={15}>Bundle every 15 minutes</option>
                  <option value={60}>Bundle hourly</option>
                  <option value={1440}>Daily summary</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={!!options.quietHours}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      quietHours: e.target.checked
                        ? {
                            start: "22:00",
                            end: "08:00",
                            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                          }
                        : null,
                    })
                  }
                />
                Quiet hours
              </label>
              {options.quietHours && (
                <>
                  <label>
                    Quiet from
                    <input
                      type="time"
                      value={options.quietHours.start}
                      onChange={(e) =>
                        setOptions({
                          ...options,
                          quietHours: { ...options.quietHours!, start: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    Quiet until
                    <input
                      type="time"
                      value={options.quietHours.end}
                      onChange={(e) =>
                        setOptions({
                          ...options,
                          quietHours: { ...options.quietHours!, end: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    Timezone
                    <input
                      value={options.quietHours.timeZone}
                      onChange={(e) =>
                        setOptions({
                          ...options,
                          quietHours: { ...options.quietHours!, timeZone: e.target.value },
                        })
                      }
                    />
                  </label>
                </>
              )}
            </>
          )}
        </fieldset>
      )}
      <div className="bot-notification-actions">
        {options && (dirty || !!pending.current) && (
          <button
            type="button"
            className="bot-work-primary"
            disabled={busy || !!retryPending.current}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : pending.current ? "Retry save" : "Save"}
          </button>
        )}
      </div>
      <details
        onToggle={(event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) void refresh();
        }}
      >
        <summary>Recent notifications{receipts.length ? ` (${receipts.length})` : ""}</summary>
        {receipts.length ? (
          <ul>
            {receipts.slice(0, 10).map((receipt) => (
              <li key={receipt.id}>
                {receipt.kind} · {receipt.state.replaceAll("_", " ")} · {receipt.destination}
                {(receipt.state === "delivery_unknown" ||
                  retryPending.current?.intentId === receipt.id) &&
                  hasHostMethods("retryBotNotification") && (
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !!pending.current ||
                        (!!retryPending.current && retryPending.current.intentId !== receipt.id)
                      }
                      onClick={() => void retry(receipt.id)}
                    >
                      {retryPending.current?.intentId === receipt.id
                        ? "Retry request"
                        : "Retry notification"}
                    </button>
                  )}
                <p className="bot-work-note">
                  {receipt.desktop.replaceAll("_", " ")} ·{" "}
                  {new Date(receipt.dueAt).toLocaleString()}
                  {receipt.reason ? ` · ${receipt.reason}` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bot-work-note">Nothing sent yet in this workspace.</p>
        )}
      </details>
    </section>
  );
}
