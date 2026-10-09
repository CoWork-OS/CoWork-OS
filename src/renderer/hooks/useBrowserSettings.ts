import { useCallback, useEffect, useState } from "react";
import {
  type BrowserSettings,
  type BrowserSettingsPolicy,
  type BrowserSettingsState,
  DEFAULT_BROWSER_SETTINGS,
  normalizeBrowserSettings,
} from "../../shared/browser-settings";

const CHANGE_EVENT = "cowork:browser-settings-changed";

/** Settings > Browser, shared by the workbench, the app shell and the settings panel. */
export function useBrowserSettings(): {
  settings: BrowserSettings;
  /** What the admin policy locks (absent until loaded). */
  policy: BrowserSettingsPolicy | undefined;
  loaded: boolean;
  save: (patch: Partial<BrowserSettings>) => Promise<void>;
} {
  const [settings, setSettings] = useState<BrowserSettings>(DEFAULT_BROWSER_SETTINGS);
  const [policy, setPolicy] = useState<BrowserSettingsPolicy | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = window.electronAPI?.getBrowserSettings;
    if (load) {
      void load()
        .then((value) => {
          if (cancelled) return;
          setSettings(normalizeBrowserSettings(value));
          setPolicy(value?.policy);
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    } else {
      setLoaded(true);
    }
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<BrowserSettingsState>).detail;
      if (detail) {
        setSettings(normalizeBrowserSettings(detail));
        if (detail.policy) setPolicy(detail.policy);
      }
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  const save = useCallback(async (patch: Partial<BrowserSettings>) => {
    setSettings((current) => normalizeBrowserSettings({ ...current, ...patch }));
    const result = await window.electronAPI?.saveBrowserSettings?.(patch);
    if (result?.settings) {
      const next = normalizeBrowserSettings(result.settings);
      setSettings(next);
      if (result.settings.policy) setPolicy(result.settings.policy);
      window.dispatchEvent(
        new CustomEvent(CHANGE_EVENT, { detail: { ...next, policy: result.settings.policy } }),
      );
    }
  }, []);

  return { settings, policy, loaded, save };
}
