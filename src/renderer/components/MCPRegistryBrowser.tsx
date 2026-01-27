import { useState, useEffect } from 'react';

// Types (matching electron mcp types)
type MCPInstallMethod = 'npm' | 'pip' | 'binary' | 'docker' | 'manual';
type MCPTransportType = 'stdio' | 'sse' | 'websocket';

interface MCPRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  homepage?: string;
  repository?: string;
  license?: string;
  installMethod: MCPInstallMethod;
  installCommand?: string;
  packageName?: string;
  transport: MCPTransportType;
  defaultCommand?: string;
  defaultArgs?: string[];
  defaultEnv?: Record<string, string>;
  tools: Array<{ name: string; description: string }>;
  tags: string[];
  category?: string;
  verified: boolean;
  featured?: boolean;
  downloads?: number;
}

interface MCPRegistryBrowserProps {
  onInstall?: (serverId: string) => void;
  installedServerIds?: string[];
}

export function MCPRegistryBrowser({ onInstall, installedServerIds = [] }: MCPRegistryBrowserProps) {
  const [servers, setServers] = useState<MCPRegistryEntry[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [viewingDetails, setViewingDetails] = useState<MCPRegistryEntry | null>(null);

  useEffect(() => {
    loadRegistry();
  }, []);

  useEffect(() => {
    searchServers();
  }, [searchQuery, selectedCategory, selectedTags, verifiedOnly]);

  const loadRegistry = async () => {
    try {
      setLoading(true);
      const registry = await window.electronAPI.fetchMCPRegistry();
      setServers(registry.servers || []);
      // Extract unique categories from servers
      const uniqueCategories = new Set<string>();
      (registry.servers || []).forEach((s: MCPRegistryEntry) => {
        if (s.category) uniqueCategories.add(s.category);
      });
      setCategories(Array.from(uniqueCategories).sort());
    } catch (error) {
      console.error('Failed to load registry:', error);
    } finally {
      setLoading(false);
    }
  };

  const searchServers = async () => {
    try {
      const results = await window.electronAPI.searchMCPRegistry(searchQuery, selectedTags);
      let filtered = results;

      // Apply category filter
      if (selectedCategory) {
        filtered = filtered.filter((s: MCPRegistryEntry) => s.category === selectedCategory);
      }

      // Apply verified filter
      if (verifiedOnly) {
        filtered = filtered.filter((s: MCPRegistryEntry) => s.verified);
      }

      setServers(filtered);
    } catch (error) {
      console.error('Failed to search registry:', error);
    }
  };

  const handleInstall = async (entry: MCPRegistryEntry) => {
    try {
      setInstallingId(entry.id);
      await window.electronAPI.installMCPServer(entry.id);
      onInstall?.(entry.id);
      // Refresh the list
      await loadRegistry();
    } catch (error: any) {
      console.error('Failed to install server:', error);
      alert(`Failed to install ${entry.name}: ${error.message}`);
    } finally {
      setInstallingId(null);
    }
  };

  const isInstalled = (entryId: string): boolean => {
    return installedServerIds.includes(entryId);
  };

  if (loading) {
    return <div className="registry-loading">Loading MCP servers registry...</div>;
  }

  return (
    <div className="mcp-registry-browser">
      {/* Search and filters */}
      <div className="registry-filters">
        <div className="registry-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search servers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="registry-filter-row">
          <select
            className="registry-category-select"
            value={selectedCategory || ''}
            onChange={(e) => setSelectedCategory(e.target.value || null)}
          >
            <option value="">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat.charAt(0).toUpperCase() + cat.slice(1)}
              </option>
            ))}
          </select>

          <label className="registry-verified-checkbox">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
            />
            <span>Verified only</span>
          </label>
        </div>
      </div>

      {/* Server list */}
      {servers.length === 0 ? (
        <div className="registry-empty">
          <p>No servers found matching your criteria.</p>
          <button className="button-secondary" onClick={() => {
            setSearchQuery('');
            setSelectedCategory(null);
            setSelectedTags([]);
            setVerifiedOnly(false);
            loadRegistry();
          }}>
            Clear filters
          </button>
        </div>
      ) : (
        <div className="registry-server-list">
          {servers.map((entry) => (
            <div key={entry.id} className="registry-server-card">
              <div className="registry-server-header">
                <div className="registry-server-title">
                  <span className="registry-server-name">{entry.name}</span>
                  {entry.verified && (
                    <span className="registry-verified-badge" title="Verified by MCP maintainers">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </span>
                  )}
                  {entry.featured && (
                    <span className="registry-featured-badge">Featured</span>
                  )}
                </div>
                <span className="registry-server-version">v{entry.version}</span>
              </div>

              <p className="registry-server-description">{entry.description}</p>

              <div className="registry-server-meta">
                <span className="registry-author">by {entry.author}</span>
                <span className="registry-tools-count">{entry.tools.length} tools</span>
                {entry.category && (
                  <span className="registry-category">{entry.category}</span>
                )}
              </div>

              <div className="registry-server-tags">
                {entry.tags.slice(0, 5).map((tag) => (
                  <span
                    key={tag}
                    className="registry-tag"
                    onClick={() => setSelectedTags([tag])}
                  >
                    {tag}
                  </span>
                ))}
              </div>

              <div className="registry-server-actions">
                {isInstalled(entry.id) ? (
                  <span className="registry-installed-badge">Installed</span>
                ) : (
                  <button
                    className="button-primary"
                    onClick={() => handleInstall(entry)}
                    disabled={installingId === entry.id}
                  >
                    {installingId === entry.id ? 'Installing...' : 'Install'}
                  </button>
                )}
                <button
                  className="button-secondary"
                  onClick={() => setViewingDetails(entry)}
                >
                  Details
                </button>
                {entry.homepage && (
                  <a
                    href={entry.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="registry-link"
                    onClick={(e) => {
                      e.preventDefault();
                      window.electronAPI.openExternal(entry.homepage!);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Details modal */}
      {viewingDetails && (
        <div className="mcp-modal-overlay" onClick={() => setViewingDetails(null)}>
          <div className="mcp-modal registry-details-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mcp-modal-header">
              <div className="registry-details-title">
                <h3>{viewingDetails.name}</h3>
                {viewingDetails.verified && (
                  <span className="registry-verified-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Verified
                  </span>
                )}
              </div>
              <button className="mcp-modal-close" onClick={() => setViewingDetails(null)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="mcp-modal-content">
              <div className="registry-details-section">
                <p className="registry-details-description">{viewingDetails.description}</p>

                <div className="registry-details-info">
                  <div className="registry-detail-row">
                    <span className="registry-detail-label">Version:</span>
                    <span className="registry-detail-value">{viewingDetails.version}</span>
                  </div>
                  <div className="registry-detail-row">
                    <span className="registry-detail-label">Author:</span>
                    <span className="registry-detail-value">{viewingDetails.author}</span>
                  </div>
                  <div className="registry-detail-row">
                    <span className="registry-detail-label">License:</span>
                    <span className="registry-detail-value">{viewingDetails.license || 'Not specified'}</span>
                  </div>
                  <div className="registry-detail-row">
                    <span className="registry-detail-label">Transport:</span>
                    <span className="registry-detail-value">{viewingDetails.transport}</span>
                  </div>
                  <div className="registry-detail-row">
                    <span className="registry-detail-label">Install Method:</span>
                    <span className="registry-detail-value">{viewingDetails.installMethod}</span>
                  </div>
                </div>

                {viewingDetails.defaultCommand && (
                  <div className="registry-details-command">
                    <span className="registry-detail-label">Command:</span>
                    <code>
                      {viewingDetails.defaultCommand} {viewingDetails.defaultArgs?.join(' ')}
                    </code>
                  </div>
                )}

                {viewingDetails.defaultEnv && Object.keys(viewingDetails.defaultEnv).length > 0 && (
                  <div className="registry-details-env">
                    <span className="registry-detail-label">Required Environment Variables:</span>
                    <ul>
                      {Object.entries(viewingDetails.defaultEnv).map(([key, value]) => (
                        <li key={key}>
                          <code>{key}</code>
                          {value && <span> (default: {value})</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="registry-details-section">
                <h4>Available Tools ({viewingDetails.tools.length})</h4>
                <div className="registry-tools-list">
                  {viewingDetails.tools.map((tool) => (
                    <div key={tool.name} className="registry-tool-item">
                      <span className="registry-tool-name">{tool.name}</span>
                      <span className="registry-tool-desc">{tool.description}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="registry-details-section">
                <div className="registry-server-tags">
                  {viewingDetails.tags.map((tag) => (
                    <span key={tag} className="registry-tag">{tag}</span>
                  ))}
                </div>
              </div>

              <div className="registry-details-actions">
                {isInstalled(viewingDetails.id) ? (
                  <span className="registry-installed-badge">Already Installed</span>
                ) : (
                  <button
                    className="button-primary"
                    onClick={() => {
                      handleInstall(viewingDetails);
                      setViewingDetails(null);
                    }}
                    disabled={installingId === viewingDetails.id}
                  >
                    {installingId === viewingDetails.id ? 'Installing...' : 'Install Server'}
                  </button>
                )}
                {viewingDetails.repository && (
                  <button
                    className="button-secondary"
                    onClick={() => window.electronAPI.openExternal(viewingDetails.repository!)}
                  >
                    View Source
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
