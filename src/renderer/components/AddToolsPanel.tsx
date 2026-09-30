import { useEffect, useMemo, useState } from "react";
import { ArrowRight, RefreshCw, Search } from "lucide-react";
import type { SkillStatusEntry } from "../../shared/types";
import { hasHostMethods } from "../host/browser-capabilities";
import { NATIVE_INTEGRATIONS } from "./native-integration-catalog";
import { getAddToolsRouteAvailability } from "./add-tools-route-availability";
import "./add-tools.css";

export type AddToolsRoute = {
  tab:
    | "customize"
    | "skills"
    | "integrations"
    | "mcp"
    | "tools"
    | "system"
    | "telegram"
    | "slack"
    | "whatsapp"
    | "morechannels";
  secondaryChannel?:
    | "teams"
    | "x"
    | "discord"
    | "imessage"
    | "signal"
    | "line"
    | "email"
    | "googlechat"
    | "feishu"
    | "wecom"
    | "whatsapp_cloud"
    | "twilio_sms"
    | "mattermost"
    | "matrix"
    | "twitch"
    | "bluebubbles";
};
export type AddToolsSelection = Pick<
  DiscoveryEntry,
  "id" | "name" | "kind" | "source" | "targetId"
>;
type Kind = "pack" | "skill" | "mcp" | "native" | "channel";

interface DiscoveryEntry {
  id: string;
  name: string;
  description: string;
  kind: Kind;
  source: string;
  state: string;
  targetId?: string;
  detail?: string;
  route: AddToolsRoute;
  attention?: boolean;
}

interface AddToolsPanelProps {
  onNavigate: (route: AddToolsRoute, selection?: AddToolsSelection) => void;
}

const PATHS: Array<{
  route: AddToolsRoute;
  name: string;
  description: string;
  setup: string;
}> = [
  {
    route: { tab: "customize" },
    name: "Feature Packs & Plugins",
    description: "Bundles of skills, commands, and agent roles.",
    setup: "Review pack permissions and recommended connectors in Feature Packs.",
  },
  {
    route: { tab: "skills" },
    name: "Skill Store",
    description: "Browse skills and inspect their requirements before use.",
    setup: "Install and resolve missing requirements in Skill Store.",
  },
  {
    route: { tab: "integrations" },
    name: "Connectors & native integrations",
    description: "Connect accounts and services through their own setup flows.",
    setup: "Open Connectors for credentials, account setup, and connection details.",
  },
  {
    route: { tab: "mcp" },
    name: "MCP servers",
    description: "Configure servers and inspect their live connection state.",
    setup: "Open MCP Servers to install, configure, connect, or repair a server.",
  },
  {
    route: { tab: "tools" },
    name: "Built-in tools",
    description: "Manage tools included with CoWork, including computer use.",
    setup: "Review tool controls and local prerequisites in Built-in Tools.",
  },
];

const CHANNEL_ENTRIES: Array<{
  id: string;
  name: string;
  description: string;
  route: AddToolsRoute;
}> = [
  {
    id: "slack",
    name: "Slack",
    description: "Configure Slack workspace access and message delivery.",
    route: { tab: "slack" },
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Configure the Telegram bot connection and message delivery.",
    route: { tab: "telegram" },
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    description: "Configure the WhatsApp channel connection and message delivery.",
    route: { tab: "whatsapp" },
  },
  ...(
    [
      ["teams", "Microsoft Teams"],
      ["discord", "Discord"],
      ["imessage", "iMessage"],
      ["signal", "Signal"],
      ["line", "LINE"],
      ["email", "Email"],
      ["googlechat", "Google Chat"],
      ["feishu", "Feishu / Lark"],
      ["wecom", "WeCom"],
      ["whatsapp_cloud", "WhatsApp Business"],
      ["twilio_sms", "SMS (Twilio)"],
      ["mattermost", "Mattermost"],
      ["matrix", "Matrix"],
      ["twitch", "Twitch"],
      ["bluebubbles", "BlueBubbles"],
      ["x", "X (Twitter)"],
    ] as const
  ).map(([id, name]) => ({
    id,
    name,
    description: `Configure ${name} channel settings and message delivery.`,
    route: { tab: "morechannels" as const, secondaryChannel: id },
  })),
];

