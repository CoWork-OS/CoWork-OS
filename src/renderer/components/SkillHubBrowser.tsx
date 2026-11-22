import { useState, useEffect, useCallback, useRef } from "react";
import { hasHostMethod, hasHostMethods } from "../host/browser-capabilities";
import type { AddToolsSelection } from "./AddToolsPanel";
import {
  CapabilitySecurityReport,
  CustomSkill,
  InstallSecurityOutcome,
  QuarantinedImportRecord,
  SkillRegistryEntry,
  SkillStatusReport,
  SkillStatusEntry,
} from "../../shared/types";

const compactNumberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function isLikelyGitSkillSource(rawValue: string): boolean {
  const value = rawValue.trim();
  if (!value) {
    return false;
  }

  if (/^git@/i.test(value) || /^github:/i.test(value)) {
    return true;
  }

  if (!/^https?:\/\//i.test(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const pathParts = parsed.pathname.replace(/\/+$/g, "").split("/").filter(Boolean);
    const lastSegment = pathParts[pathParts.length - 1]?.toLowerCase() || "";
    return lastSegment.endsWith(".git") || host === "github.com" || host.endsWith(".github.com");
  } catch {
    return false;
  }
}

function formatCompactCount(value?: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return compactNumberFormatter.format(value);
}

function isClawHubSkillSource(rawValue: string): boolean {
  const value = rawValue.trim();
  if (!value) {
    return false;
  }

  if (/^clawhub:/i.test(value)) {
    return true;
  }

  if (!/^https?:\/\//i.test(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const pathParts = parsed.pathname.replace(/\/+$/g, "").split("/").filter(Boolean);
    return host === "clawhub.ai" && pathParts.length >= 2 && pathParts[0] !== "skills";
  } catch {
    return false;
  }
}

function getClawHubSlug(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  if (/^clawhub:/i.test(value)) {
    const slug = value.slice("clawhub:".length).trim().toLowerCase();
    return slug || null;
  }

  if (!/^https?:\/\//i.test(value)) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "clawhub.ai") {
      return null;
    }
    const pathParts = parsed.pathname.replace(/\/+$/g, "").split("/").filter(Boolean);
    if (pathParts.length === 0 || pathParts[0] === "skills") {
      return null;
    }
    return pathParts[pathParts.length - 1]?.toLowerCase() || null;
  } catch {
    return null;
  }
}

interface SkillHubBrowserProps {
  onSkillInstalled?: (skill: CustomSkill) => void;
  onClose?: () => void;
  initialSelection?: AddToolsSelection;
}

type BrowserSkillInstallProgress = {
  status: "starting" | "downloading" | "checking" | "installing" | "completed" | "failed";
  progress: number;
  message: string;
};

type BrowserSkillInstallApi = {
  getSkillInstallProgress?: () => Promise<BrowserSkillInstallProgress | null>;
};

type SkillCatalog = "browse" | "clawhub";
type CatalogSearch = { query: string } & (
  | { status: "loading" }
  | { status: "done"; results: SkillRegistryEntry[] }
  | { status: "error"; message: string }
);

