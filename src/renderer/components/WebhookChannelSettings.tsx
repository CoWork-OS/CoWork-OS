import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AddChannelRequest,
  ChannelData,
  ChannelType,
  ChannelUserData,
  SecurityMode,
  WebhookChannelHealth,
} from "../../shared/types";
import { PairingCodeDisplay } from "./PairingCodeDisplay";

export interface WebhookChannelField {
  /** Field name in the add-channel request */
  key: keyof AddChannelRequest;
  /** Field name in the stored channel config, used when editing */
  configKey: string;
  label: string;
  type?: "text" | "password" | "number";
  placeholder?: string;
  hint?: string;
  required?: boolean;
  defaultValue?: string;
}

interface WebhookChannelSettingsProps {
  channelType: Extract<ChannelType, "whatsapp_cloud" | "twilio_sms">;
  title: string;
  description: ReactNode;
  defaultName: string;
  fields: WebhookChannelField[];
  /** Explains how to expose the local listener; shown once the channel exists. */
  endpointHint?: (config: Record<string, unknown>) => ReactNode;
  validate?: (values: Record<string, string>) => string | null;
  onStatusChange?: (connected: boolean) => void;
}

const HEALTH_REFRESH_MS = 15_000;

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : "never";
}

function toRequestValue(field: WebhookChannelField, raw: string): string | number {
  return field.type === "number" ? Number.parseInt(raw, 10) : raw;
}

