import { useState, useEffect } from "react";

interface ContextData {
  connectors: { id: string; name: string; icon: string; status: string }[];
  skills: { id: string; name: string; icon: string }[];
}

interface ContextPanelProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

export function ContextPanel({ collapsed = false, onToggle }: ContextPanelProps) {
  const [context, setContext] = useState<ContextData>({ connectors: [], skills: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await window.electronAPI.getActiveContext();
        if (!cancelled) {
          setContext(data);
        }
      } catch {
        // Context load failed silently
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    // Refresh every 30 seconds
    const interval = setInterval(load, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const connectedServers = context.connectors.filter((c) => c.status === "connected");
  const hasContent = connectedServers.length > 0 || context.skills.length > 0;

  if (collapsed) {
    return (
      <button className="ctx-collapsed-btn" onClick={onToggle} title="Show context">
        <span>Context</span>
        <span className="ctx-collapsed-count">
          {connectedServers.length + context.skills.length}
        </span>
      </button>
    );
  }

  return (
    <div className="ctx-panel">
      <div className="ctx-header" onClick={onToggle}>
        <span className="ctx-header-label">Context</span>
        {onToggle && <span className="ctx-header-chevron">&#8964;</span>}
      </div>

      {loading && <div className="ctx-loading">Loading...</div>}

      {!loading && !hasContent && <div className="ctx-empty">No active connectors or skills</div>}

      {connectedServers.length > 0 && (
        <div className="ctx-section">
          <div className="ctx-section-label">Connectors</div>
          {connectedServers.map((c) => (
            <div key={c.id} className="ctx-item">
              <span className="ctx-item-icon">{c.icon}</span>
              <span className="ctx-item-name">{c.name}</span>
            </div>
          ))}
        </div>
      )}

      {context.skills.length > 0 && (
        <div className="ctx-section">
          <div className="ctx-section-label">Skills</div>
          {context.skills.slice(0, 20).map((s) => (
            <div key={s.id} className="ctx-item">
              <span className="ctx-item-icon">{s.icon}</span>
              <span className="ctx-item-name">{s.name}</span>
            </div>
          ))}
          {context.skills.length > 20 && (
            <div className="ctx-item ctx-item--more">+{context.skills.length - 20} more</div>
          )}
        </div>
      )}

      <style>{`
        .ctx-panel {
          border: 1px solid var(--color-border-subtle);
          border-radius: 8px;
          background: var(--color-bg-secondary);
          overflow: hidden;
        }

        .ctx-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px;
          cursor: pointer;
          user-select: none;
        }

        .ctx-header:hover {
          background: var(--color-bg-hover);
        }

        .ctx-header-label {
          font-size: 14px;
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .ctx-header-chevron {
          font-size: 16px;
          color: var(--color-text-muted);
        }

        .ctx-loading,
        .ctx-empty {
          padding: 12px 14px;
          font-size: 12px;
          color: var(--color-text-muted);
        }

        .ctx-section {
          padding: 4px 14px 10px;
        }

        .ctx-section-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--color-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.3px;
          margin-bottom: 6px;
          padding-top: 4px;
        }

        .ctx-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 5px 0;
        }

        .ctx-item-icon {
          font-size: 16px;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          background: var(--color-bg-tertiary);
          flex-shrink: 0;
        }

        .ctx-item-name {
          font-size: 13px;
          color: var(--color-text-primary);
        }

        .ctx-item--more {
          font-size: 12px;
          color: var(--color-text-muted);
          padding-left: 32px;
        }

        .ctx-collapsed-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border-subtle);
          border-radius: 6px;
          color: var(--color-text-secondary);
          font-size: 12px;
          cursor: pointer;
        }

        .ctx-collapsed-btn:hover {
          background: var(--color-bg-hover);
        }

        .ctx-collapsed-count {
          background: var(--color-bg-tertiary);
          padding: 1px 6px;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 500;
        }
      `}</style>
    </div>
  );
}
