import { useState } from "react";

export interface ConnectorEnvField {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "password";
}

interface ConnectorEnvModalProps {
  serverId: string;
  serverName: string;
  initialEnv?: Record<string, string>;
  fields: ConnectorEnvField[];
  onClose: () => void;
  onSaved: () => void;
}

export function ConnectorEnvModal({
  serverId,
  serverName,
  initialEnv = {},
  fields,
  onClose,
  onSaved,
}: ConnectorEnvModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = {};
    fields.forEach((field) => {
      seeded[field.key] = initialEnv[field.key] || "";
    });
    return seeded;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mergeEnv = (): Record<string, string> => {
    const merged: Record<string, string> = { ...initialEnv };
    Object.entries(values).forEach(([key, value]) => {
      if (!value) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    });
    return merged;
  };

  const reconnectServer = async () => {
    try {
      await window.electronAPI.disconnectMCPServer(serverId);
    } catch {
      // ignore
    }
    await window.electronAPI.connectMCPServer(serverId);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.updateMCPServer(serverId, { env: mergeEnv() });
      await reconnectServer();
      onSaved();
      onClose();
    } catch (err: Any) {
      setError(err.message || "Failed to save credentials");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mcp-modal-overlay" onClick={onClose}>
      <div className="mcp-modal connector-setup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-modal-header">
          <div className="registry-details-title">
            <h3>{serverName} Configuration</h3>
          </div>
          <button className="mcp-modal-close" onClick={onClose}>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="mcp-modal-content">
          {fields.map((field) => (
            <div key={field.key} className="settings-field">
              <label>{field.label}</label>
              <input
                className="settings-input"
                type={field.type || "text"}
                placeholder={field.placeholder}
                value={values[field.key] || ""}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            </div>
          ))}

          <div className="connector-setup-actions">
            <button className="button-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Credentials"}
            </button>
          </div>

          {error && (
            <div className="mcp-server-error">
              <span className="mcp-error-icon">⚠</span>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