export function WebhookChannelSettings({
  channelType,
  title,
  description,
  defaultName,
  fields,
  endpointHint,
  validate,
  onStatusChange,
}: WebhookChannelSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [health, setHealth] = useState<WebhookChannelHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    botUsername?: string;
  } | null>(null);
  const [channelName, setChannelName] = useState(defaultName);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.defaultValue ?? ""])),
  );
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [securityMode, setSecurityMode] = useState<SecurityMode>("pairing");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number>(0);
  const [generatingCode, setGeneratingCode] = useState(false);

  const loadHealth = useCallback(async (channelId: string) => {
    try {
      const result = await window.electronAPI.getGatewayChannelHealth(channelId);
      setHealth(result?.health ?? null);
    } catch {
      setHealth(null);
    }
  }, []);

  const loadChannel = useCallback(async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const existing = channels.find((entry: ChannelData) => entry.type === channelType);
      if (!existing) {
        setChannel(null);
        setUsers([]);
        setHealth(null);
        onStatusChange?.(false);
        return;
      }
      setChannel(existing);
      setChannelName(existing.name);
      setSecurityMode(existing.securityMode);
      onStatusChange?.(existing.status === "connected");
      setUsers(await window.electronAPI.getGatewayUsers(existing.id));
      await loadHealth(existing.id);
    } catch (error) {
      console.error(`Failed to load ${channelType} channel:`, error);
    } finally {
      setLoading(false);
    }
  }, [channelType, loadHealth, onStatusChange]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel]);

  useEffect(() => {
    if (!channel?.id) return;
    const timer = setInterval(() => void loadHealth(channel.id), HEALTH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [channel?.id, loadHealth]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== channelType) return;
      if (channel && data?.channelId && data.channelId !== channel.id) return;
      loadChannel();
    });
    return () => unsubscribe?.();
  }, [channel?.id, channelType, loadChannel]);

  const missingRequired = fields.some((field) => field.required && !values[field.key]?.trim());

  const handleAddChannel = async () => {
    const validationError = validate?.(values) ?? null;
    if (validationError) {
      setTestResult({ success: false, error: validationError });
      return;
    }
    try {
      setSaving(true);
      setTestResult(null);
      const request: Record<string, unknown> = {
        type: channelType,
        name: channelName,
        securityMode,
      };
      for (const field of fields) {
        const raw = values[field.key]?.trim();
        if (raw) request[field.key] = toRequestValue(field, raw);
      }
      await window.electronAPI.addGatewayChannel(request as unknown as AddChannelRequest);
      setValues(Object.fromEntries(fields.map((field) => [field.key, field.defaultValue ?? ""])));
      await loadChannel();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const runChannelAction = async (action: () => Promise<unknown>) => {
    if (!channel) return;
    try {
      setSaving(true);
      await action();
      await loadChannel();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => {
    const config = channel?.config || {};
    setEditValues(
      Object.fromEntries(
        fields.map((field) => [
          field.key,
          field.type === "password" || config[field.configKey] === undefined
            ? ""
            : String(config[field.configKey]),
        ]),
      ),
    );
    setEditing(true);
    setTestResult(null);
  };

  const handleSaveEdits = async () => {
    if (!channel) return;
    const config: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = editValues[field.key]?.trim();
      // Blank secret fields keep the stored value; they are never sent to the renderer.
      if (raw) config[field.configKey] = toRequestValue(field, raw);
    }
    if (Object.keys(config).length === 0) {
      setEditing(false);
      return;
    }
    await runChannelAction(async () => {
      await window.electronAPI.updateGatewayChannel({ id: channel.id, config });
      setEditing(false);
      setTestResult(await window.electronAPI.testGatewayChannel(channel.id));
    });
  };

  const handleTestConnection = async () => {
    if (!channel) return;
    try {
      setTesting(true);
      setTestResult(null);
      setTestResult(await window.electronAPI.testGatewayChannel(channel.id));
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setTesting(false);
    }
  };

  const handleRemoveChannel = async () => {
    if (!channel) return;
    if (!confirm(`Remove the ${title} channel? Stored credentials are deleted.`)) return;
    await runChannelAction(async () => {
      await window.electronAPI.removeGatewayChannel(channel.id);
      setChannel(null);
      setUsers([]);
      onStatusChange?.(false);
    });
  };

  const handleUpdateSecurityMode = async (mode: SecurityMode) => {
    if (!channel) return;
    try {
      await window.electronAPI.updateGatewayChannel({ id: channel.id, securityMode: mode });
      setSecurityMode(mode);
      setChannel({ ...channel, securityMode: mode });
    } catch (error) {
      console.error(`Failed to update ${channelType} security mode:`, error);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!channel) return;
    try {
      setGeneratingCode(true);
      const code = await window.electronAPI.generateGatewayPairing(channel.id, "");
      setPairingCode(code);
      setPairingExpiresAt(Date.now() + 5 * 60 * 1000);
    } catch (error) {
      console.error(`Failed to generate ${channelType} pairing code:`, error);
    } finally {
      setGeneratingCode(false);
    }
  };

  const renderInput = (
    field: WebhookChannelField,
    current: Record<string, string>,
    update: (key: string, value: string) => void,
    placeholderOverride?: string,
  ) => (
    <input
      type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
      className="settings-input"
      placeholder={placeholderOverride ?? field.placeholder}
      value={current[field.key] ?? ""}
      onChange={(e) => update(field.key, e.target.value)}
    />
  );

  const testStatus = testResult && (
    <div className={`settings-status ${testResult.success ? "success" : "error"}`}>
      {testResult.success ? `Connected as ${testResult.botUsername || "bot"}` : testResult.error}
    </div>
  );

  if (loading) {
    return <div className="settings-loading">Loading {title} settings...</div>;
  }

  if (!channel) {
    return (
      <div className="googlechat-settings">
        <div className="settings-section">
          <h3>Connect {title}</h3>
          <p className="settings-description">{description}</p>

          <div className="settings-field">
            <label>Channel Name</label>
            <input
              className="settings-input"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          {fields.map((field) => (
            <div className="settings-field" key={field.key}>
              <label>
                {field.label}
                {field.required ? "" : " (Optional)"}
              </label>
              {renderInput(field, values, (key, value) =>
                setValues((prev) => ({ ...prev, [key]: value })),
              )}
              {field.hint && <p className="settings-hint">{field.hint}</p>}
            </div>
          ))}

          <div className="settings-field">
            <label>Security Mode</label>
            <select
              className="settings-select"
              value={securityMode}
              onChange={(e) => setSecurityMode(e.target.value as SecurityMode)}
            >
              <option value="pairing">Pairing code required</option>
              <option value="allowlist">Allowlist only</option>
              <option value="open">Open access</option>
            </select>
            <p className="settings-hint">
              Unknown senders get no reply. To pair, generate a code here and have the person send
              it as a message.
            </p>
          </div>

          <button
            className="settings-button settings-button-primary"
            onClick={handleAddChannel}
            disabled={saving || missingRequired}
          >
            {saving ? "Connecting..." : `Add ${title} Channel`}
          </button>
          {testStatus}
        </div>
      </div>
    );
  }

  const deliveryEntries = Object.entries(health?.deliveryCounts || {});

  return (
    <div className="googlechat-settings">
      <div className="settings-section">
        <h3>{title} Channel</h3>
        <div className="settings-status-row">
          <span className={`settings-badge status-${channel.status}`}>{channel.status}</span>
          <span className="settings-muted">{channel.botUsername || channel.name}</span>
        </div>
        {endpointHint && channel.config && (
          <div className="settings-hint">{endpointHint(channel.config)}</div>
        )}
        <div className="settings-actions">
          <button className="settings-button" onClick={handleTestConnection} disabled={testing}>
            {testing ? "Testing..." : "Test connection"}
          </button>
          <button className="settings-button" onClick={startEditing} disabled={saving || editing}>
            Update settings
          </button>
          <button
            className="settings-button"
            onClick={() =>
              runChannelAction(() =>
                channel.enabled
                  ? window.electronAPI.disableGatewayChannel(channel.id)
                  : window.electronAPI.enableGatewayChannel(channel.id),
              )
            }
            disabled={saving}
          >
            {channel.enabled ? "Disable" : "Enable"}
          </button>
          <button
            className="settings-button settings-button-danger"
            onClick={handleRemoveChannel}
            disabled={saving}
          >
            Remove
          </button>
        </div>
        {testStatus}
      </div>

      {editing && (
        <div className="settings-section">
          <h3>Update settings</h3>
          <p className="settings-description">
            Leave a field blank to keep its current value. Secrets are never displayed.
          </p>
          {fields.map((field) => (
            <div className="settings-field" key={field.key}>
              <label>{field.label}</label>
              {renderInput(
                field,
                editValues,
                (key, value) => setEditValues((prev) => ({ ...prev, [key]: value })),
                field.type === "password" ? "Unchanged" : field.placeholder,
              )}
            </div>
          ))}
          <div className="settings-actions">
            <button
              className="settings-button settings-button-primary"
              onClick={handleSaveEdits}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save and test"}
            </button>
            <button className="settings-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {health && (
        <div className="settings-section">
          <h3>Webhook health</h3>
          <div className="settings-hint">
            Last inbound message: {formatTime(health.lastInboundAt)}
          </div>
          {health.rejectedWebhooks > 0 && (
            <div className="settings-status error">
              {health.rejectedWebhooks} webhook(s) rejected, most recently{" "}
              {formatTime(health.lastRejectedAt)}: {health.lastRejectedReason}
            </div>
          )}
          {health.pendingInbound > 0 && (
            <div className="settings-hint">
              {health.pendingInbound} inbound message(s) waiting to be processed
              {health.failedInbound.length > 0
                ? ` (${health.failedInbound.length} retrying; last error: ${health.failedInbound[0].lastError || "unknown"})`
                : ""}
              .
            </div>
          )}
          {health.heldReplies.length > 0 && (
            <div className="settings-hint">
              Replies held until the contact writes back:{" "}
              {health.heldReplies.map((entry) => `${entry.chatId} (${entry.count})`).join(", ")}
            </div>
          )}
          <div className="settings-hint">
            Deliveries in the last 24 hours:{" "}
            {deliveryEntries.length === 0
              ? "none reported"
              : deliveryEntries.map(([state, count]) => `${state} ${count}`).join(", ")}
          </div>
          {health.recentDeliveryFailures.length > 0 && (
            <div className="settings-list">
              {health.recentDeliveryFailures.map((failure) => (
                <div key={`${failure.messageId}-${failure.at}`} className="settings-list-item">
                  <div>
                    <strong>
                      {failure.state} to {failure.chatId}
                    </strong>
                    <div className="settings-hint">
                      {formatTime(failure.at)}
                      {failure.errorCode ? ` · error ${failure.errorCode}` : ""}
                      {failure.errorMessage ? ` · ${failure.errorMessage}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="settings-section">
        <h3>Access Control</h3>
        <div className="settings-field">
          <label>Security Mode</label>
          <select
            className="settings-select"
            value={securityMode}
            onChange={(e) => handleUpdateSecurityMode(e.target.value as SecurityMode)}
          >
            <option value="pairing">Pairing code required</option>
            <option value="allowlist">Allowlist only</option>
            <option value="open">Open access</option>
          </select>
        </div>
        {securityMode === "pairing" && (
          <div className="settings-field">
            <button
              className="settings-button"
              onClick={handleGeneratePairingCode}
              disabled={generatingCode}
            >
              {generatingCode ? "Generating..." : "Generate pairing code"}
            </button>
            {pairingCode && (
              <PairingCodeDisplay
                code={pairingCode}
                expiresAt={pairingExpiresAt}
                onRegenerate={handleGeneratePairingCode}
                isRegenerating={generatingCode}
              />
            )}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h3>Authorized Users</h3>
        {users.length === 0 ? (
          <p className="settings-description">No paired users yet.</p>
        ) : (
          <div className="settings-list">
            {users.map((user) => (
              <div key={user.id} className="settings-list-item">
                <div>
                  <strong>{user.displayName || user.channelUserId}</strong>
                  <div className="settings-hint">{user.channelUserId}</div>
                </div>
                <button
                  className="settings-button settings-button-danger"
                  onClick={() =>
                    runChannelAction(() =>
                      window.electronAPI.revokeGatewayAccess(channel.id, user.channelUserId),
                    )
                  }
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