export function SkillHubBrowser({
  onSkillInstalled,
  onClose,
  initialSelection,
}: SkillHubBrowserProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [clawHubQuery, setClawHubQuery] = useState("");
  const [searches, setSearches] = useState<Partial<Record<SkillCatalog, CatalogSearch>>>({});
  const searchRequests = useRef<Partial<Record<SkillCatalog, { query: string }>>>({});
  const [selectedSkill, setSelectedSkill] = useState<SkillRegistryEntry | null>(null);
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(new Set());
  const [skillStatus, setSkillStatus] = useState<SkillStatusReport | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<BrowserSkillInstallProgress | null>(null);
  const [externalSource, setExternalSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [quarantinedSkills, setQuarantinedSkills] = useState<QuarantinedImportRecord[]>([]);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"browse" | "clawhub" | "installed" | "status">(
    "installed",
  );
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const focusedSelection = useRef<string | null>(null);

  useEffect(() => {
    if (!installing || !hasHostMethod("getSkillInstallProgress")) {
      setInstallProgress(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const progress = await (
          window.electronAPI as unknown as BrowserSkillInstallApi
        ).getSkillInstallProgress?.();
        if (!cancelled && progress) setInstallProgress(progress);
      } catch {
        // The install call reports the final outcome; progress polling is optional.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [installing]);

  useEffect(() => {
    loadSkillStatus();
  }, []);

  const loadSkillStatus = async (showRefreshing = false) => {
    if (showRefreshing) {
      setIsRefreshing(true);
    }
    try {
      const status = await window.electronAPI.getSkillStatus();
      const quarantine = await window.electronAPI.listQuarantinedImports();
      setSkillStatus(status);
      setQuarantinedSkills(quarantine.filter((entry) => entry.bundleKind === "skill"));

      const installed = new Set<string>();
      status.skills.forEach((skill) => {
        if (skill.source === "managed") {
          installed.add(skill.id);
          const clawHubSlug =
            getClawHubSlug(skill.metadata?.homepage || "") ||
            getClawHubSlug(skill.metadata?.repository || "");
          if (clawHubSlug) {
            installed.add(clawHubSlug);
          }
        }
      });
      setInstalledSkills(installed);
    } catch (err) {
      console.error("Failed to load skill status:", err);
      setError("Failed to load skill status");
    } finally {
      setIsLoadingStatus(false);
      setIsRefreshing(false);
    }
  };

  const handleRefresh = () => {
    loadSkillStatus(true);
  };

  const installMessageForOutcome = (
    outcome: InstallSecurityOutcome | undefined,
    fallback: string,
  ): string => {
    if (!outcome) {
      return fallback;
    }

    switch (outcome.state) {
      case "installed_with_warning":
        return outcome.summary || "Installed with security warning";
      case "quarantined":
        return outcome.summary || "Import quarantined";
      case "installed":
        return outcome.summary || fallback;
      default:
        return fallback;
    }
  };

  const getSecurityBadge = (report?: CapabilitySecurityReport) => {
    if (!report) {
      return null;
    }
    if (report.verdict === "quarantined") {
      return <span className="settings-badge settings-badge--error">Quarantined</span>;
    }
    if (report.verdict === "warning") {
      return <span className="settings-badge settings-badge--warning">Security Warning</span>;
    }
    return null;
  };

  const searchCatalog = useCallback(
    async (catalog: SkillCatalog, input: string, targetId?: string) => {
      const query = input.trim();
      if (!query && catalog === "browse") return;
      if (!targetId && searchRequests.current[catalog]?.query === query) return;

      const request = { query };
      searchRequests.current[catalog] = request;
      setSearches((current) => ({ ...current, [catalog]: { query, status: "loading" } }));

      let search: CatalogSearch;
      try {
        const { results } =
          catalog === "browse"
            ? await window.electronAPI.searchSkillRegistry(query)
            : await window.electronAPI.searchClawHubSkills(
                query,
                query ? undefined : { pageSize: 10 },
              );
        search = { query, status: "done", results };
      } catch (error: unknown) {
        search = {
          query,
          status: "error",
          message: error instanceof Error ? error.message : "Search failed",
        };
      }

      if (searchRequests.current[catalog] !== request) return;
      delete searchRequests.current[catalog];
      setSearches((current) => ({ ...current, [catalog]: search }));
      if (targetId && search.status === "done") {
        setSelectedSkill(
          search.results.find(
            (skill) => skill.id === targetId || skill.name.toLowerCase() === query.toLowerCase(),
          ) || null,
        );
      }
    },
    [],
  );

  const trimmedClawHubQuery = clawHubQuery.trim();
  const registrySearch = searches.browse?.query === searchQuery.trim() ? searches.browse : null;
  const clawHubSearch = searches.clawhub?.query === trimmedClawHubQuery ? searches.clawhub : null;
  const isSearching = registrySearch?.status === "loading";
  const isSearchingClawHub = clawHubSearch?.status === "loading";

  useEffect(() => {
    if (!initialSelection || focusedSelection.current === initialSelection.id) return;
    const targetId = initialSelection.targetId || initialSelection.id;
    const source = initialSelection.source.toLowerCase();
    const isClawHub = source.includes("clawhub");
    const isInstalled = ["bundled", "managed", "workspace", "local"].some((value) =>
      source.includes(value),
    );
    if (isInstalled) {
      setActiveTab("installed");
      if (!skillStatus) return;
      focusedSelection.current = initialSelection.id;
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-skill-id="${CSS.escape(targetId)}"]`)
          ?.scrollIntoView({ block: "center" });
      });
      return;
    }

    focusedSelection.current = initialSelection.id;
    setActiveTab(isClawHub ? "clawhub" : "browse");
    (isClawHub ? setClawHubQuery : setSearchQuery)(initialSelection.name);
    void searchCatalog(isClawHub ? "clawhub" : "browse", initialSelection.name, targetId);
  }, [initialSelection, skillStatus, searchCatalog]);

  useEffect(() => {
    if (activeTab === "clawhub" && !trimmedClawHubQuery) {
      void searchCatalog("clawhub", "");
    }
  }, [activeTab, trimmedClawHubQuery, searchCatalog]);

  const renderStatsLine = (skill: SkillRegistryEntry) => {
    const stars = formatCompactCount(skill.stars);
    const downloads = formatCompactCount(skill.downloads);
    const installsCurrent = formatCompactCount(skill.installsCurrent);
    const installsAllTime = formatCompactCount(skill.installsAllTime);
    const parts = [
      stars ? `⭐ ${stars}` : null,
      downloads ? `${downloads} downloads` : null,
      installsCurrent ? `${installsCurrent} current installs` : null,
      installsAllTime ? `${installsAllTime} all-time installs` : null,
    ].filter((value): value is string => Boolean(value));

    if (parts.length === 0) {
      return null;
    }

    return <p className="skillhub-meta">{parts.join(" · ")}</p>;
  };

  const installSucceeded = async (skill: CustomSkill) => {
    setInstalledSkills((prev) => new Set([...prev, skill.id]));
    onSkillInstalled?.(skill);
    await loadSkillStatus();
  };

  const handleInstall = async (skillId: string) => {
    setInstalling(skillId);
    setError(null);

    try {
      const result = await window.electronAPI.installSkillFromRegistry(skillId);

      if (result.success && result.skill) {
        await installSucceeded(result.skill);
      } else {
        setError(installMessageForOutcome(result.security, result.error || "Installation failed"));
        await loadSkillStatus();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Installation failed";
      setError(message);
    } finally {
      setInstalling(null);
    }
  };

  const handleClawHubInstall = async (skillId: string) => {
    setInstalling(skillId);
    setError(null);

    try {
      const result = await window.electronAPI.installSkillFromClawHub(skillId);

      if (result.success && result.skill) {
        await installSucceeded(result.skill);
      } else {
        setError(installMessageForOutcome(result.security, result.error || "Installation failed"));
        await loadSkillStatus();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Installation failed";
      setError(message);
    } finally {
      setInstalling(null);
    }
  };

  const handleExternalInstall = async () => {
    if (!hasHostMethods("installSkillFromClawHub", "installSkillFromGit", "installSkillFromUrl")) {
      setError("Import skills in the desktop app.");
      return;
    }
    const source = externalSource.trim();
    if (!source) {
      setError("Paste a Git repository, ClawHub URL, or raw skill URL first");
      return;
    }

    setInstalling("__external__");
    setError(null);

    try {
      const result = isClawHubSkillSource(source)
        ? await window.electronAPI.installSkillFromClawHub(source)
        : isLikelyGitSkillSource(source)
          ? await window.electronAPI.installSkillFromGit(source)
          : await window.electronAPI.installSkillFromUrl(source);

      if (result.success && result.skill) {
        setExternalSource("");
        await installSucceeded(result.skill);
        setActiveTab("installed");
        // A multi-skill Git repository can install partially; say which skills were skipped.
        if (result.error) {
          setError(result.error);
        }
      } else {
        setError(installMessageForOutcome(result.security, result.error || "Import failed"));
        await loadSkillStatus();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Import failed";
      setError(message);
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async (skillId: string) => {
    if (!confirm(`Are you sure you want to uninstall "${skillId}"?`)) {
      return;
    }

    setInstalling(skillId);
    setError(null);

    try {
      const result = await window.electronAPI.uninstallSkill(skillId);

      if (result.success) {
        setInstalledSkills((prev) => {
          const next = new Set(prev);
          next.delete(skillId);
          return next;
        });
        await loadSkillStatus();
      } else {
        setError(result.error || "Uninstall failed");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Uninstall failed";
      setError(message);
    } finally {
      setInstalling(null);
    }
  };

  const handleOpenFolder = async () => {
    await window.electronAPI.openCustomSkillsFolder();
  };

  const handleRetryQuarantined = async (recordId: string) => {
    setInstalling(recordId);
    setError(null);
    try {
      const result = await window.electronAPI.retryQuarantinedImport(recordId);
      if (!result.success) {
        setError(result.outcome.summary || result.error || "Retry scan failed");
      }
      await loadSkillStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Retry scan failed");
    } finally {
      setInstalling(null);
    }
  };

  const handleRemoveQuarantined = async (recordId: string) => {
    setInstalling(recordId);
    setError(null);
    try {
      const result = await window.electronAPI.removeQuarantinedImport(recordId);
      if (!result.success) {
        setError(result.error || "Failed to remove quarantined import");
      }
      await loadSkillStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to remove quarantined import");
    } finally {
      setInstalling(null);
    }
  };

  const getStatusBadge = (entry: SkillStatusEntry) => {
    if (entry.eligible) {
      return <span className="settings-badge settings-badge--success">Ready</span>;
    }
    if (entry.disabled) {
      return <span className="settings-badge settings-badge--warning">Disabled</span>;
    }
    if (entry.blockedByAllowlist) {
      return <span className="settings-badge settings-badge--error">Blocked</span>;
    }
    return <span className="settings-badge settings-badge--neutral">Missing Requirements</span>;
  };

  // Managed skills that override a built-in skill of the same id (the user's own copies).
  const overridesBuiltInIds = new Set(
    (skillStatus?.shadowedSkills || [])
      .filter((entry) => entry.reason === "overridden_by_managed")
      .map((entry) => entry.id),
  );

  const getOverrideBadge = (entry: SkillStatusEntry) =>
    entry.source === "managed" && overridesBuiltInIds.has(entry.id) ? (
      <span
        className="settings-badge settings-badge--outline"
        title="This installed skill replaces the built-in skill with the same id."
      >
        Overrides built-in
      </span>
    ) : null;

  const renderSearchResults = (
    results: SkillRegistryEntry[],
    onInstall: (skillId: string) => void,
  ) => (
    <div className="skillhub-list">
      {results.map((skill) => (
        <div
          key={`${skill.source || "cowork"}:${skill.id}`}
          className={`settings-card skillhub-card ${selectedSkill?.id === skill.id ? "is-selected" : ""}`}
          onClick={() => setSelectedSkill(skill)}
        >
          <div className="skillhub-card-header">
            <div className="skillhub-card-info">
              <span className="skillhub-icon">{skill.icon || "📦"}</span>
              <div>
                <div className="skillhub-title-row">
                  <h4 className="skillhub-title">{skill.name}</h4>
                  {skill.source === "clawhub" && (
                    <span className="settings-badge settings-badge--outline">ClawHub</span>
                  )}
                </div>
                <p className="settings-description skillhub-description">{skill.description}</p>
                {(skill.author || skill.version) && (
                  <p className="skillhub-meta">
                    {skill.author ? `${skill.author} · ` : ""}v{skill.version}
                  </p>
                )}
                {renderStatsLine(skill)}
              </div>
            </div>
            <div className="skillhub-card-actions">
              {installedSkills.has(skill.id) ? (
                <span className="settings-badge settings-badge--success">Installed</span>
              ) : (
                <button
                  className="button-primary button-small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onInstall(skill.id);
                  }}
                  disabled={
                    installing === skill.id ||
                    !hasHostMethod(
                      skill.source === "clawhub"
                        ? "installSkillFromClawHub"
                        : "installSkillFromRegistry",
                    )
                  }
                  title={
                    !hasHostMethod(
                      skill.source === "clawhub"
                        ? "installSkillFromClawHub"
                        : "installSkillFromRegistry",
                    )
                      ? "Install skills in the desktop app"
                      : undefined
                  }
                >
                  {installing === skill.id ? "Installing..." : "Install"}
                </button>
              )}
            </div>
          </div>
          {skill.tags && skill.tags.length > 0 && (
            <div className="skillhub-tags">
              {skill.tags.map((tag) => (
                <span key={tag} className="settings-badge settings-badge--outline">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const renderExternalImportCard = () => (
    <div className="settings-card">
      <div className="settings-section-header">
        <div>
          <h4>Import External Skill</h4>
          <p className="settings-description">
            Paste a Git repository, ClawHub skill page URL, raw skill JSON URL, or raw{" "}
            <code>SKILL.md</code> URL to bring third-party skills into CoWork OS.
          </p>
        </div>
      </div>
      <div className="input-with-button">
        <input
          type="text"
          placeholder="https://clawhub.ai/owner/skill or https://github.com/org/skill-repo"
          className="settings-input"
          value={externalSource}
          disabled={
            !hasHostMethods("installSkillFromClawHub", "installSkillFromGit", "installSkillFromUrl")
          }
          onChange={(e) => setExternalSource(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleExternalInstall()}
        />
        <button
          className="button-primary button-small"
          onClick={handleExternalInstall}
          disabled={
            installing === "__external__" ||
            !hasHostMethods("installSkillFromClawHub", "installSkillFromGit", "installSkillFromUrl")
          }
          title={
            !hasHostMethods("installSkillFromClawHub", "installSkillFromGit", "installSkillFromUrl")
              ? "Import skills in the desktop app"
              : undefined
          }
        >
          {installing === "__external__" ? "Installing..." : "Import"}
        </button>
      </div>
    </div>
  );

  const renderBrowseTab = () => (
    <div className="skillhub-tab">
      {renderExternalImportCard()}

      <form
        className="input-with-button"
        onSubmit={(event) => {
          event.preventDefault();
          void searchCatalog("browse", searchQuery);
        }}
      >
        <input
          type="text"
          placeholder="Search CoWork registry..."
          aria-label="Search CoWork registry"
          className="settings-input"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button
          type="submit"
          className="button-secondary button-small"
          disabled={!searchQuery.trim() || isSearching}
        >
          {isSearching ? "Searching..." : "Search"}
        </button>
      </form>

      {registrySearch?.status === "done" ? (
        registrySearch.results.length > 0 ? (
          renderSearchResults(registrySearch.results, handleInstall)
        ) : (
          <div className="settings-empty">
            No results were returned. The registry may have no matches or its search may be
            unavailable; try another term or refresh.
          </div>
        )
      ) : registrySearch?.status === "error" ? (
        <div className="settings-alert settings-alert-error" role="alert">
          {registrySearch.message}
        </div>
      ) : isSearching ? (
        <div className="settings-empty">Searching registry...</div>
      ) : (
        <div className="settings-empty">
          Search the CoWork registry to discover and install curated skills.
        </div>
      )}
    </div>
  );

  const renderClawHubTab = () => (
    <div className="skillhub-tab">
      {renderExternalImportCard()}

      <div className="settings-card">
        <div className="settings-section-header">
          <div>
            <h4>Browse ClawHub</h4>
            <p className="settings-description">
              Search live ClawHub skills and install them directly.
            </p>
          </div>
        </div>
      </div>

      <form
        className="input-with-button"
        onSubmit={(event) => {
          event.preventDefault();
          void searchCatalog("clawhub", clawHubQuery);
        }}
      >
        <input
          type="text"
          placeholder="Search ClawHub skills..."
          aria-label="Search ClawHub skills"
          className="settings-input"
          value={clawHubQuery}
          onChange={(e) => setClawHubQuery(e.target.value)}
        />
        <button
          type="submit"
          className="button-secondary button-small"
          disabled={isSearchingClawHub}
        >
          {isSearchingClawHub ? "Searching..." : "Search"}
        </button>
      </form>

      {clawHubSearch?.status === "done" &&
        !clawHubSearch.query &&
        clawHubSearch.results.length > 0 && (
          <div className="settings-section-header">
            <div>
              <h4>Top Downloads</h4>
              <p className="settings-description">
                The 10 most-downloaded public ClawHub skills right now.
              </p>
            </div>
          </div>
        )}

      {clawHubSearch?.status === "done" && clawHubSearch.results.length > 0 ? (
        renderSearchResults(clawHubSearch.results, handleClawHubInstall)
      ) : clawHubSearch?.status === "error" ? (
        <div className="settings-alert settings-alert-error" role="alert">
          {clawHubSearch.message}
        </div>
      ) : clawHubSearch?.status === "done" && clawHubSearch.query ? (
        <div className="settings-empty">
          No results were returned. ClawHub may have no matches or its search may be unavailable;
          try the exact slug or paste a ClawHub page URL above.
        </div>
      ) : isSearchingClawHub ? (
        <div className="settings-empty">
          {trimmedClawHubQuery ? "Searching ClawHub..." : "Loading popular ClawHub skills..."}
        </div>
      ) : (
        <div className="settings-empty">
          Search ClawHub by name or slug, or paste a ClawHub page URL above.
        </div>
      )}
    </div>
  );

  const renderInstalledTab = () => {
    const managedSkills = skillStatus?.skills.filter((s) => s.source === "managed") || [];

    return (
      <div className="skillhub-tab">
        <div className="settings-section-header">
          <h3>Installed Skills</h3>
          <div className="settings-section-actions">
            <button
              className="button-secondary button-small"
              onClick={handleOpenFolder}
              disabled={!hasHostMethod("openCustomSkillsFolder")}
              title={
                !hasHostMethod("openCustomSkillsFolder")
                  ? "Open the skills folder in the desktop app"
                  : undefined
              }
            >
              Open Folder
            </button>
          </div>
        </div>

        {quarantinedSkills.length > 0 && (
          <div className="settings-card skillhub-quarantine-card">
            <div className="settings-section-header">
              <div>
                <h4>Quarantined Imports</h4>
                <p className="settings-description">
                  These skill imports were stored safely and blocked from activation.
                </p>
              </div>
            </div>
            <div className="skillhub-quarantine-list">
              {quarantinedSkills.map((record) => (
                <div key={record.id} className="skillhub-quarantine-item">
                  <div>
                    <div className="skillhub-title-row">
                      <strong>{record.displayName || record.bundleId}</strong>
                      <span className="settings-badge settings-badge--error">Quarantined</span>
                    </div>
                    <p className="settings-description skillhub-description">{record.summary}</p>
                  </div>
                  <div className="skillhub-quarantine-actions">
                    <button
                      className="button-secondary button-small"
                      onClick={() =>
                        setExpandedReportId((current) => (current === record.id ? null : record.id))
                      }
                    >
                      {expandedReportId === record.id ? "Hide Report" : "View Report"}
                    </button>
                    <button
                      className="button-secondary button-small"
                      onClick={() => handleRetryQuarantined(record.id)}
                      disabled={
                        installing === record.id || !hasHostMethod("retryQuarantinedImport")
                      }
                      title={
                        !hasHostMethod("retryQuarantinedImport")
                          ? "Retry skill scans in the desktop app"
                          : undefined
                      }
                    >
                      {installing === record.id ? "Scanning..." : "Retry Scan"}
                    </button>
                    <button
                      className="button-danger button-small"
                      onClick={() => handleRemoveQuarantined(record.id)}
                      disabled={
                        installing === record.id || !hasHostMethod("removeQuarantinedImport")
                      }
                      title={
                        !hasHostMethod("removeQuarantinedImport")
                          ? "Remove quarantined imports in the desktop app"
                          : undefined
                      }
                    >
                      Remove
                    </button>
                  </div>
                  {expandedReportId === record.id && (
                    <div className="skillhub-report">
                      {record.report.findings.map((finding, index) => (
                        <p key={`${record.id}-${index}`}>
                          <strong>{finding.severity}</strong>: {finding.message}
                          {finding.path ? ` (${finding.path})` : ""}
                        </p>
                      ))}
                      {record.report.findings.length === 0 && (
                        <p>No detailed findings available.</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {managedSkills.length > 0 ? (
          <div className="skillhub-list">
            {managedSkills.map((skill) => (
              <div key={skill.id} className="settings-card skillhub-card">
                <div className="skillhub-card-header">
                  <div className="skillhub-card-info">
                    <span className="skillhub-icon">{skill.icon || "📦"}</span>
                    <div>
                      <div className="skillhub-title-row">
                        <h4 className="skillhub-title">{skill.name}</h4>
                        {getStatusBadge(skill)}
                        {getSecurityBadge(skill.securityReport)}
                        {getOverrideBadge(skill)}
                        {skill.category === "ClawHub" && (
                          <span className="settings-badge settings-badge--outline">ClawHub</span>
                        )}
                      </div>
                      <p className="settings-description skillhub-description">
                        {skill.description}
                      </p>
                      {skill.metadata?.version && (
                        <p className="skillhub-meta">v{skill.metadata.version}</p>
                      )}
                    </div>
                  </div>
                  <button
                    className="button-danger button-small"
                    onClick={() => handleUninstall(skill.id)}
                    disabled={installing === skill.id || !hasHostMethod("uninstallSkill")}
                    title={
                      !hasHostMethod("uninstallSkill")
                        ? "Remove skills in the desktop app"
                        : undefined
                    }
                  >
                    {installing === skill.id ? "Uninstalling..." : "Uninstall"}
                  </button>
                </div>

                {!skill.eligible && (
                  <div className="skillhub-warnings">
                    {skill.missing.bins.length > 0 && (
                      <p>Missing binaries: {skill.missing.bins.join(", ")}</p>
                    )}
                    {skill.missing.env.length > 0 && (
                      <p>Missing env vars: {skill.missing.env.join(", ")}</p>
                    )}
                  </div>
                )}
                {skill.securityReport?.verdict === "warning" && (
                  <div className="skillhub-warnings">
                    <p>{skill.securityReport.summary}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-empty">
            No managed skills installed yet.
            <br />
            Browse the registry, ClawHub, or import a bundle to add one.
          </div>
        )}
      </div>
    );
  };

  const renderStatusTab = () => {
    if (!skillStatus) {
      return <div className="settings-empty">Loading skill status...</div>;
    }
    const staleCopies = (skillStatus.shadowedSkills || []).filter(
      (entry) => entry.reason === "stale_bundled_copy",
    );

    return (
      <div className="skillhub-tab">
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Total Skills</div>
            <div className="stat-value">{skillStatus.summary.total}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Ready</div>
            <div className="stat-value stat-value--success">{skillStatus.summary.eligible}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Disabled</div>
            <div className="stat-value stat-value--warning">{skillStatus.summary.disabled}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Missing Deps</div>
            <div className="stat-value stat-value--error">
              {skillStatus.summary.missingRequirements}
            </div>
          </div>
        </div>

        {staleCopies.length > 0 && (
          <div className="settings-card skillhub-shadowed">
            <p className="settings-description">
              {staleCopies.length === 1
                ? "1 saved copy of a built-in skill matches an older built-in version"
                : `${staleCopies.length} saved copies of built-in skills match an older built-in version`}
              , so the current built-in {staleCopies.length === 1 ? "skill is" : "skills are"} used
              instead: {staleCopies.map((entry) => entry.name).join(", ")}. The old files stay in
              the skills folder and can be deleted there.
            </p>
          </div>
        )}

        {["bundled", "managed", "workspace"].map((source) => {
          const skills = skillStatus.skills.filter((s) => s.source === source);
          if (skills.length === 0) return null;

          return (
            <details
              key={source}
              className="skillhub-group"
              open={source !== "bundled" || initialSelection?.source.toLowerCase().includes(source)}
            >
              <summary>
                <span className="skillhub-group-title">{source} Skills</span>
                <span className="settings-badge settings-badge--neutral">{skills.length}</span>
              </summary>
              <div className="skillhub-group-content">
                {skills.map((skill) => (
                  <div key={skill.id} className="skillhub-group-item" data-skill-id={skill.id}>
                    <div className="skillhub-group-info">
                      <span>{skill.icon || "📦"}</span>
                      <span>{skill.name}</span>
                    </div>
                    <div className="skillhub-group-badges">
                      {getStatusBadge(skill)}
                      {getSecurityBadge(skill.securityReport)}
                      {getOverrideBadge(skill)}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    );
  };

  if (isLoadingStatus) {
    return <div className="settings-loading">Loading skills...</div>;
  }

  return (
    <div className="skillhub-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h3>SkillHub</h3>
            <p className="settings-description">
              Manage curated skills, browse ClawHub, and import third-party skill bundles.
            </p>
          </div>
          <div className="settings-section-actions">
            <button
              className="button-secondary button-small"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
            {onClose && (
              <button className="button-secondary button-small" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>

      {!hasHostMethods("installSkillFromRegistry", "uninstallSkill") && (
        <p className="settings-description" role="status">
          Browse skills and check their status here. Install, import, remove, or rescan skills in
          the desktop app.
        </p>
      )}

      {error && (
        <div className="settings-alert settings-alert-error">
          <span>{error}</span>
          <button className="button-secondary button-small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {installing && installProgress && (
        <div className="settings-card" role="status" aria-live="polite">
          <div className="settings-section-header">
            <strong>{installProgress.message}</strong>
            <span>{installProgress.progress}%</span>
          </div>
          <progress max={100} value={Math.max(0, Math.min(100, installProgress.progress))} />
        </div>
      )}

      <div className="settings-tabs">
        <button
          className={`settings-tab ${activeTab === "installed" ? "active" : ""}`}
          onClick={() => setActiveTab("installed")}
        >
          Installed
        </button>
        <button
          className={`settings-tab ${activeTab === "browse" ? "active" : ""}`}
          onClick={() => setActiveTab("browse")}
        >
          CoWork Registry
        </button>
        <button
          className={`settings-tab ${activeTab === "clawhub" ? "active" : ""}`}
          onClick={() => setActiveTab("clawhub")}
        >
          ClawHub
        </button>
        <button
          className={`settings-tab ${activeTab === "status" ? "active" : ""}`}
          onClick={() => setActiveTab("status")}
        >
          Status
        </button>
      </div>

      <div className="skillhub-tab-content">
        {activeTab === "browse" && renderBrowseTab()}
        {activeTab === "clawhub" && renderClawHubTab()}
        {activeTab === "installed" && renderInstalledTab()}
        {activeTab === "status" && renderStatusTab()}
      </div>
    </div>
  );
}
