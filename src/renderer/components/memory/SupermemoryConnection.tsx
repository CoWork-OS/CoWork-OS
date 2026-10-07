import { useEffect, useRef, useState } from "react";
import type { SupermemoryConfigStatus, SupermemorySearchMode } from "../../../shared/types";
import { hasHostMethod } from "../../host/browser-capabilities";
import { SupermemoryDisconnectPurge } from "./SupermemoryDisconnectPurge";
import {
  DisclosureButton,
  SettingsBadge,
  SettingsFeedback,
  SettingsRow,
  SettingsSwitch,
  type BadgeTone,
} from "./SettingsRow";

/** The host methods without which the Supermemory row is not shown. */
export const SUPERMEMORY_METHODS = [
  "getSupermemoryStatus",
  "saveSupermemorySettings",
  "testSupermemoryConnection",
] as const;

function formatTimestamp(timestamp?: number | null): string | null {
  if (!timestamp) return null;
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return null;
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The badge of the Supermemory row. */
export function supermemoryBadge(status: SupermemoryConfigStatus | null): {
  tone: BadgeTone;
  label: string;
} {
  if (!status) return { tone: "neutral", label: "..." };
  if (!status.enabled) return { tone: "neutral", label: "Off" };
  if (!status.apiKeyConfigured) return { tone: "warning", label: "No API key" };
  if (status.circuitBreakerUntil && status.circuitBreakerUntil > Date.now())
    return { tone: "warning", label: "Paused" };
  return { tone: "success", label: "Connected" };
}

/** "tag | description" lines of the custom containers field. */
export function parseCustomContainers(text: string): Array<{ tag: string; description?: string }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [tag, ...descriptionParts] = line.split("|");
      return { tag: tag.trim(), description: descriptionParts.join("|").trim() || undefined };
    });
}

/**
 * Connections → Supermemory: the switch saves at once; "Manage" opens the API key, prompt
 * and mirroring options, the search options, the connection test and Disconnect & purge.
 */
