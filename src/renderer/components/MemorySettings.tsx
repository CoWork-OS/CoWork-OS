import { useState, useEffect } from 'react';
import { ChatGPTImportWizard } from './ChatGPTImportWizard';

// Types inlined since preload types aren't directly importable in renderer
type PrivacyMode = 'normal' | 'strict' | 'disabled';

interface MemorySettings {
  workspaceId: string;
  enabled: boolean;
  autoCapture: boolean;
  compressionEnabled: boolean;
  retentionDays: number;
  maxStorageMb: number;
  privacyMode: PrivacyMode;
  excludedPatterns?: string[];
}

interface MemoryStats {
  count: number;
  totalTokens: number;
  compressedCount: number;
  compressionRatio: number;
}

interface MemorySettingsProps {
  workspaceId: string;
  onSettingsChanged?: () => void;
}

export function MemorySettings({ workspaceId, onSettingsChanged }: MemorySettingsProps) {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);

  useEffect(() => {
    if (workspaceId) {
      loadData();
    }
  }, [workspaceId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [loadedSettings, loadedStats] = await Promise.all([
        window.electronAPI.getMemorySettings(workspaceId),
        window.electronAPI.getMemoryStats(workspaceId),
      ]);
      setSettings(loadedSettings);
      setStats(loadedStats);
    } catch (error) {
      console.error('Failed to load memory settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (updates: Partial<MemorySettings>) => {
    if (!settings) return;
    try {
      setSaving(true);
      await window.electronAPI.saveMemorySettings({ workspaceId, settings: updates });
      setSettings({ ...settings, ...updates });
      onSettingsChanged?.();
    } catch (error) {
      console.error('Failed to save memory settings:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!confirm('Are you sure you want to clear all memories for this workspace? This cannot be undone.')) {
      return;
    }
    try {
      setClearing(true);
      await window.electronAPI.clearMemory(workspaceId);
      await loadData();
    } catch (error) {
      console.error('Failed to clear memory:', error);
    } finally {
      setClearing(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="settings-section">
        <div className="settings-loading">Loading memory settings...</div>
      </div>
    );
  }

  // Show import wizard full-screen in the settings panel
  if (showImportWizard) {
    return (
      <ChatGPTImportWizard
        workspaceId={workspaceId}
        onClose={() => { setShowImportWizard(false); loadData(); }}
        onImportComplete={() => loadData()}
      />
    );
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Memory System</h3>
      <p className="settings-section-description">
        Captures observations during task execution for cross-session context. Memories help the AI remember
        what it learned in previous sessions.
      </p>

      {/* Stats Display */}
      {stats && (
        <div className="memory-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
          <div className="stat-card" style={{ padding: '12px', background: 'var(--color-bg-tertiary)', borderRadius: '8px', textAlign: 'center' }}>
            <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
              {stats.count.toLocaleString()}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Memories</div>
          </div>
          <div className="stat-card" style={{ padding: '12px', background: 'var(--color-bg-tertiary)', borderRadius: '8px', textAlign: 'center' }}>
            <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
              {stats.totalTokens.toLocaleString()}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Tokens</div>
          </div>
          <div className="stat-card" style={{ padding: '12px', background: 'var(--color-bg-tertiary)', borderRadius: '8px', textAlign: 'center' }}>
            <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
              {stats.compressedCount.toLocaleString()}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Compressed</div>
          </div>
          <div className="stat-card" style={{ padding: '12px', background: 'var(--color-bg-tertiary)', borderRadius: '8px', textAlign: 'center' }}>
            <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
              {Math.round(stats.compressionRatio * 100)}%
            </div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Ratio</div>
          </div>
        </div>
      )}

      {/* Import from ChatGPT */}
      <div className="settings-form-group" style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: '4px' }}>Import from ChatGPT</div>
            <p className="settings-form-hint" style={{ margin: 0 }}>
              Import your ChatGPT conversation history to build richer context. Your data stays on your device.
            </p>
          </div>
          <button
            className="chatgpt-import-btn chatgpt-import-btn-primary"
            onClick={() => setShowImportWizard(true)}
            disabled={!settings.enabled}
            style={{ opacity: settings.enabled ? 1 : 0.5, whiteSpace: 'nowrap' }}
          >
            Import
          </button>
        </div>
      </div>

      {/* Enable/Disable Toggle */}
      <div className="settings-form-group">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => handleSave({ enabled: e.target.checked })}
            disabled={saving}
          />
          <span className="settings-toggle-label">Enable Memory System</span>
        </label>
        <p className="settings-form-hint">
          When enabled, task observations are captured for future context.
        </p>
      </div>

      {settings.enabled && (
        <>
          {/* Auto-Capture Toggle */}
          <div className="settings-form-group">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.autoCapture}
                onChange={(e) => handleSave({ autoCapture: e.target.checked })}
                disabled={saving}
              />
              <span className="settings-toggle-label">Auto-Capture Observations</span>
            </label>
            <p className="settings-form-hint">
              Automatically capture tool calls, decisions, and results.
            </p>
          </div>

          {/* Compression Toggle */}
          <div className="settings-form-group">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.compressionEnabled}
                onChange={(e) => handleSave({ compressionEnabled: e.target.checked })}
                disabled={saving}
              />
              <span className="settings-toggle-label">Enable Compression</span>
            </label>
            <p className="settings-form-hint">
              Uses LLM to summarize memories, reducing token usage by ~10x.
            </p>
          </div>

          {/* Privacy Mode */}
          <div className="settings-form-group">
            <label className="settings-label">Privacy Mode</label>
            <select
              value={settings.privacyMode}
              onChange={(e) => handleSave({ privacyMode: e.target.value as PrivacyMode })}
              disabled={saving}
              className="settings-select"
            >
              <option value="normal">Normal - Auto-detect sensitive data</option>
              <option value="strict">Strict - Mark all as private</option>
              <option value="disabled">Disabled - No memory capture</option>
            </select>
            <p className="settings-form-hint">
              Controls how sensitive data is handled in memories.
            </p>
          </div>

          {/* Retention Period */}
          <div className="settings-form-group">
            <label className="settings-label">Retention Period</label>
            <select
              value={settings.retentionDays}
              onChange={(e) => handleSave({ retentionDays: parseInt(e.target.value) })}
              disabled={saving}
              className="settings-select"
            >
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="180">180 days</option>
              <option value="365">1 year</option>
            </select>
            <p className="settings-form-hint">
              Memories older than this will be automatically deleted.
            </p>
          </div>

          {/* Clear Button */}
          <div className="settings-form-group" style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--color-border)' }}>
            <button
              className="settings-button settings-button-danger"
              onClick={handleClear}
              disabled={saving || clearing}
              style={{
                background: 'var(--color-error)',
                color: 'white',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '6px',
                cursor: 'pointer',
                opacity: clearing ? 0.6 : 1,
              }}
            >
              {clearing ? 'Clearing...' : 'Clear All Memories'}
            </button>
            <p className="settings-form-hint" style={{ marginTop: '8px' }}>
              Permanently deletes all memories for this workspace.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
