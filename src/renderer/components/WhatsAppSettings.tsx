import { useState, useEffect, useCallback } from "react";
import { Lightbulb } from "lucide-react";
import { ChannelData, ChannelUserData, SecurityMode } from "../../shared/types";
import QRCode from "qrcode";

interface WhatsAppSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function WhatsAppSettings({ onStatusChange }: WhatsAppSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    phoneNumber?: string;
  } | null>(null);

  // Form state
  const [channelName, setChannelName] = useState("WhatsApp");
  const [securityMode, setSecurityMode] = useState<SecurityMode>("pairing");
  const [allowedNumbers, setAllowedNumbers] = useState("");
  const [selfChatMode, setSelfChatMode] = useState(true);
  const [responsePrefix, setResponsePrefix] = useState("🤖");
  const [ingestNonSelfChatsInSelfChatMode, setIngestNonSelfChatsInSelfChatMode] = useState(false);

  // QR code state
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const loadChannel = useCallback(async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const whatsappChannel = channels.find((c: ChannelData) => c.type === "whatsapp");

      if (whatsappChannel) {
        setChannel(whatsappChannel);
        setChannelName(whatsappChannel.name);
        setSecurityMode(whatsappChannel.securityMode);
        onStatusChange?.(whatsappChannel.status === "connected");

        // Load self-chat mode settings from config
        if (whatsappChannel.config) {
          setSelfChatMode(whatsappChannel.config.selfChatMode ?? true);
          setResponsePrefix(whatsappChannel.config.responsePrefix ?? "🤖");
          setIngestNonSelfChatsInSelfChatMode(
            whatsappChannel.config.ingestNonSelfChatsInSelfChatMode ?? false,
          );
        }

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(whatsappChannel.id);
        setUsers(channelUsers);

        // Check for QR code
        const info = await window.electronAPI.getWhatsAppInfo?.();
        if (info?.qrCode) {
          setQrCode(info.qrCode);
        }
      }
    } catch (error) {
      console.error("Failed to load WhatsApp channel:", error);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    loadChannel();

    // Listen for QR code updates
    const handleQrCode = (_event: any, qr: string) => {
      setQrCode(qr);
      setQrLoading(false);
    };

    const handleWhatsAppConnected = () => {
      setQrCode(null);
      setQrLoading(false);
      loadChannel();
    };

    window.electronAPI?.onWhatsAppQRCode?.(handleQrCode);
    window.electronAPI?.onWhatsAppConnected?.(handleWhatsAppConnected);

    return () => {
      // Cleanup listeners if needed
    };
  }, [loadChannel]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== "whatsapp") return;
      if (channel && data?.channelId && data.channelId !== channel.id) return;
      loadChannel();
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [channel?.id, loadChannel]);

  // Render QR code when it changes
  useEffect(() => {
    if (qrCode) {
      renderQRCode(qrCode);
    }
  }, [qrCode]);

  const renderQRCode = async (qr: string) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr, {
        width: 256,
        margin: 2,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      });
      setQrDataUrl(dataUrl);
    } catch (error) {
      console.error("Failed to render QR code:", error);
    }
  };

  const handleAddChannel = async () => {
    try {
      setSaving(true);
      setTestResult(null);
      setQrLoading(true);

      await window.electronAPI.addGatewayChannel({
        type: "whatsapp",
        name: channelName,
        securityMode,
        allowedNumbers: allowedNumbers
          .split(",")
          .map((n) => n.trim().replace(/[^0-9]/g, ""))
          .filter(Boolean),
        selfChatMode,
        responsePrefix,
        ingestNonSelfChatsInSelfChatMode,
      });

      await loadChannel();
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
      setQrLoading(false);
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
    } catch (error: any) {
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
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveChannel = async () => {
    if (!channel) return;

    if (
      !confirm(
        "Are you sure you want to remove the WhatsApp channel? This will log out your WhatsApp session.",
      )
    ) {
      return;
    }

    try {
      setSaving(true);
      await window.electronAPI.removeGatewayChannel(channel.id);
      setChannel(null);
      setUsers([]);
      setQrCode(null);
      onStatusChange?.(false);
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    if (!channel) return;

    if (
      !confirm(
        "Are you sure you want to log out from WhatsApp? You will need to scan the QR code again.",
      )
    ) {
      return;
    }

    try {
      setSaving(true);
      await window.electronAPI.whatsAppLogout?.();
      setQrCode(null);
      await loadChannel();
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateSecurityMode = async (mode: SecurityMode) => {
    if (!channel) return;

    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        securityMode: mode,
      });
      setSecurityMode(mode);
      setChannel({ ...channel, securityMode: mode });
    } catch (error: any) {
      console.error("Failed to update security mode:", error);
    }
  };

  const handleUpdateSelfChatMode = async (enabled: boolean) => {
    if (!channel) return;

    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        config: {
          ...channel.config,
          selfChatMode: enabled,
        },
      });
      setSelfChatMode(enabled);
      setChannel({
        ...channel,
        config: { ...channel.config, selfChatMode: enabled },
      });
    } catch (error: any) {
      console.error("Failed to update self-chat mode:", error);
    }
  };

  const handleUpdateResponsePrefix = async () => {
    if (!channel) return;

    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        config: {
          ...channel.config,
          responsePrefix,
        },
      });
      setChannel({
        ...channel,
        config: { ...channel.config, responsePrefix },
      });
    } catch (error: any) {
      console.error("Failed to update response prefix:", error);
    }
  };

  const handleUpdateIngestNonSelfChats = async (enabled: boolean) => {
    if (!channel) return;

    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        config: {
          ...channel.config,
          ingestNonSelfChatsInSelfChatMode: enabled,
        },
      });
      setIngestNonSelfChatsInSelfChatMode(enabled);
      setChannel({
        ...channel,
        config: { ...channel.config, ingestNonSelfChatsInSelfChatMode: enabled },
      });
    } catch (error: any) {
      console.error("Failed to update ingest setting:", error);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!channel) return;

    try {
      const code = await window.electronAPI.generateGatewayPairing(channel.id, "");
      setPairingCode(code);
    } catch (error: any) {
      console.error("Failed to generate pairing code:", error);
    }
  };

  const handleRevokeAccess = async (userId: string) => {
    if (!channel) return;

    try {
      await window.electronAPI.revokeGatewayAccess(channel.id, userId);
      await loadChannel();
    } catch (error: any) {
      console.error("Failed to revoke access:", error);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading WhatsApp settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="whatsapp-settings">
        <div className="settings-section">
          <h3>Connect WhatsApp</h3>
          <p className="settings-description">
            Connect your WhatsApp account to receive and send messages. You'll need to scan a QR
            code with the WhatsApp app on your phone.
          </p>

          <div className="settings-field">
            <label>Channel Name</label>
            <input
              type="text"
              className="settings-input"
              placeholder="My WhatsApp"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Security Mode</label>
            <select
              className="settings-select"
              value={securityMode}
              onChange={(e) => setSecurityMode(e.target.value as SecurityMode)}
            >
              <option value="open">Open (anyone can message)</option>
              <option value="allowlist">Allowlist (specific numbers only)</option>
              <option value="pairing">Pairing (require code to connect)</option>
            </select>
            <p className="settings-hint">Controls who can interact with your bot via WhatsApp</p>
          </div>

          {securityMode === "allowlist" && (
            <div className="settings-field">
              <label>Allowed Phone Numbers</label>
              <input
                type="text"
                className="settings-input"
                placeholder="14155551234, 14155555678"
                value={allowedNumbers}
                onChange={(e) => setAllowedNumbers(e.target.value)}
              />
              <p className="settings-hint">
                Comma-separated phone numbers in E.164 format (without +)
              </p>
            </div>
          )}

          <div className="settings-field">
            <div className="settings-checkbox-label">
              <span>Self-Chat Mode</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={selfChatMode}
                  onChange={(e) => setSelfChatMode(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <p className="settings-hint">
              Enable this if you're using your own WhatsApp number (messaging yourself). Bot
              responses will be prefixed to distinguish them from your messages.
            </p>
          </div>

          {selfChatMode && (
            <div className="settings-field">
              <label>Response Prefix</label>
              <input
                type="text"
                className="settings-input"
                placeholder="🤖"
                value={responsePrefix}
                onChange={(e) => setResponsePrefix(e.target.value)}
                style={{ width: "100px" }}
              />
              <p className="settings-hint">
                Prefix added to bot messages (e.g., "🤖" or "[CoWork]")
              </p>
            </div>
          )}

          {selfChatMode && (
            <div className="settings-field">
              <div className="settings-checkbox-label">
                <span>Ingest Other Chats (Log-Only)</span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={ingestNonSelfChatsInSelfChatMode}
                    onChange={(e) => setIngestNonSelfChatsInSelfChatMode(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              <p className="settings-hint">
                When enabled, CoWork OS will ingest messages from your other WhatsApp chats into the
                local log (for scheduled digests/follow-ups), but will not reply outside the
                self-chat.
              </p>
            </div>
          )}

          <div className="settings-info-box">
            <strong>
              <Lightbulb
                size={13}
                strokeWidth={2}
                style={{ display: "inline", verticalAlign: "text-bottom" }}
              />{" "}
              Tip:
            </strong>{" "}
            For the best experience, use a separate WhatsApp number for the bot. This way the bot
            appears as a separate contact instead of messaging yourself.
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? "success" : "error"}`}>
              {testResult.success ? (
                <>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                    <path d="M22 4L12 14.01l-3-3" />
                  </svg>
                  Connected as {testResult.phoneNumber}
                </>
              ) : (
                <>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  {testResult.error || "Connection failed"}
                </>
              )}
            </div>
          )}

          <div className="settings-actions">
            <button className="button-primary" onClick={handleAddChannel} disabled={saving}>
              {saving ? "Connecting..." : "Connect WhatsApp"}
            </button>
          </div>
        </div>

        <div className="settings-section settings-info">
          <h4>How it works</h4>
          <ol className="settings-steps">
            <li>Click "Connect WhatsApp" above</li>
            <li>A QR code will appear</li>
            <li>Open WhatsApp on your phone</li>
            <li>Go to Settings &gt; Linked Devices</li>
            <li>Tap "Link a Device" and scan the QR code</li>
          </ol>
          <p className="settings-warning">
            <strong>Note:</strong> WhatsApp Web sessions may be logged out if you use the same
            account on another WhatsApp Web instance.
          </p>
        </div>
      </div>
    );
  }

  // Show QR code if waiting for authentication
  if (qrCode || qrLoading) {
    return (
      <div className="whatsapp-settings">
        <div className="settings-section">
          <h3>Scan QR Code</h3>
          <p className="settings-description">
            Open WhatsApp on your phone, go to Settings &gt; Linked Devices, and scan this QR code.
          </p>

          <div className="qr-code-container">
            {qrLoading && !qrDataUrl ? (
              <div className="qr-loading">
                <svg
                  className="spinner"
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 12a9 9 0 11-6.219-8.56" />
                </svg>
                <span>Generating QR code...</span>
              </div>
            ) : qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="WhatsApp QR Code"
                className="qr-image"
                style={{ width: 256, height: 256 }}
              />
            ) : (
              <div className="qr-loading">
                <span>Waiting for QR code...</span>
              </div>
            )}
          </div>

          {qrCode && (
            <p className="settings-hint qr-hint">
              QR code refreshes automatically. If it doesn't work, try removing and re-adding the
              channel.
            </p>
          )}

          <div className="settings-actions">
            <button className="button-secondary" onClick={handleRemoveChannel} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>

        <div className="settings-section">
          <h3>Self-Chat Mode</h3>
          <p className="settings-description">
            Configure how the bot identifies its messages when messaging yourself
          </p>

          <div className="settings-field">
            <div className="settings-checkbox-label">
              <span>Self-Chat Mode Enabled</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={selfChatMode}
                  onChange={(e) => {
                    setSelfChatMode(e.target.checked);
                    if (channel) {
                      handleUpdateSelfChatMode(e.target.checked);
                    }
                  }}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <p className="settings-hint">
              Enable this if you're using your own WhatsApp number. Bot responses will be prefixed
              to distinguish them from your messages.
            </p>
          </div>

          {selfChatMode && (
            <div className="settings-field">
              <label>Response Prefix</label>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type="text"
                  className="settings-input"
                  placeholder="🤖"
                  value={responsePrefix}
                  onChange={(e) => setResponsePrefix(e.target.value)}
                  style={{ width: "100px" }}
                />
                {channel && (
                  <button
                    className="button-small button-secondary"
                    onClick={handleUpdateResponsePrefix}
                  >
                    Save
                  </button>
                )}
              </div>
              <p className="settings-hint">
                Prefix added to bot messages (e.g., "🤖" or "[CoWork]")
              </p>
            </div>
          )}

          {selfChatMode && (
            <div className="settings-field">
              <div className="settings-checkbox-label">
                <span>Ingest Other Chats (Log-Only)</span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={ingestNonSelfChatsInSelfChatMode}
                    onChange={(e) => {
                      setIngestNonSelfChatsInSelfChatMode(e.target.checked);
                      if (channel) {
                        handleUpdateIngestNonSelfChats(e.target.checked);
                      }
                    }}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              <p className="settings-hint">
                In self-chat mode, this ingests your other WhatsApp chats into the local log without
                replying.
              </p>
            </div>
          )}

          <div className="settings-info-box">
            <strong>
              <Lightbulb
                size={13}
                strokeWidth={2}
                style={{ display: "inline", verticalAlign: "text-bottom" }}
              />{" "}
              Tip:
            </strong>{" "}
            For the best experience, use a separate WhatsApp number for the bot. Then disable
            self-chat mode - your bot will appear as a separate contact.
          </div>
        </div>
      </div>
    );
  }

  // Channel is configured and connected
  return (
    <div className="whatsapp-settings">
      <div className="settings-section">
        <div className="channel-header">
          <div className="channel-info">
            <h3>
              {channel.name}
              {channel.botUsername && <span className="bot-username">+{channel.botUsername}</span>}
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
            <button className="button-secondary" onClick={handleLogout} disabled={saving}>
              Logout
            </button>
            <button className="button-danger" onClick={handleRemoveChannel} disabled={saving}>
              Remove
            </button>
          </div>
        </div>

        {testResult && (
          <div className={`test-result ${testResult.success ? "success" : "error"}`}>
            {testResult.success ? (
              <>✓ Connection successful</>
            ) : (
              <>✗ {testResult.error || "Connection failed"}</>
            )}
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
            Generate a one-time code for a user to enter in WhatsApp to gain access.
          </p>
          <button className="button-secondary" onClick={handleGeneratePairingCode}>
            Generate Code
          </button>
          {pairingCode && (
            <div className="pairing-code-display">
              <span className="pairing-code">{pairingCode}</span>
              <p className="settings-hint">
                User should send this code to the bot within 5 minutes
              </p>
            </div>
          )}
        </div>
      )}

      <div className="settings-section">
        <h4>Self-Chat Mode</h4>
        <p className="settings-description">
          Configure how the bot identifies its messages when messaging yourself
        </p>

        <div className="settings-field">
          <div className="settings-checkbox-label">
            <span>Self-Chat Mode Enabled</span>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={selfChatMode}
                onChange={(e) => handleUpdateSelfChatMode(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <p className="settings-hint">
            Enable this if you're using your own WhatsApp number. Bot responses will be prefixed to
            distinguish them from your messages.
          </p>
        </div>

        {selfChatMode && (
          <div className="settings-field">
            <label>Response Prefix</label>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="text"
                className="settings-input"
                placeholder="🤖"
                value={responsePrefix}
                onChange={(e) => setResponsePrefix(e.target.value)}
                style={{ width: "100px" }}
              />
              <button className="button-secondary" onClick={handleUpdateResponsePrefix}>
                Save
              </button>
            </div>
            <p className="settings-hint">Prefix added to bot messages (e.g., "🤖" or "[CoWork]")</p>
          </div>
        )}

        {selfChatMode && (
          <div className="settings-field">
            <div className="settings-checkbox-label">
              <span>Ingest Other Chats (Log-Only)</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={ingestNonSelfChatsInSelfChatMode}
                  onChange={(e) => handleUpdateIngestNonSelfChats(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <p className="settings-hint">
              In self-chat mode, ingest messages from your other WhatsApp chats into the local log
              without replying.
            </p>
          </div>
        )}

        <div className="settings-info-box">
          <strong>
            <Lightbulb
              size={13}
              strokeWidth={2}
              style={{ display: "inline", verticalAlign: "text-bottom" }}
            />{" "}
            Tip:
          </strong>{" "}
          For the best experience, use a separate WhatsApp number for the bot. Then disable
          self-chat mode - your bot will appear as a separate contact.
        </div>
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
                  <span className="user-name">{user.displayName || user.channelUserId}</span>
                  <span className="user-username">+{user.channelUserId}</span>
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
