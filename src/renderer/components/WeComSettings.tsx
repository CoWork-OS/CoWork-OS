import { useCallback, useEffect, useState } from "react";
import {
  ChannelData,
  ChannelUserData,
  ContextPolicy,
  ContextType,
  SecurityMode,
} from "../../shared/types";
import { ContextPolicySettings } from "./ContextPolicySettings";
import { PairingCodeDisplay } from "./PairingCodeDisplay";

interface WeComSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function WeComSettings({ onStatusChange }: WeComSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    botUsername?: string;
  } | null>(null);
  const [channelName, setChannelName] = useState("WeCom Bot");
  const [corpId, setCorpId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [encodingAESKey, setEncodingAESKey] = useState("");
  const [webhookPort, setWebhookPort] = useState("3981");
  const [webhookPath, setWebhookPath] = useState("/wecom/webhook");
  const [securityMode, setSecurityMode] = useState<SecurityMode>("pairing");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number>(0);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [contextPolicies, setContextPolicies] = useState<Record<ContextType, ContextPolicy>>(
    {} as Record<ContextType, ContextPolicy>,
  );
  const [savingPolicy, setSavingPolicy] = useState(false);

  const loadChannel = useCallback(async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const existing = channels.find((entry: ChannelData) => entry.type === "wecom");
      if (!existing) {
        setChannel(null);
        setUsers([]);
        onStatusChange?.(false);
        return;
      }

      setChannel(existing);
      setChannelName(existing.name);
      setSecurityMode(existing.securityMode);
      onStatusChange?.(existing.status === "connected");

      const [channelUsers, policies] = await Promise.all([
        window.electronAPI.getGatewayUsers(existing.id),
        window.electronAPI.listContextPolicies(existing.id),
      ]);
      setUsers(channelUsers);

      const policyMap: Record<ContextType, ContextPolicy> = {} as Record<
        ContextType,
        ContextPolicy
      >;
      for (const policy of policies) {
        policyMap[policy.contextType as ContextType] = policy;
      }
      setContextPolicies(policyMap);
    } catch (error) {
      console.error("Failed to load WeCom channel:", error);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== "wecom") return;
      if (channel && data?.channelId && data.channelId !== channel.id) return;
      loadChannel();
    });
    return () => unsubscribe?.();
  }, [channel?.id, loadChannel]);

  const handleAddChannel = async () => {
    if (!corpId.trim() || !agentId.trim() || !secret.trim() || !token.trim()) return;
    try {
      setSaving(true);
      setTestResult(null);
      await window.electronAPI.addGatewayChannel({
        type: "wecom",
        name: channelName,
        wecomCorpId: corpId.trim(),
        wecomAgentId: parseInt(agentId, 10),
        wecomSecret: secret.trim(),
        wecomToken: token.trim(),
        wecomEncodingAESKey: encodingAESKey.trim() || undefined,
        webhookPort: parseInt(webhookPort, 10) || 3981,
        webhookPath: webhookPath.trim() || "/wecom/webhook",
        securityMode,
      });
      setCorpId("");
      setAgentId("");
      setSecret("");
      setToken("");
      setEncodingAESKey("");
      await loadChannel();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!channel) return;
    try {
      setTesting(true);
      setTestResult(null);
      const result = await window.electronAPI.testGatewayChannel(channel.id);
      setTestResult(result);
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setTesting(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!channel) return;
    try {
      setSaving(true);
      if (channel.enabled) {
        await window.electronAPI.disableGatewayChannel(channel.id);
      } else {
        await window.electronAPI.enableGatewayChannel(channel.id);
      }
      await loadChannel();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveChannel = async () => {
    if (!channel) return;
    if (!confirm("Are you sure you want to remove the WeCom channel?")) return;
    try {
      setSaving(true);
      await window.electronAPI.removeGatewayChannel(channel.id);
      setChannel(null);
      setUsers([]);
      onStatusChange?.(false);
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateSecurityMode = async (mode: SecurityMode) => {
    if (!channel) return;
    try {
      await window.electronAPI.updateGatewayChannel({ id: channel.id, securityMode: mode });
      setSecurityMode(mode);
      setChannel({ ...channel, securityMode: mode });
    } catch (error) {
      console.error("Failed to update WeCom security mode:", error);
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
      console.error("Failed to generate WeCom pairing code:", error);
    } finally {
      setGeneratingCode(false);
    }
  };

  const handlePolicyChange = async (contextType: ContextType, updates: Partial<ContextPolicy>) => {
    if (!channel) return;
    try {
      setSavingPolicy(true);
      const updated = await window.electronAPI.updateContextPolicy(channel.id, contextType, {
        securityMode: updates.securityMode,
        toolRestrictions: updates.toolRestrictions,
      });
      setContextPolicies((prev) => ({ ...prev, [contextType]: updated }));
    } catch (error) {
      console.error("Failed to update WeCom context policy:", error);
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleRevokeAccess = async (userId: string) => {
    if (!channel) return;
    try {
      await window.electronAPI.revokeGatewayAccess(channel.id, userId);
      await loadChannel();
    } catch (error) {
      console.error("Failed to revoke WeCom access:", error);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading WeCom settings...</div>;
  }

  if (!channel) {
    return (
      <div className="teams-settings">
        <div className="settings-section">
          <h3>Connect WeCom Bot</h3>
          <p className="settings-description">
            Configure an enterprise application and point its callback URL to CoWork. Replies are
            sent through the WeCom application messaging API.
          </p>

          <div className="settings-field">
            <label>Bot Name</label>
            <input
              className="settings-input"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Corp ID</label>
            <input
              className="settings-input"
              value={corpId}
              onChange={(e) => setCorpId(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Agent ID</label>
            <input
              className="settings-input"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Secret</label>
            <input
              type="password"
              className="settings-input"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Token</label>
            <input
              className="settings-input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Encoding AES Key (Optional)</label>
            <input
              className="settings-input"
              value={encodingAESKey}
              onChange={(e) => setEncodingAESKey(e.target.value)}
            />
            <p className="settings-hint">
              Use the 43-character callback key if encrypted callbacks are enabled.
            </p>
          </div>

          <div className="settings-field">
            <label>Webhook Port</label>
            <input
              type="number"
              className="settings-input"
              value={webhookPort}
              onChange={(e) => setWebhookPort(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Webhook Path</label>
            <input
              className="settings-input"
              value={webhookPath}
              onChange={(e) => setWebhookPath(e.target.value)}
            />
          </div>

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
          </div>

          <button
            className="settings-button settings-button-primary"
            onClick={handleAddChannel}
            disabled={saving}
          >
            {saving ? "Connecting..." : "Add WeCom Channel"}
          </button>

          {testResult && (
            <div className={`settings-status ${testResult.success ? "success" : "error"}`}>
              {testResult.success
                ? `Connected as ${testResult.botUsername || "bot"}`
                : testResult.error}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="teams-settings">
      <div className="settings-section">
        <h3>WeCom Channel</h3>
        <div className="settings-status-row">
          <span className={`settings-badge status-${channel.status}`}>{channel.status}</span>
          <span className="settings-muted">{channel.name}</span>
        </div>
        <div className="settings-actions">
          <button className="settings-button" onClick={handleTestConnection} disabled={testing}>
            {testing ? "Testing..." : "Test connection"}
          </button>
          <button className="settings-button" onClick={handleToggleEnabled} disabled={saving}>
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
        {testResult && (
          <div className={`settings-status ${testResult.success ? "success" : "error"}`}>
            {testResult.success
              ? `Connected as ${testResult.botUsername || "bot"}`
              : testResult.error}
          </div>
        )}
      </div>

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
        <h3>Context Policies</h3>
        <ContextPolicySettings
          channelId={channel.id}
          channelType="wecom"
          policies={{
            dm: contextPolicies.dm,
            group: contextPolicies.group,
          }}
          onPolicyChange={handlePolicyChange}
          isSaving={savingPolicy}
        />
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
                  onClick={() => handleRevokeAccess(user.channelUserId)}
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