export function SupermemoryConnection({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<SupermemoryConfigStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [containerTemplate, setContainerTemplate] = useState("cowork:{workspaceId}");
  const [includeProfile, setIncludeProfile] = useState(true);
  const [mirrorWrites, setMirrorWrites] = useState(true);
  const [searchMode, setSearchMode] = useState<SupermemorySearchMode>("hybrid");
  const [rerank, setRerank] = useState(true);
  const [threshold, setThreshold] = useState("0.55");
  const [customContainers, setCustomContainers] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const alive = useRef(true);
  const report = useRef(onError);
  report.current = onError;

  const apply = (next: SupermemoryConfigStatus | null) => {
    setStatus(next);
    setContainerTemplate(next?.containerTagTemplate || "cowork:{workspaceId}");
    setIncludeProfile(next?.includeProfileInPrompt !== false);
    setMirrorWrites(next?.mirrorMemoryWrites !== false);
    setSearchMode(next?.searchMode || "hybrid");
    setRerank(next?.rerank !== false);
    setThreshold(String(next?.threshold ?? 0.55));
    setCustomContainers(
      (next?.customContainers || [])
        .map((entry) => `${entry.tag}${entry.description ? ` | ${entry.description}` : ""}`)
        .join("\n"),
    );
  };

  const reload = async () => {
    try {
      const next = await window.electronAPI.getSupermemoryStatus();
      if (alive.current) apply(next);
    } catch (error) {
      if (alive.current) report.current(errorText(error, "Failed to load Supermemory status."));
    }
  };

  // Loaded once; saves and the connection test reload it.
  const initialLoad = useRef(reload);
  useEffect(() => {
    alive.current = true;
    void initialLoad.current();
    return () => {
      alive.current = false;
    };
  }, []);

  const setEnabled = async (enabled: boolean) => {
    try {
      setSaving(true);
      setResult(null);
      await window.electronAPI.saveSupermemorySettings({ enabled });
      await reload();
    } catch (error) {
      if (alive.current) report.current(errorText(error, "Failed to save Supermemory settings."));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const save = async () => {
    try {
      setSaving(true);
      setResult(null);
      await window.electronAPI.saveSupermemorySettings({
        enabled: status?.enabled === true,
        apiKey: apiKey || undefined,
        containerTagTemplate: containerTemplate,
        includeProfileInPrompt: includeProfile,
        mirrorMemoryWrites: mirrorWrites,
        searchMode,
        rerank,
        threshold: Number(threshold),
        customContainers: parseCustomContainers(customContainers),
      });
      if (!alive.current) return;
      setApiKey("");
      setResult({ tone: "success", text: "Supermemory settings saved." });
      await reload();
    } catch (error) {
      if (alive.current) report.current(errorText(error, "Failed to save Supermemory settings."));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const test = async () => {
    try {
      setTesting(true);
      setResult(null);
      const outcome = await window.electronAPI.testSupermemoryConnection();
      if (!alive.current) return;
      setResult(
        outcome.success
          ? { tone: "success", text: "Supermemory connection succeeded." }
          : { tone: "error", text: outcome.error || "Supermemory connection failed." },
      );
      await reload();
    } catch (error) {
      if (alive.current)
        setResult({ tone: "error", text: errorText(error, "Failed to reach Supermemory") });
    } finally {
      if (alive.current) setTesting(false);
    }
  };

  const badge = supermemoryBadge(status);
  const pausedUntil = formatTimestamp(status?.circuitBreakerUntil);

  return (
    <SettingsRow
      testId="supermemory-connection"
      label={
        <>
          Supermemory <SettingsBadge tone={badge.tone}>{badge.label}</SettingsBadge>
        </>
      }
      hint={
        pausedUntil && badge.label === "Paused"
          ? `External memory; paused until ${pausedUntil}.`
          : "External memory: profile context in prompts and copies of new memories."
      }
      below={
        open ? (
          <div id="supermemory-panel" className="memory-settings-panel">
            <SettingsRow
              label="API key"
              htmlFor="supermemory-api-key"
              hint={
                <>
                  {status?.apiKeyConfigured
                    ? "A key is saved; enter a new one to replace it. "
                    : ""}
                  Get one from{" "}
                  <a
                    href="https://console.supermemory.ai"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    console.supermemory.ai
                  </a>
                  .
                </>
              }
              below={
                <input
                  id="supermemory-api-key"
                  type="password"
                  className="settings-input"
                  placeholder={status?.apiKeyConfigured ? "••••••••••••••••" : "sm_..."}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              }
            />
            <SettingsRow
              label="Add profile to prompts"
              hint="Fetch the workspace's Supermemory profile when a prompt is built."
            >
              <SettingsSwitch
                label="Add profile to prompts"
                checked={includeProfile}
                onChange={setIncludeProfile}
                disabled={saving}
              />
            </SettingsRow>
            <SettingsRow
              label="Mirror memory writes"
              hint="Copy new, non-private memories to Supermemory."
            >
              <SettingsSwitch
                label="Mirror memory writes"
                checked={mirrorWrites}
                onChange={setMirrorWrites}
                disabled={saving}
              />
            </SettingsRow>
            <details className="memory-settings-details">
              <summary>Search options</summary>
              <SettingsRow label="Search mode" htmlFor="supermemory-search-mode">
                <select
                  id="supermemory-search-mode"
                  className="settings-select"
                  value={searchMode}
                  onChange={(event) => setSearchMode(event.target.value as SupermemorySearchMode)}
                >
                  <option value="hybrid">Hybrid</option>
                  <option value="memories">Memories only</option>
                </select>
              </SettingsRow>
              <SettingsRow
                label="Threshold"
                htmlFor="supermemory-threshold"
                hint="Minimum relevance from 0 to 1."
              >
                <input
                  id="supermemory-threshold"
                  className="settings-input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                />
              </SettingsRow>
              <SettingsRow label="Rerank results" hint="Rerank explicit searches for relevance.">
                <SettingsSwitch
                  label="Rerank results"
                  checked={rerank}
                  onChange={setRerank}
                  disabled={saving}
                />
              </SettingsRow>
              <SettingsRow
                label="Custom containers"
                htmlFor="supermemory-containers"
                hint={
                  <>
                    Optional, one per line: <code>tag | description</code>.
                  </>
                }
                below={
                  <textarea
                    id="supermemory-containers"
                    className="settings-textarea"
                    rows={4}
                    value={customContainers}
                    onChange={(event) => setCustomContainers(event.target.value)}
                    placeholder={"work | Work projects\npersonal | Personal context"}
                  />
                }
              />
              <SettingsRow
                label="Container tag template"
                htmlFor="supermemory-container-template"
                hint={
                  <>
                    Supports <code>{"{workspaceId}"}</code> and <code>{"{workspaceName}"}</code>.
                  </>
                }
                below={
                  <input
                    id="supermemory-container-template"
                    className="settings-input"
                    value={containerTemplate}
                    onChange={(event) => setContainerTemplate(event.target.value)}
                    placeholder="cowork:{workspaceId}"
                  />
                }
              />
            </details>
            <div className="memory-hub-row-wrap-center">
              <button
                type="button"
                className="settings-button"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                className="settings-button"
                onClick={() => void test()}
                disabled={testing}
              >
                {testing ? "Testing..." : "Test connection"}
              </button>
            </div>
            <SettingsFeedback message={result} />
            {status?.lastError && (
              <p className="settings-form-hint">Last provider error: {status.lastError}</p>
            )}
            {hasHostMethod("disconnectAndPurgeSupermemory") && (
              <SupermemoryDisconnectPurge status={status} onDone={() => void reload()} />
            )}
          </div>
        ) : (
          <SettingsFeedback message={result} />
        )
      }
    >
      <SettingsSwitch
        label="Supermemory"
        checked={status?.enabled === true}
        onChange={(on) => void setEnabled(on)}
        disabled={saving || !status}
      />
      <DisclosureButton
        expanded={open}
        onToggle={() => setOpen((value) => !value)}
        label="Manage"
        controls="supermemory-panel"
      />
    </SettingsRow>
  );
}
