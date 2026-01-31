import { useState, useEffect, useCallback } from 'react';
import {
  CustomSkill,
  SkillRegistryEntry,
  SkillStatusReport,
  SkillStatusEntry,
} from '../../shared/types';

interface SkillHubBrowserProps {
  onSkillInstalled?: (skill: CustomSkill) => void;
  onClose?: () => void;
}

export function SkillHubBrowser({ onSkillInstalled, onClose }: SkillHubBrowserProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SkillRegistryEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<SkillRegistryEntry | null>(null);
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(new Set());
  const [skillStatus, setSkillStatus] = useState<SkillStatusReport | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'browse' | 'installed' | 'status'>('installed');
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Load installed skills and status on mount
  useEffect(() => {
    loadSkillStatus();
  }, []);

  const loadSkillStatus = async (showRefreshing = false) => {
    if (showRefreshing) {
      setIsRefreshing(true);
    }
    try {
      const status = await window.electronAPI.getSkillStatus();
      setSkillStatus(status);

      // Build set of installed skill IDs
      const installed = new Set<string>();
      status.skills.forEach(skill => {
        if (skill.source === 'managed') {
          installed.add(skill.id);
        }
      });
      setInstalledSkills(installed);
    } catch (err) {
      console.error('Failed to load skill status:', err);
      setError('Failed to load skill status');
    } finally {
      setIsLoadingStatus(false);
      setIsRefreshing(false);
    }
  };

  const handleRefresh = () => {
    loadSkillStatus(true);
  };

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    setError(null);

    try {
      const result = await window.electronAPI.searchSkillRegistry(searchQuery);
      setSearchResults(result.results);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Search failed';
      setError(message);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery]);

  const handleInstall = async (skillId: string) => {
    setInstalling(skillId);
    setError(null);

    try {
      const result = await window.electronAPI.installSkillFromRegistry(skillId);

      if (result.success && result.skill) {
        setInstalledSkills(prev => new Set([...prev, skillId]));
        onSkillInstalled?.(result.skill);
        await loadSkillStatus();
      } else {
        setError(result.error || 'Installation failed');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Installation failed';
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
        setInstalledSkills(prev => {
          const next = new Set(prev);
          next.delete(skillId);
          return next;
        });
        await loadSkillStatus();
      } else {
        setError(result.error || 'Uninstall failed');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Uninstall failed';
      setError(message);
    } finally {
      setInstalling(null);
    }
  };

  const handleOpenFolder = async () => {
    await window.electronAPI.openCustomSkillsFolder();
  };

  const getStatusBadge = (entry: SkillStatusEntry) => {
    if (entry.eligible) {
      return <span className="badge badge-success">Ready</span>;
    }
    if (entry.disabled) {
      return <span className="badge badge-warning">Disabled</span>;
    }
    if (entry.blockedByAllowlist) {
      return <span className="badge badge-error">Blocked</span>;
    }
    return <span className="badge badge-ghost">Missing Requirements</span>;
  };

  const renderBrowseTab = () => (
    <div className="space-y-4">
      {/* Search */}
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Search skills..."
          className="input input-bordered flex-1"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button
          className="btn btn-primary"
          onClick={handleSearch}
          disabled={isSearching}
        >
          {isSearching ? (
            <span className="loading loading-spinner loading-sm" />
          ) : (
            'Search'
          )}
        </button>
      </div>

      {/* Search Results */}
      {searchResults.length > 0 ? (
        <div className="space-y-2">
          {searchResults.map((skill) => (
            <div
              key={skill.id}
              className={`card bg-base-200 cursor-pointer hover:bg-base-300 transition-colors ${
                selectedSkill?.id === skill.id ? 'ring-2 ring-primary' : ''
              }`}
              onClick={() => setSelectedSkill(skill)}
            >
              <div className="card-body p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{skill.icon || '📦'}</span>
                    <div>
                      <h3 className="font-semibold">{skill.name}</h3>
                      <p className="text-sm text-base-content/70">{skill.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {installedSkills.has(skill.id) ? (
                      <span className="badge badge-success">Installed</span>
                    ) : (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleInstall(skill.id);
                        }}
                        disabled={installing === skill.id}
                      >
                        {installing === skill.id ? (
                          <span className="loading loading-spinner loading-xs" />
                        ) : (
                          'Install'
                        )}
                      </button>
                    )}
                  </div>
                </div>
                {skill.tags && skill.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {skill.tags.map((tag) => (
                      <span key={tag} className="badge badge-outline badge-sm">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : searchQuery && !isSearching ? (
        <div className="text-center py-8 text-base-content/50">
          No skills found. Try a different search term.
        </div>
      ) : (
        <div className="text-center py-8 text-base-content/50">
          Search the SkillHub registry to discover and install new skills.
        </div>
      )}
    </div>
  );

  const renderInstalledTab = () => {
    const managedSkills = skillStatus?.skills.filter(s => s.source === 'managed') || [];

    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="font-semibold">Installed from Registry</h3>
          <button className="btn btn-ghost btn-sm" onClick={handleOpenFolder}>
            Open Folder
          </button>
        </div>

        {managedSkills.length > 0 ? (
          <div className="space-y-2">
            {managedSkills.map((skill) => (
              <div key={skill.id} className="card bg-base-200">
                <div className="card-body p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{skill.icon || '📦'}</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{skill.name}</h3>
                          {getStatusBadge(skill)}
                        </div>
                        <p className="text-sm text-base-content/70">{skill.description}</p>
                        {skill.metadata?.version && (
                          <p className="text-xs text-base-content/50">v{skill.metadata.version}</p>
                        )}
                      </div>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm text-error"
                      onClick={() => handleUninstall(skill.id)}
                      disabled={installing === skill.id}
                    >
                      {installing === skill.id ? (
                        <span className="loading loading-spinner loading-xs" />
                      ) : (
                        'Uninstall'
                      )}
                    </button>
                  </div>

                  {/* Missing requirements */}
                  {!skill.eligible && (
                    <div className="mt-2 text-sm">
                      {skill.missing.bins.length > 0 && (
                        <p className="text-warning">
                          Missing binaries: {skill.missing.bins.join(', ')}
                        </p>
                      )}
                      {skill.missing.env.length > 0 && (
                        <p className="text-warning">
                          Missing env vars: {skill.missing.env.join(', ')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-base-content/50">
            No skills installed from registry yet.
            <br />
            Browse the registry to discover and install skills.
          </div>
        )}
      </div>
    );
  };

  const renderStatusTab = () => {
    if (!skillStatus) {
      return (
        <div className="text-center py-8">
          <span className="loading loading-spinner" />
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {/* Summary */}
        <div className="stats stats-vertical lg:stats-horizontal shadow w-full">
          <div className="stat">
            <div className="stat-title">Total Skills</div>
            <div className="stat-value">{skillStatus.summary.total}</div>
          </div>
          <div className="stat">
            <div className="stat-title">Ready</div>
            <div className="stat-value text-success">{skillStatus.summary.eligible}</div>
          </div>
          <div className="stat">
            <div className="stat-title">Disabled</div>
            <div className="stat-value text-warning">{skillStatus.summary.disabled}</div>
          </div>
          <div className="stat">
            <div className="stat-title">Missing Deps</div>
            <div className="stat-value text-error">{skillStatus.summary.missingRequirements}</div>
          </div>
        </div>

        {/* All Skills by Source */}
        {['bundled', 'managed', 'workspace'].map((source) => {
          const skills = skillStatus.skills.filter(s => s.source === source);
          if (skills.length === 0) return null;

          return (
            <div key={source} className="collapse collapse-arrow bg-base-200">
              <input type="checkbox" defaultChecked={source !== 'bundled'} />
              <div className="collapse-title font-medium capitalize">
                {source} Skills ({skills.length})
              </div>
              <div className="collapse-content">
                <div className="space-y-2 pt-2">
                  {skills.map((skill) => (
                    <div key={skill.id} className="flex items-center justify-between py-2 border-b border-base-300 last:border-0">
                      <div className="flex items-center gap-2">
                        <span>{skill.icon || '📦'}</span>
                        <span className="font-medium">{skill.name}</span>
                      </div>
                      {getStatusBadge(skill)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Show initial loading state
  if (isLoadingStatus) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <span className="loading loading-spinner loading-lg" />
        <p className="mt-4 text-base-content/70">Loading skills...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold">SkillHub</h2>
          {isRefreshing && (
            <span className="loading loading-spinner loading-sm" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Refresh skill status"
          >
            {isRefreshing ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              '↻'
            )}
          </button>
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs tabs-boxed mb-4">
        <button
          className={`tab ${activeTab === 'installed' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('installed')}
        >
          Installed
        </button>
        <button
          className={`tab ${activeTab === 'browse' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('browse')}
        >
          Browse Registry
        </button>
        <button
          className={`tab ${activeTab === 'status' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('status')}
        >
          Status
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'browse' && renderBrowseTab()}
        {activeTab === 'installed' && renderInstalledTab()}
        {activeTab === 'status' && renderStatusTab()}
      </div>
    </div>
  );
}
