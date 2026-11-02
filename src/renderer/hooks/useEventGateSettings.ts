import { useCallback, useEffect, useState } from "react";
import type { EventGateMode, EventGateSettings } from "../../shared/types";
import { hasHostMethods } from "../host/browser-capabilities";

const METHODS = [
  "getEventGateSettings",
  "addEventGatePolicy",
  "removeEventGatePolicy",
  "toggleEventGatePolicy",
  "setEventGateSourceMode",
  "setEventGateChatMode",
] as const;

/** Settings > Automations > Event Triggers: the semantic event gate's policies and modes. */
export function useEventGateSettings(): {
  available: boolean;
  settings: EventGateSettings | null;
  error: string | null;
  addPolicy: (text: string) => Promise<boolean>;
  removePolicy: (id: string) => Promise<void>;
  togglePolicy: (id: string, enabled: boolean) => Promise<void>;
  setSourceMode: (source: string, mode: EventGateMode) => Promise<void>;
  setChatMode: (chatKey: string, mode: EventGateMode | null) => Promise<void>;
} {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  const available = hasHostMethods(...METHODS) && typeof api?.getEventGateSettings === "function";
  const [settings, setSettings] = useState<EventGateSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available || !api) return;
    let cancelled = false;
    void api
      .getEventGateSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load event policies.");
      });
    return () => {
      cancelled = true;
    };
  }, [available, api]);

  const run = useCallback(async (change: () => Promise<EventGateSettings>): Promise<boolean> => {
    try {
      setSettings(await change());
      setError(null);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the change.");
      return false;
    }
  }, []);

  return {
    available,
    settings,
    error,
    addPolicy: (text) => run(() => api!.addEventGatePolicy(text)),
    removePolicy: async (id) => {
      await run(() => api!.removeEventGatePolicy(id));
    },
    togglePolicy: async (id, enabled) => {
      await run(() => api!.toggleEventGatePolicy(id, enabled));
    },
    setSourceMode: async (source, mode) => {
      await run(() => api!.setEventGateSourceMode(source, mode));
    },
    setChatMode: async (chatKey, mode) => {
      await run(() => api!.setEventGateChatMode(chatKey, mode));
    },
  };
}
