import { useState, useEffect, useCallback } from "react";
import {
  ChannelData,
  ChannelUserData,
  SecurityMode,
  ContextType,
  ContextPolicy,
} from "../../shared/types";
import { PairingCodeDisplay } from "./PairingCodeDisplay";
import { ContextPolicySettings } from "./ContextPolicySettings";

interface EmailSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function EmailSettings({ onStatusChange }: EmailSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Form state
  const [channelName, setChannelName] = useState("Email");
  const [securityMode, setSecurityMode] = useState<SecurityMode>("pairing");
  const [emailProtocol, setEmailProtocol] = useState<"imap-smtp" | "loom">("imap-smtp");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [displayName, setDisplayName] = useState("");
  const [allowedSenders, setAllowedSenders] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [loomBaseUrl, setLoomBaseUrl] = useState("http://127.0.0.1:8787");
  const [loomAccessToken, setLoomAccessToken] = useState("");
  const [loomIdentity, setLoomIdentity] = useState("");
  const [loomMailboxFolder, setLoomMailboxFolder] = useState("INBOX");
  const [loomPollInterval, setLoomPollInterval] = useState(30000);

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number>(0);
  const [generatingCode, setGeneratingCode] = useState(false);

  // Context policy state
  const [contextPolicies, setContextPolicies] = useState<Record<ContextType, ContextPolicy>>(
    {} as Record<ContextType, ContextPolicy>,
  );
  const [savingPolicy, setSavingPolicy] = useState(false);

  const loadChannel = useCallback(async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const emailChannel = channels.find((c: ChannelData) => c.type === "email");

      if (emailChannel) {
        setChannel(emailChannel);
        setChannelName(emailChannel.name);
        setSecurityMode(emailChannel.securityMode);
        onStatusChange?.(emailChannel.status === "connected");

        // Load config settings
        if (emailChannel.config) {
          const protocol = emailChannel.config.protocol === "loom" ? "loom" : "imap-smtp";
          setEmailProtocol(protocol);
          setEmail((emailChannel.config.email as string) || "");
          setPassword((emailChannel.config.password as string) || "");
          setImapHost((emailChannel.config.imapHost as string) || "");
          setImapPort((emailChannel.config.imapPort as number) || 993);
          setSmtpHost((emailChannel.config.smtpHost as string) || "");
          setSmtpPort((emailChannel.config.smtpPort as number) || 587);
          setDisplayName((emailChannel.config.displayName as string) || "");
          const senders = (emailChannel.config.allowedSenders as string[]) || [];
          setAllowedSenders(senders.join(", "));
          setSubjectFilter((emailChannel.config.subjectFilter as string) || "");
          setLoomBaseUrl((emailChannel.config.loomBaseUrl as string) || "http://127.0.0.1:8787");
          setLoomAccessToken((emailChannel.config.loomAccessToken as string) || "");
          setLoomIdentity((emailChannel.config.loomIdentity as string) || "");
          setLoomMailboxFolder((emailChannel.config.loomMailboxFolder as string) || "INBOX");
          setLoomPollInterval((emailChannel.config.loomPollInterval as number) || 30000);
        }

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(emailChannel.id);
        setUsers(channelUsers);

        // Load context policies
        const policies = await window.electronAPI.listContextPolicies(emailChannel.id);
        const policyMap: Record<ContextType, ContextPolicy> = {} as Record<
          ContextType,
          ContextPolicy
        >;
        for (const policy of policies) {
          policyMap[policy.contextType as ContextType] = policy;
        }
        setContextPolicies(policyMap);
      }
    } catch (error) {
      console.error("Failed to load Email channel:", error);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== "email") return;
      if (channel && data?.channelId && data.channelId !== channel.id) return;
      loadChannel();
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [channel?.id, loadChannel]);

  const handleAddChannel = async () => {
    if (emailProtocol === "loom") {
      if (!loomBaseUrl.trim() || !loomAccessToken.trim()) {
        setTestResult({ success: false, error: "LOOM base URL and access token are required" });
        return;
      }
    } else if (!email.trim() || !password.trim() || !imapHost.trim() || !smtpHost.trim()) {
      setTestResult({
        success: false,
        error: "Email, password, IMAP host, and SMTP host are required",
      });
      return;
    }

    try {
      setSaving(true);
      setTestResult(null);

      const senderList = allowedSenders
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      await window.electronAPI.addGatewayChannel({
        type: "email",
        name: channelName,
        securityMode,
        emailProtocol,
        emailAddress: emailProtocol === "imap-smtp" ? email.trim() : undefined,
        emailPassword: emailProtocol === "imap-smtp" ? password.trim() : undefined,
        emailImapHost: emailProtocol === "imap-smtp" ? imapHost.trim() : undefined,
        emailImapPort: emailProtocol === "imap-smtp" ? imapPort : undefined,
        emailSmtpHost: emailProtocol === "imap-smtp" ? smtpHost.trim() : undefined,
        emailSmtpPort: emailProtocol === "imap-smtp" ? smtpPort : undefined,
        emailDisplayName: displayName.trim() || undefined,
        emailAllowedSenders:
          emailProtocol === "imap-smtp" && senderList.length > 0 ? senderList : undefined,
        emailSubjectFilter:
          emailProtocol === "imap-smtp" ? subjectFilter.trim() || undefined : undefined,
        emailLoomBaseUrl: emailProtocol === "loom" ? loomBaseUrl.trim() : undefined,
        emailLoomAccessToken: emailProtocol === "loom" ? loomAccessToken.trim() : undefined,
        emailLoomIdentity: emailProtocol === "loom" ? loomIdentity.trim() || undefined : undefined,
        emailLoomMailboxFolder:
          emailProtocol === "loom" ? loomMailboxFolder.trim() || "INBOX" : undefined,
        emailLoomPollInterval: emailProtocol === "loom" ? loomPollInterval : undefined,
      });

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

    if (!confirm("Are you sure you want to remove the Email channel?")) {
      return;
    }

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

  const handleUpdateSecurityMode = async (newMode: SecurityMode) => {
    if (!channel) return;

    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        securityMode: newMode,
      });
      setSecurityMode(newMode);
      setChannel({ ...channel, securityMode: newMode });
    } catch (error: Any) {
      console.error("Failed to update security mode:", error);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!channel) return;

    try {
      setGeneratingCode(true);
      const code = await window.electronAPI.generateGatewayPairing(channel.id, "");
      setPairingCode(code);
      // Default TTL is 5 minutes (300 seconds)
      setPairingExpiresAt(Date.now() + 5 * 60 * 1000);
    } catch (error: Any) {
      console.error("Failed to generate pairing code:", error);
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
      setContextPolicies((prev) => ({
        ...prev,
        [contextType]: updated,
      }));
    } catch (error: Any) {
      console.error("Failed to update context policy:", error);
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleRevokeAccess = async (channelUserId: string) => {
    if (!channel) return;

    try {
      await window.electronAPI.revokeGatewayAccess(channel.id, channelUserId);
      await loadChannel();
    } catch (error: Any) {
      console.error("Failed to revoke access:", error);
    }
  };

  // Common email provider presets
  const applyPreset = (provider: string) => {
    switch (provider) {
      case "gmail":
        setImapHost("imap.gmail.com");
        setImapPort(993);
        setSmtpHost("smtp.gmail.com");
        setSmtpPort(587);
        break;
      case "outlook":
        setImapHost("outlook.office365.com");
        setImapPort(993);
        setSmtpHost("smtp.office365.com");
        setSmtpPort(587);
        break;
      case "yahoo":
        setImapHost("imap.mail.yahoo.com");
        setImapPort(993);
        setSmtpHost("smtp.mail.yahoo.com");
        setSmtpPort(465);
        break;
    }
  };

  const isLoomMode = emailProtocol === "loom";
  const canAddChannel = isLoomMode
    ? Boolean(loomBaseUrl.trim() && loomAccessToken.trim())
    : Boolean(email.trim() && password.trim() && imapHost.trim() && smtpHost.trim());
  const configuredChannelHandle =
    (typeof channel?.config?.email === "string" && channel.config.email) ||
    (typeof channel?.config?.loomIdentity === "string" && channel.config.loomIdentity) ||
    (typeof channel?.config?.loomBaseUrl === "string" && channel.config.loomBaseUrl) ||
    null;

  if (loading) {
    return <div className="settings-loading">Loading Email settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="email-settings">
        <div className="settings-section">
          <h3>Connect Email</h3>
          <p className="settings-description">
            Choose IMAP/SMTP for traditional inboxes or LOOM for your agent-native email protocol
            node.
          </p>

          <div className="settings-field">
            <label>Channel Name</label>
            <input
              type="text"
              className="settings-input"
              placeholder="My Email Bot"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Protocol</label>
            <select
              className="settings-select"
              value={emailProtocol}
              onChange={(e) => setEmailProtocol(e.target.value as "imap-smtp" | "loom")}
            >
              <option value="imap-smtp">IMAP / SMTP (Legacy)</option>
              <option value="loom">LOOM Protocol</option>
            </select>
          </div>

          {!isLoomMode && (
            <>
              <div className="settings-callout info">
                <strong>Quick Setup:</strong>
                <div style={{ margin: "8px 0", display: "flex", gap: "8px" }}>
                  <button className="button-secondary" onClick={() => applyPreset("gmail")}>
                    Gmail
                  </button>
                  <button className="button-secondary" onClick={() => applyPreset("outlook")}>
                    Outlook
                  </button>
                  <button className="button-secondary" onClick={() => applyPreset("yahoo")}>
                    Yahoo
                  </button>
                </div>
                <p style={{ fontSize: "13px", marginTop: "8px" }}>
                  Note: For Gmail/Outlook, you may need to use an App Password instead of your
                  regular password.
                </p>
              </div>

              <div className="settings-field">
                <label>Email Address *</label>
                <input
                  type="email"
                  className="settings-input"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div className="settings-field">
                <label>Password *</label>
                <input
                  type="password"
                  className="settings-input"
                  placeholder="Your password or app password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="settings-hint">
                  For Gmail/Outlook, use an App Password (2FA must be enabled)
                </p>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div className="settings-field">
                  <label>IMAP Host *</label>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="imap.example.com"
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                  />
                </div>

                <div className="settings-field">
                  <label>IMAP Port</label>
                  <input
                    type="number"
                    className="settings-input"
                    placeholder="993"
                    value={imapPort}
                    onChange={(e) => setImapPort(parseInt(e.target.value) || 993)}
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div className="settings-field">
                  <label>SMTP Host *</label>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="smtp.example.com"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                  />
                </div>

                <div className="settings-field">
                  <label>SMTP Port</label>
                  <input
                    type="number"
                    className="settings-input"
                    placeholder="587"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(parseInt(e.target.value) || 587)}
                  />
                </div>
              </div>

              <div className="settings-field">
                <label>Allowed Senders (optional)</label>
                <input
                  type="text"
                  className="settings-input"
                  placeholder="user@example.com, other@example.com"
                  value={allowedSenders}
                  onChange={(e) => setAllowedSenders(e.target.value)}
                />
                <p className="settings-hint">
                  Comma-separated email addresses to accept messages from (leave empty for all)
                </p>
              </div>

              <div className="settings-field">
                <label>Subject Filter (optional)</label>
                <input
                  type="text"
                  className="settings-input"
                  placeholder="[CoWork]"
                  value={subjectFilter}
                  onChange={(e) => setSubjectFilter(e.target.value)}
                />
                <p className="settings-hint">
                  Only process emails containing this text in the subject
                </p>
              </div>
            </>
          )}

          {isLoomMode && (
            <>
              <div className="settings-field">
                <label>LOOM Base URL *</label>
                <input
                  type="url"
                  className="settings-input"
                  placeholder="http://127.0.0.1:8787"
                  value={loomBaseUrl}
                  onChange={(e) => setLoomBaseUrl(e.target.value)}
                />
              </div>

              <div className="settings-field">
                <label>LOOM Access Token *</label>
                <input
                  type="password"
                  className="settings-input"
                  placeholder="Bearer access token"
                  value={loomAccessToken}
                  onChange={(e) => setLoomAccessToken(e.target.value)}
                />
              </div>

              <div className="settings-field">
                <label>LOOM Identity (optional)</label>
                <input
                  type="text"
                  className="settings-input"
                  placeholder="loom://agent@example.com"
                  value={loomIdentity}
                  onChange={(e) => setLoomIdentity(e.target.value)}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div className="settings-field">
                  <label>Mailbox Folder</label>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="INBOX"
                    value={loomMailboxFolder}
                    onChange={(e) => setLoomMailboxFolder(e.target.value)}
                  />
                </div>

                <div className="settings-field">
                  <label>Poll Interval (ms)</label>
                  <input
                    type="number"
                    className="settings-input"
                    placeholder="30000"
                    value={loomPollInterval}
                    onChange={(e) => setLoomPollInterval(parseInt(e.target.value) || 30000)}
                  />
                </div>
              </div>
            </>
          )}

          <div className="settings-field">
            <label>Display Name (optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="CoWork Bot"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <p className="settings-hint">Name shown in outgoing messages</p>
          </div>

          <div className="settings-field">
            <label>Security Mode</label>
            <select
              className="settings-select"
              value={securityMode}
              onChange={(e) => setSecurityMode(e.target.value as SecurityMode)}
            >
              <option value="pairing">Pairing Code (Recommended)</option>
              <option value="allowlist">Allowlist Only</option>
              <option value="open">Open (Anyone can use)</option>
            </select>
            <p className="settings-hint">
              {securityMode === "pairing" &&
                "Users must enter a code generated in this app to use the bot"}
              {securityMode === "allowlist" && "Only pre-approved email addresses can use the bot"}
              {securityMode === "open" && "Anyone who emails the bot can use it (not recommended)"}
            </p>
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? "success" : "error"}`}>
              {testResult.success ? <>✓ Connection successful</> : <>✗ {testResult.error}</>}
            </div>
          )}

          <button
            className="button-primary"
            onClick={handleAddChannel}
            disabled={saving || !canAddChannel}
          >
            {saving ? "Adding..." : "Add Email"}
          </button>
        </div>

        <div className="settings-section">
          <h4>Email Features</h4>
          <ul className="setup-instructions">
            {isLoomMode ? (
              <>
                <li>Receive mailbox messages via LOOM gateway API</li>
                <li>Send via LOOM SMTP submit endpoint</li>
                <li>Thread and mailbox state mapped to LOOM thread graph</li>
                <li>Bearer-token authenticated protocol access</li>
              </>
            ) : (
              <>
                <li>Receive emails via IMAP (polling)</li>
                <li>Send emails via SMTP</li>
                <li>Reply threading support</li>
                <li>Filter by sender or subject</li>
                <li>Universal - works with any email provider</li>
              </>
            )}
          </ul>
        </div>
      </div>
    );
  }

  // Channel is configured
  return (
    <div className="email-settings">
      <div className="settings-section">
        <div className="channel-header">
          <div className="channel-info">
            <h3>
              {channel.name}
              {configuredChannelHandle && (
                <span className="bot-username">{configuredChannelHandle}</span>
              )}
            </h3>
            <div className={`channel-status ${channel.status}`}>
              {channel.status === "connected" && "● Connected"}
              {channel.status === "connecting" && "○ Connecting..."}
              {channel.status === "disconnected" && "○ Disconnected"}
              {channel.status === "error" && "● Error"}
            </div>
          </div>
          <div className="channel-actions">
            <button
              className={channel.enabled ? "button-secondary" : "button-primary"}
              onClick={handleToggleEnabled}
              disabled={saving}
            >
              {channel.enabled ? "Disable" : "Enable"}
            </button>
            <button
              className="button-secondary"
              onClick={handleTestConnection}
              disabled={testing || !channel.enabled}
            >
              {testing ? "Testing..." : "Test"}
            </button>
            <button className="button-danger" onClick={handleRemoveChannel} disabled={saving}>
              Remove
            </button>
          </div>
        </div>

        {testResult && (
          <div className={`test-result ${testResult.success ? "success" : "error"}`}>
            {testResult.success ? <>✓ Connection successful</> : <>✗ {testResult.error}</>}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h4>Security Mode</h4>
        <select
          className="settings-select"
          value={securityMode}
          onChange={(e) => handleUpdateSecurityMode(e.target.value as SecurityMode)}
        >
          <option value="pairing">Pairing Code</option>
          <option value="allowlist">Allowlist Only</option>
          <option value="open">Open</option>
        </select>
      </div>

      {securityMode === "pairing" && (
        <div className="settings-section">
          <h4>Generate Pairing Code</h4>
          <p className="settings-description">
            Generate a one-time code for a user to enter in their email to gain access.
          </p>
          {pairingCode && pairingExpiresAt > 0 ? (
            <PairingCodeDisplay
              code={pairingCode}
              expiresAt={pairingExpiresAt}
              onRegenerate={handleGeneratePairingCode}
              isRegenerating={generatingCode}
            />
          ) : (
            <button
              className="button-secondary"
              onClick={handleGeneratePairingCode}
              disabled={generatingCode}
            >
              {generatingCode ? "Generating..." : "Generate Code"}
            </button>
          )}
        </div>
      )}

      {/* Per-Context Security Policies */}
      <div className="settings-section">
        <h4>Context Policies</h4>
        <p className="settings-description">
          Configure different security settings for direct emails vs group/thread emails.
        </p>
        <ContextPolicySettings
          channelId={channel.id}
          channelType="email"
          policies={contextPolicies}
          onPolicyChange={handlePolicyChange}
          isSaving={savingPolicy}
        />
      </div>

      <div className="settings-section">
        <h4>Authorized Users</h4>
        {users.length === 0 ? (
          <p className="settings-description">No users have connected yet.</p>
        ) : (
          <div className="users-list">
            {users.map((user) => (
              <div key={user.id} className="user-item">
                <div className="user-info">
                  <span className="user-name">{user.displayName}</span>
                  {user.username && <span className="user-username">{user.username}</span>}
                  <span className={`user-status ${user.allowed ? "allowed" : "pending"}`}>
                    {user.allowed ? "✓ Allowed" : "○ Pending"}
                  </span>
                </div>
                {user.allowed && (
                  <button
                    className="button-small button-danger"
                    onClick={() => handleRevokeAccess(user.channelUserId)}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
