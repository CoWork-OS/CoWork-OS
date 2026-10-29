import { useEffect, useState } from "react";
import type { BotCapabilitySummary } from "../../shared/bot-capabilities";

/** What a bot can do in a workspace, for its details panel; null until read or when unavailable. */
export function useBotCapabilities(
  workspaceId: string | undefined,
  botId: string | undefined,
  refreshKey?: unknown,
): { summary: BotCapabilitySummary | null; failed: boolean } {
  const [summary, setSummary] = useState<BotCapabilitySummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const api = window.electronAPI;
    if (!workspaceId || !botId || !api?.getBotCapabilities) {
      setSummary(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    api
      .getBotCapabilities({ workspaceId, agentRoleId: botId })
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, botId, refreshKey]);
  return { summary, failed };
}