function missingSkillRequirements(skill: SkillStatusEntry): string | undefined {
  const missing = [
    ...skill.missing.bins,
    ...skill.missing.anyBins,
    ...skill.missing.env,
    ...skill.missing.config,
    ...skill.missing.os,
  ];
  return missing.length > 0 ? `Missing: ${missing.join(", ")}` : undefined;
}

export function AddToolsPanel({ onNavigate }: AddToolsPanelProps) {
  const [query, setQuery] = useState("");
  const [installed, setInstalled] = useState<DiscoveryEntry[]>([]);
  const [available, setAvailable] = useState<DiscoveryEntry[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [loadingAvailable, setLoadingAvailable] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [registryErrors, setRegistryErrors] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadingInstalled(true);
    const load = async () => {
      const [packs, skills, settings, statuses] = await Promise.all([
        window.electronAPI.listPluginPacks().catch(() => null),
        window.electronAPI.getSkillStatus().catch(() => null),
        window.electronAPI.getMCPSettings().catch(() => null),
        window.electronAPI.getMCPStatus().catch(() => null),
      ]);
      if (cancelled) return;
      const nextErrors: string[] = [];
      if (!packs) nextErrors.push("Feature Pack status is unavailable");
      if (!skills) nextErrors.push("Skill status is unavailable");
      if (!settings || !statuses) nextErrors.push("MCP connection status is unavailable");
      const entries: DiscoveryEntry[] = [];
      for (const pack of packs ?? []) {
        const attention = Boolean(pack.policyBlocked || pack.state === "error");
        entries.push({
          id: `pack:${pack.name}`,
          targetId: pack.name,
          name: pack.displayName || pack.name,
          description: pack.description || "Feature Pack",
          kind: "pack",
          source: "Installed Feature Pack",
          state: pack.policyBlocked
            ? "Blocked by policy"
            : pack.state === "error"
              ? "Error; workflow readiness unknown"
              : pack.enabled
                ? "Enabled; workflow readiness unknown"
                : "Disabled",
          detail: pack.recommendedConnectors?.length
            ? `Recommended connectors: ${pack.recommendedConnectors.join(", ")}`
            : undefined,
          route: { tab: "customize" },
          attention,
        });
      }
      for (const skill of skills?.skills ?? []) {
        const missing = missingSkillRequirements(skill);
        entries.push({
          id: `skill:${skill.id}`,
          targetId: skill.id,
          name: skill.name,
          description: skill.description || "Skill",
          kind: "skill",
          source: `${skill.source || "Local"} skill`,
          state: skill.blockedByAllowlist
            ? "Blocked by policy"
            : skill.disabled
              ? "Disabled"
              : missing
                ? "Missing requirements"
                : skill.eligible
                  ? "Requirements met; task success unknown"
                  : "Readiness unknown",
          detail: missing,
          route: { tab: "skills" },
          attention: Boolean(skill.blockedByAllowlist || missing),
        });
      }
      for (const server of settings?.servers ?? []) {
        const status = statuses?.find((item) => item.id === server.id);
        entries.push({
          id: `mcp:${server.id}`,
          targetId: server.id,
          name: server.name,
          description: server.description || "Configured MCP server",
          kind: "mcp",
          source: "Configured MCP server",
          state: status
            ? `${status.status[0].toUpperCase()}${status.status.slice(1)}; workflow readiness unknown`
            : "Connection status unknown",
          detail: status?.error || (!server.enabled ? "Server is disabled" : undefined),
          route: { tab: "mcp" },
          attention: status?.status === "error" || !server.enabled,
        });
      }
      setInstalled(entries);
      setErrors(nextErrors);
      setLoadingInstalled(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoadingAvailable(true);
      const term = query.trim();
      const [packs, skills, clawHubSkills, registry] = await Promise.all([
        window.electronAPI.searchPackRegistry(term, { page: 1, pageSize: 24 }).catch(() => null),
        term
          ? window.electronAPI.searchSkillRegistry(term).catch(() => null)
          : Promise.resolve(null),
        term
          ? window.electronAPI.searchClawHubSkills(term).catch(() => null)
          : Promise.resolve(null),
        window.electronAPI.fetchMCPRegistry().catch(() => null),
      ]);
      if (cancelled) return;
      const nextErrors: string[] = [];
      if (!packs) nextErrors.push("Feature Pack registry is unavailable");
      if (term && !skills) nextErrors.push("Skill Store search is unavailable");
      if (term && !clawHubSkills) nextErrors.push("ClawHub search is unavailable");
      if (!registry) nextErrors.push("MCP registry is unavailable");
      const entries: DiscoveryEntry[] = [];
      for (const integration of NATIVE_INTEGRATIONS) {
        entries.push({
          id: `native:${integration.key}`,
          targetId: integration.key,
          name: integration.name,
          description: integration.description,
          kind: "native",
          source: "Native integration",
          state: "Account and readiness unknown",
          route: { tab: "integrations" },
        });
      }
      for (const channel of CHANNEL_ENTRIES) {
        entries.push({
          id: `channel:${channel.id}`,
          targetId: channel.id,
          name: channel.name,
          description: channel.description,
          kind: "channel",
          source: "Channel settings",
          state: "Configuration and message delivery readiness unknown",
          route: channel.route,
        });
      }
      for (const pack of packs?.results ?? []) {
        entries.push({
          id: `registry-pack:${pack.id}`,
          targetId: pack.id,
          name: pack.displayName || pack.name,
          description: pack.description || "Feature Pack",
          kind: "pack",
          source: "Feature Pack registry",
          state: "Setup and readiness unknown",
          detail: pack.skillCount ? `${pack.skillCount} listed skills` : undefined,
          route: { tab: "customize" },
        });
      }
      const registrySkills = [...(skills?.results ?? []), ...(clawHubSkills?.results ?? [])].filter(
        (skill, index, all) =>
          all.findIndex(
            (candidate) => `${candidate.source}:${candidate.id}` === `${skill.source}:${skill.id}`,
          ) === index,
      );
      for (const skill of registrySkills) {
        entries.push({
          id: `registry-skill:${skill.source || "registry"}:${skill.id}`,
          targetId: skill.id,
          name: skill.name,
          description: skill.description || "Skill",
          kind: "skill",
          source: skill.source === "clawhub" ? "ClawHub" : "Skill Store",
          state: "Requirements and readiness unknown",
          route: { tab: "skills" },
        });
      }
      for (const server of registry?.servers ?? []) {
        entries.push({
          id: `registry-mcp:${server.id}`,
          targetId: server.id,
          name: server.name,
          description: server.description || "MCP server",
          kind: "mcp",
          source: "MCP registry",
          state: "Connection and readiness unknown",
          detail: server.installMethod ? `Install method: ${server.installMethod}` : undefined,
          route: { tab: "mcp" },
        });
      }
      setAvailable(entries);
      setRegistryErrors(nextErrors);
      setLoadingAvailable(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, refreshKey]);

  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    const installedKeys = new Set(
      installed.map((entry) => `${entry.kind}:${entry.name.toLowerCase()}`),
    );
    return [
      ...installed,
      ...available.filter(
        (entry) => !installedKeys.has(`${entry.kind}:${entry.name.toLowerCase()}`),
      ),
    ]
      .filter(
        (entry) =>
          !term ||
          [entry.name, entry.description, entry.source, entry.detail || ""].some((value) =>
            value.toLowerCase().includes(term),
          ),
      )
      .sort(
        (a, b) =>
          Number(Boolean(b.attention)) - Number(Boolean(a.attention)) ||
          a.name.localeCompare(b.name),
      );
  }, [available, installed, query]);

  return (
    <div className="add-tools-panel">
      <div className="add-tools-header">
        <div>
          <h2>Add tools</h2>
          <p>Discover what CoWork can use, then finish setup in the right place.</p>
        </div>
        <button
          type="button"
          className="add-tools-refresh"
          onClick={() => setRefreshKey((key) => key + 1)}
          aria-label="Refresh tool status"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      <div className="add-tools-search">
        <Search size={17} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search packs, skills, connectors, channels, and MCP servers"
          aria-label="Search tools"
        />
      </div>

      <div className="add-tools-paths">
        {PATHS.map((path) => {
          const availability = getAddToolsRouteAvailability(
            path.route.tab,
            window.coworkBrowserHost === true,
            hasHostMethods,
          );
          return (
            <button
              type="button"
              key={path.route.tab}
              className="add-tools-path"
              onClick={() => onNavigate(path.route)}
              disabled={availability.kind === "unavailable"}
              title={availability.kind === "unavailable" ? availability.message : undefined}
            >
              <strong>{path.name}</strong>
              <span>{path.description}</span>
              <small>{availability.message || path.setup}</small>
              {availability.kind !== "unavailable" && <ArrowRight size={16} aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {[...errors, ...registryErrors].length > 0 && (
        <div className="add-tools-notice" role="status">
          {[...errors, ...registryErrors].join(". ")}. Open the relevant setup screen or refresh to
          check again.
        </div>
      )}
      <div className="add-tools-results-heading">
        <div>
          <h3>{query ? "Search results" : "Tools to explore"}</h3>
          <p>
            Labels reflect catalog or setup state. They do not confirm that an action will succeed.
          </p>
        </div>
        {(loadingInstalled || loadingAvailable) && <span>Loading…</span>}
      </div>
      {results.length === 0 && !loadingInstalled && !loadingAvailable ? (
        <p className="add-tools-empty">
          No results were returned. A catalog may have no matches or its search may be unavailable;
          open the full catalog to verify.
        </p>
      ) : (
        <div className="add-tools-results">
          {results.slice(0, 30).map((entry) => {
            const availability = getAddToolsRouteAvailability(
              entry.route.tab,
              window.coworkBrowserHost === true,
              hasHostMethods,
            );
            return (
              <button
                type="button"
                key={entry.id}
                className="add-tools-result"
                onClick={() => onNavigate(entry.route, entry)}
                disabled={availability.kind === "unavailable"}
                title={availability.kind === "unavailable" ? availability.message : undefined}
              >
                <span className="add-tools-result-top">
                  <strong>{entry.name}</strong>
                  <span>{entry.source}</span>
                </span>
                <span className="add-tools-result-description">{entry.description}</span>
                <span
                  className={`add-tools-state${entry.attention ? " add-tools-state-attention" : ""}`}
                >
                  {entry.state}
                </span>
                {entry.detail && <small>{entry.detail}</small>}
                {availability.message && <small>{availability.message}</small>}
                <span className="add-tools-result-action">
                  {availability.action}
                  {availability.kind !== "unavailable" && (
                    <ArrowRight size={14} aria-hidden="true" />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {results.length > 30 && (
        <p className="add-tools-more">
          Showing 30 of {results.length} matches. Refine your search or open the relevant catalog
          above.
        </p>
      )}
      <div className="add-tools-permissions">
        <span>
          {window.coworkBrowserHost === true
            ? "Tool permissions and approvals are managed separately. System & Security settings are available in the desktop app."
            : "Tool permissions and approvals are managed separately from installation."}
        </span>
        <button
          type="button"
          onClick={() => onNavigate({ tab: "system" })}
          disabled={window.coworkBrowserHost === true}
          title={
            window.coworkBrowserHost === true
              ? "System & Security settings are available in the desktop app"
              : undefined
          }
        >
          Review System &amp; Security <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}
