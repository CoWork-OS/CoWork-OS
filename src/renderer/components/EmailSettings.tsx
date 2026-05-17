import { useState, useEffect, useCallback } from "react";
import { ChannelData } from "../../shared/types";
import {
  MICROSOFT_EMAIL_DEFAULT_TENANT,
  MICROSOFT_EMAIL_GRAPH_READWRITE_SCOPES,
  MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES,
  normalizeMicrosoftEmailReadScopes,
} from "../../shared/microsoft-email";

interface EmailSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

// ─── Provider types & definitions ────────────────────────────────────────────

type EmailProvider =
  | "gmail"
  | "microsoft365"
  | "outlook"
  | "yahoo"
  | "icloud"
  | "fastmail"
  | "protonmail"
  | "custom"
  | "loom";

type EmailAuthMethod = "password" | "oauth";
type EmailTestResult = { success: boolean; error?: string; message?: string };

interface EmailProviderDef {
  id: EmailProvider;
  label: string;
  description: string;
  icon: React.ReactNode;
  protocol: "imap-smtp" | "loom";
  presets?: { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number };
  appPasswordHint: string | null;
  authMethod?: EmailAuthMethod;
}

const EMAIL_PROVIDER_DEFS: readonly EmailProviderDef[] = [
  {
    id: "gmail",
    label: "Gmail",
    description: "Google personal accounts",
    protocol: "imap-smtp",
    presets: { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 587 },
    appPasswordHint: "Use an App Password — requires 2FA to be enabled in your Google account",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M2 7l10 7 10-7" />
      </svg>
    ),
  },
  {
    id: "microsoft365",
    label: "Microsoft 365",
    description: "Office 365 / Work accounts",
    protocol: "imap-smtp",
    presets: { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587 },
    appPasswordHint: "You may need an App Password if your org requires MFA",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="8" height="8" rx="1" />
        <rect x="13" y="3" width="8" height="8" rx="1" />
        <rect x="3" y="13" width="8" height="8" rx="1" />
        <rect x="13" y="13" width="8" height="8" rx="1" />
      </svg>
    ),
  },
  {
    id: "outlook",
    label: "Outlook.com",
    description: "Hotmail · Live · MSN",
    protocol: "imap-smtp",
    presets: { imapHost: "imap-mail.outlook.com", imapPort: 993, smtpHost: "smtp-mail.outlook.com", smtpPort: 587 },
    appPasswordHint: null,
    authMethod: "oauth",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M2 7l10 7 10-7" />
        <circle cx="8" cy="12" r="2.5" />
      </svg>
    ),
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    description: "Yahoo personal accounts",
    protocol: "imap-smtp",
    presets: { imapHost: "imap.mail.yahoo.com", imapPort: 993, smtpHost: "smtp.mail.yahoo.com", smtpPort: 465 },
    appPasswordHint: "Yahoo requires an App Password — enable it under Account Security settings",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 5l7 9v5h4v-5l7-9H3z" />
      </svg>
    ),
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    description: "Apple iCloud accounts",
    protocol: "imap-smtp",
    presets: { imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587 },
    appPasswordHint: "Use an App-Specific Password generated at appleid.apple.com",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M17.5 9a5 5 0 00-9.9-1A4 4 0 007 16h10a4 4 0 00.5-7z" />
      </svg>
    ),
  },
  {
    id: "fastmail",
    label: "Fastmail",
    description: "Fastmail personal/team",
    protocol: "imap-smtp",
    presets: { imapHost: "imap.fastmail.com", imapPort: 993, smtpHost: "smtp.fastmail.com", smtpPort: 587 },
    appPasswordHint: "Generate an App Password in Fastmail → Settings → Password & Security",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M13 3L4 14h8l-1 7 9-11h-8l1-7z" />
      </svg>
    ),
  },
  {
    id: "protonmail",
    label: "Proton Mail",
    description: "Via Proton Mail Bridge",
    protocol: "imap-smtp",
    presets: { imapHost: "127.0.0.1", imapPort: 1143, smtpHost: "127.0.0.1", smtpPort: 1025 },
    appPasswordHint: null,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7l-9-5z" />
      </svg>
    ),
  },
  {
    id: "custom",
    label: "Custom IMAP",
    description: "Any IMAP / SMTP provider",
    protocol: "imap-smtp",
    presets: undefined,
    appPasswordHint: null,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14" />
      </svg>
    ),
  },
  {
    id: "loom",
    label: "LOOM Protocol",
    description: "Agent-native email node",
    protocol: "loom",
    presets: undefined,
    appPasswordHint: null,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2v20M2 12h20M6 6l12 12M18 6L6 18" />
      </svg>
    ),
  },
];

// ─── Modal props interface ────────────────────────────────────────────────────

interface EmailProviderModalProps {
  def: EmailProviderDef;
  channelName: string;
  setChannelName: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  emailAuthMethod: EmailAuthMethod;
  password: string;
  setPassword: (v: string) => void;
  emailOauthClientId: string;
  setEmailOauthClientId: (v: string) => void;
  emailOauthClientSecret: string;
  setEmailOauthClientSecret: (v: string) => void;
  emailOauthTenant: string;
  setEmailOauthTenant: (v: string) => void;
  imapHost: string;
  setImapHost: (v: string) => void;
  imapPort: number;
  setImapPort: (v: number) => void;
  smtpHost: string;
  setSmtpHost: (v: string) => void;
  smtpPort: number;
  setSmtpPort: (v: number) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  subjectFilter: string;
  setSubjectFilter: (v: string) => void;
  loomBaseUrl: string;
  setLoomBaseUrl: (v: string) => void;
  loomAccessToken: string;
  setLoomAccessToken: (v: string) => void;
  loomIdentity: string;
  setLoomIdentity: (v: string) => void;
  loomMailboxFolder: string;
  setLoomMailboxFolder: (v: string) => void;
  loomPollInterval: number;
  setLoomPollInterval: (v: number) => void;
  saving: boolean;
  testResult: EmailTestResult | null;
  oauthBusy: boolean;
  oauthError: string | null;
  oauthConnected: boolean;
  onConnectMicrosoftOAuth: () => void;
  onClose: () => void;
  onSubmit: () => void;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function EmailSettings({ onStatusChange }: EmailSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<EmailTestResult | null>(null);

  // Form state
  const [channelName, setChannelName] = useState("Email");
  const [emailProtocol, setEmailProtocol] = useState<"imap-smtp" | "loom">("imap-smtp");
  const [email, setEmail] = useState("");
  const [emailAuthMethod, setEmailAuthMethod] = useState<EmailAuthMethod>("password");
  const [password, setPassword] = useState("");
  const [emailOauthClientId, setEmailOauthClientId] = useState("");
  const [emailOauthClientSecret, setEmailOauthClientSecret] = useState("");
  const [emailOauthTenant, setEmailOauthTenant] = useState(MICROSOFT_EMAIL_DEFAULT_TENANT);
  const [emailAccessToken, setEmailAccessToken] = useState("");
  const [emailRefreshToken, setEmailRefreshToken] = useState("");
  const [emailTokenExpiresAt, setEmailTokenExpiresAt] = useState<number | undefined>(undefined);
  const [emailScopes, setEmailScopes] = useState<string[]>([...MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES]);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [displayName, setDisplayName] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [loomBaseUrl, setLoomBaseUrl] = useState("http://127.0.0.1:8787");
  const [loomAccessToken, setLoomAccessToken] = useState("");
  const [loomIdentity, setLoomIdentity] = useState("");
  const [loomMailboxFolder, setLoomMailboxFolder] = useState("INBOX");
  const [loomPollInterval, setLoomPollInterval] = useState(30000);

  // Provider selection state
  const [selectedProvider, setSelectedProvider] = useState<EmailProvider | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const clearMicrosoftOAuthState = useCallback(() => {
    setEmailAccessToken("");
    setEmailRefreshToken("");
    setEmailTokenExpiresAt(undefined);
    setOauthError(null);
  }, []);

  const loadChannel = useCallback(async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const emailChannel = channels.find((c: ChannelData) => c.type === "email");

      if (emailChannel) {
        setChannel(emailChannel);
        setChannelName(emailChannel.name);
        onStatusChange?.(emailChannel.status === "connected");

        // Load config settings
        if (emailChannel.config) {
          const protocol = emailChannel.config.protocol === "loom" ? "loom" : "imap-smtp";
          setEmailProtocol(protocol);
          setEmail((emailChannel.config.email as string) || "");
          setEmailAuthMethod(
            (emailChannel.config.authMethod as EmailAuthMethod | undefined) || "password",
          );
          setPassword((emailChannel.config.password as string) || "");
          setEmailOauthClientId((emailChannel.config.oauthClientId as string) || "");
          setEmailOauthClientSecret((emailChannel.config.oauthClientSecret as string) || "");
          setEmailOauthTenant(
            (emailChannel.config.oauthTenant as string) || MICROSOFT_EMAIL_DEFAULT_TENANT,
          );
          setEmailAccessToken((emailChannel.config.accessToken as string) || "");
          setEmailRefreshToken((emailChannel.config.refreshToken as string) || "");
          setEmailTokenExpiresAt(emailChannel.config.tokenExpiresAt as number | undefined);
          setEmailScopes(
            normalizeMicrosoftEmailReadScopes(emailChannel.config.scopes as string[] | undefined),
          );
          setImapHost((emailChannel.config.imapHost as string) || "");
          setImapPort((emailChannel.config.imapPort as number) || 993);
          setSmtpHost((emailChannel.config.smtpHost as string) || "");
          setSmtpPort((emailChannel.config.smtpPort as number) || 587);
          setDisplayName((emailChannel.config.displayName as string) || "");
          setSubjectFilter((emailChannel.config.subjectFilter as string) || "");
          setLoomBaseUrl((emailChannel.config.loomBaseUrl as string) || "http://127.0.0.1:8787");
          setLoomAccessToken((emailChannel.config.loomAccessToken as string) || "");
          setLoomIdentity((emailChannel.config.loomIdentity as string) || "");
          setLoomMailboxFolder((emailChannel.config.loomMailboxFolder as string) || "INBOX");
          setLoomPollInterval((emailChannel.config.loomPollInterval as number) || 30000);
        }

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

  const handleAddChannel = async () => {
    if (emailProtocol === "loom") {
      if (!loomBaseUrl.trim() || !loomAccessToken.trim()) {
        setTestResult({ success: false, error: "LOOM base URL and access token are required" });
        return;
      }
    } else if (
      !email.trim() ||
      (emailAuthMethod === "oauth"
        ? !emailOauthClientId.trim() || (!emailAccessToken.trim() && !emailRefreshToken.trim())
        : !password.trim() || !imapHost.trim() || !smtpHost.trim())
    ) {
      setTestResult({
        success: false,
        error:
          emailAuthMethod === "oauth"
            ? "Email, OAuth client ID, and OAuth tokens are required"
            : "Email, password, IMAP host, and SMTP host are required",
      });
      return;
    }

    try {
      setSaving(true);
      setTestResult(null);

      await window.electronAPI.addGatewayChannel({
        type: "email",
        name: channelName,
        securityMode: "open",
        emailProtocol,
        emailAuthMethod: emailProtocol === "imap-smtp" ? emailAuthMethod : undefined,
        emailOauthProvider:
          emailProtocol === "imap-smtp" && emailAuthMethod === "oauth" ? "microsoft" : undefined,
        emailOauthClientId:
          emailProtocol === "imap-smtp" && emailAuthMethod === "oauth"
            ? emailOauthClientId.trim()
            : undefined,
        emailOauthClientSecret:
          emailProtocol === "imap-smtp" && emailAuthMethod === "oauth"
            ? emailOauthClientSecret.trim() || undefined
            : undefined,
        emailOauthTenant:
          emailProtocol === "imap-smtp" && emailAuthMethod === "oauth"
            ? emailOauthTenant.trim() || MICROSOFT_EMAIL_DEFAULT_TENANT
            : undefined,
        emailAccessToken:
          emailProtocol === "imap-smtp" && emailAuthMethod === "oauth"
            ? emailAccessToken.trim() || undefined
            : undefined,
        emailRefreshToken:
          emailProtocol === "imap-smtp" && emailAuthMethod === "oauth"
            ? emailRefreshToken.trim() || undefined
            : undefined,
        emailTokenExpiresAt:
          emailProtocol === "imap-smtp" && emailAuthMethod === "oauth"
            ? emailTokenExpiresAt
            : undefined,
        emailScopes:
          emailProtocol === "imap-smtp" && emailAuthMethod === "oauth" ? emailScopes : undefined,
        emailAddress: emailProtocol === "imap-smtp" ? email.trim() : undefined,
        emailPassword:
          emailProtocol === "imap-smtp" && emailAuthMethod === "password"
            ? password.trim()
            : undefined,
        emailImapHost:
          emailProtocol === "imap-smtp" && emailAuthMethod !== "oauth"
            ? imapHost.trim()
            : undefined,
        emailImapPort: emailProtocol === "imap-smtp" ? imapPort : undefined,
        emailSmtpHost:
          emailProtocol === "imap-smtp" && emailAuthMethod !== "oauth"
            ? smtpHost.trim()
            : undefined,
        emailSmtpPort: emailProtocol === "imap-smtp" ? smtpPort : undefined,
        emailDisplayName: displayName.trim() || undefined,
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

  const handleMicrosoftOAuthConnect = async (options?: { persistToChannel?: boolean }) => {
    try {
      if (!emailOauthClientId.trim()) {
        setOauthError("Client ID is required to start Microsoft OAuth.");
        return;
      }

      setOauthBusy(true);
      setOauthError(null);
      setTestResult(null);

      const result = await window.electronAPI.startConnectorOAuth({
        provider: "microsoft-email",
        clientId: emailOauthClientId.trim(),
        clientSecret: emailOauthClientSecret.trim() || undefined,
        tenant: emailOauthTenant.trim() || MICROSOFT_EMAIL_DEFAULT_TENANT,
        scopes: [...MICROSOFT_EMAIL_GRAPH_READWRITE_SCOPES],
        loginHint: email.trim() || undefined,
        prompt: options?.persistToChannel ? "consent" : undefined,
      });

      const tokenExpiresAt = result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined;
      const scopes = normalizeMicrosoftEmailReadScopes(
        result.scopes && result.scopes.length > 0 ? result.scopes : emailScopes,
      );
      const refreshToken = result.refreshToken || emailRefreshToken;

      setEmailAccessToken(result.accessToken);
      setEmailRefreshToken(refreshToken);
      setEmailTokenExpiresAt(tokenExpiresAt);
      setEmailScopes(scopes);

      if (options?.persistToChannel && channel) {
        const nextConfig: Record<string, unknown> = {
          oauthClientId: emailOauthClientId.trim(),
          oauthTenant: emailOauthTenant.trim() || MICROSOFT_EMAIL_DEFAULT_TENANT,
          accessToken: result.accessToken,
          tokenExpiresAt,
          scopes,
          microsoftGraphAccessToken: result.accessToken,
          microsoftGraphTokenExpiresAt: tokenExpiresAt,
          microsoftGraphTokenScopes: scopes,
        };
        if (refreshToken) {
          nextConfig.refreshToken = refreshToken;
        }
        const clientSecret = emailOauthClientSecret.trim();
        if (clientSecret) {
          nextConfig.oauthClientSecret = clientSecret;
        }
        await window.electronAPI.updateGatewayChannel({
          id: channel.id,
          config: nextConfig,
        });
        await loadChannel();
        const test = await window.electronAPI.testGatewayChannel(channel.id);
        if (!test.success) {
          throw new Error(test.error || "Microsoft Graph validation failed");
        }
        setTestResult({
          success: true,
          message: refreshToken
            ? "Microsoft account reauthenticated"
            : "Microsoft account reauthenticated for this session",
        });
      }
    } catch (error: Any) {
      setOauthError(error.message || "Microsoft OAuth failed");
      if (options?.persistToChannel) {
        setTestResult({ success: false, error: error.message || "Microsoft OAuth failed" });
      }
    } finally {
      setOauthBusy(false);
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
      onStatusChange?.(false);
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleProviderCardClick = (def: EmailProviderDef) => {
    setEmailProtocol(def.protocol);
    setEmailAuthMethod(def.authMethod || "password");
    if (def.presets) {
      setImapHost(def.presets.imapHost);
      setImapPort(def.presets.imapPort);
      setSmtpHost(def.presets.smtpHost);
      setSmtpPort(def.presets.smtpPort);
    } else {
      setImapHost("");
      setImapPort(993);
      setSmtpHost("");
      setSmtpPort(587);
    }
    setEmail("");
    setPassword("");
    setEmailOauthClientId("");
    setEmailOauthClientSecret("");
    setEmailOauthTenant(MICROSOFT_EMAIL_DEFAULT_TENANT);
    setEmailAccessToken("");
    setEmailRefreshToken("");
    setEmailTokenExpiresAt(undefined);
    setEmailScopes([...MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES]);
    setOauthError(null);
    setTestResult(null);
    setSelectedProvider(def.id);
  };

  const handleEmailInputChange = (value: string) => {
    if (emailAuthMethod === "oauth" && value !== email) {
      clearMicrosoftOAuthState();
    }
    setEmail(value);
  };

  const handleOauthClientIdChange = (value: string) => {
    if (emailAuthMethod === "oauth" && value !== emailOauthClientId) {
      clearMicrosoftOAuthState();
    }
    setEmailOauthClientId(value);
  };

  const handleOauthTenantChange = (value: string) => {
    if (emailAuthMethod === "oauth" && value !== emailOauthTenant) {
      clearMicrosoftOAuthState();
    }
    setEmailOauthTenant(value);
  };

  const configuredChannelHandle =
    (typeof channel?.config?.email === "string" && channel.config.email) ||
    (typeof channel?.config?.loomIdentity === "string" && channel.config.loomIdentity) ||
    (typeof channel?.config?.loomBaseUrl === "string" && channel.config.loomBaseUrl) ||
    null;
  const isConfiguredMicrosoftOAuth =
    channel?.type === "email" &&
    channel.config?.protocol !== "loom" &&
    channel.config?.authMethod === "oauth" &&
    channel.config?.oauthProvider === "microsoft";

  if (loading) {
    return <div className="settings-loading">Loading Email settings...</div>;
  }

  // No channel configured yet — show provider grid
  if (!channel) {
    return (
      <div className="email-settings">
        <div className="settings-section">
          <h3>Connect Email</h3>
          <p className="settings-description">Select your email provider to get started.</p>
          <div className="email-provider-grid">
            {EMAIL_PROVIDER_DEFS.map((def) => (
              <button
                key={def.id}
                className="email-provider-card"
                onClick={() => handleProviderCardClick(def)}
              >
                <div className="email-provider-card-icon">{def.icon}</div>
                <div className="email-provider-card-info">
                  <span className="email-provider-card-name">{def.label}</span>
                  <span className="email-provider-card-desc">{def.description}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {selectedProvider !== null && (
          <EmailProviderModal
            def={EMAIL_PROVIDER_DEFS.find((d) => d.id === selectedProvider)!}
            channelName={channelName}
            setChannelName={setChannelName}
            email={email}
            setEmail={handleEmailInputChange}
            emailAuthMethod={emailAuthMethod}
            password={password}
            setPassword={setPassword}
            emailOauthClientId={emailOauthClientId}
            setEmailOauthClientId={handleOauthClientIdChange}
            emailOauthClientSecret={emailOauthClientSecret}
            setEmailOauthClientSecret={setEmailOauthClientSecret}
            emailOauthTenant={emailOauthTenant}
            setEmailOauthTenant={handleOauthTenantChange}
            imapHost={imapHost}
            setImapHost={setImapHost}
            imapPort={imapPort}
            setImapPort={setImapPort}
            smtpHost={smtpHost}
            setSmtpHost={setSmtpHost}
            smtpPort={smtpPort}
            setSmtpPort={setSmtpPort}
            displayName={displayName}
            setDisplayName={setDisplayName}
            subjectFilter={subjectFilter}
            setSubjectFilter={setSubjectFilter}
            loomBaseUrl={loomBaseUrl}
            setLoomBaseUrl={setLoomBaseUrl}
            loomAccessToken={loomAccessToken}
            setLoomAccessToken={setLoomAccessToken}
            loomIdentity={loomIdentity}
            setLoomIdentity={setLoomIdentity}
            loomMailboxFolder={loomMailboxFolder}
            setLoomMailboxFolder={setLoomMailboxFolder}
            loomPollInterval={loomPollInterval}
            setLoomPollInterval={setLoomPollInterval}
            saving={saving}
            testResult={testResult}
            oauthBusy={oauthBusy}
            oauthError={oauthError}
            oauthConnected={Boolean(emailAccessToken || emailRefreshToken)}
            onConnectMicrosoftOAuth={handleMicrosoftOAuthConnect}
            onClose={() => setSelectedProvider(null)}
            onSubmit={handleAddChannel}
          />
        )}
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
            {isConfiguredMicrosoftOAuth && (
              <button
                className="button-secondary"
                onClick={() => handleMicrosoftOAuthConnect({ persistToChannel: true })}
                disabled={oauthBusy || saving}
              >
                {oauthBusy ? "Reauthenticating..." : "Reauthenticate"}
              </button>
            )}
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
            {testResult.success ? (
              <>✓ {testResult.message || "Connection successful"}</>
            ) : (
              <>✗ {testResult.error}</>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

// ─── Email Provider Modal ─────────────────────────────────────────────────────

function EmailProviderModal({
  def,
  channelName,
  setChannelName,
  email,
  setEmail,
  emailAuthMethod,
  password,
  setPassword,
  emailOauthClientId,
  setEmailOauthClientId,
  emailOauthClientSecret,
  setEmailOauthClientSecret,
  emailOauthTenant,
  setEmailOauthTenant,
  imapHost,
  setImapHost,
  imapPort,
  setImapPort,
  smtpHost,
  setSmtpHost,
  smtpPort,
  setSmtpPort,
  displayName,
  setDisplayName,
  subjectFilter,
  setSubjectFilter,
  loomBaseUrl,
  setLoomBaseUrl,
  loomAccessToken,
  setLoomAccessToken,
  loomIdentity,
  setLoomIdentity,
  loomMailboxFolder,
  setLoomMailboxFolder,
  loomPollInterval,
  setLoomPollInterval,
  saving,
  testResult,
  oauthBusy,
  oauthError,
  oauthConnected,
  onConnectMicrosoftOAuth,
  onClose,
  onSubmit,
}: EmailProviderModalProps) {
  const isLoom = def.protocol === "loom";
  const isMicrosoftOAuth = !isLoom && emailAuthMethod === "oauth";

  const canSubmit =
    (isLoom
      ? Boolean(loomBaseUrl.trim() && loomAccessToken.trim())
      : isMicrosoftOAuth
        ? Boolean(email.trim() && emailOauthClientId.trim() && oauthConnected)
        : Boolean(email.trim() && password.trim() && imapHost.trim() && smtpHost.trim()));

  return (
    <div className="mcp-modal-overlay" onClick={onClose}>
      <div
        className="mcp-modal email-provider-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcp-modal-header">
          <div className="email-modal-header-content">
            <div className="email-modal-header-icon">{def.icon}</div>
            <h3>{def.label}</h3>
          </div>
          <button className="mcp-modal-close" onClick={onClose} aria-label="Close">
            <svg
              width="16"
              height="16"
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
          {/* Channel name */}
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

          {/* IMAP/SMTP fields */}
          {!isLoom && (
            <>
              <div className="settings-field">
                <label>Email Address *</label>
                <input
                  type="email"
                  className="settings-input"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="settings-field">
                {isMicrosoftOAuth ? (
                  <>
                    <label>Microsoft OAuth Client ID *</label>
                    <input
                      type="text"
                      className="settings-input"
                      placeholder="Microsoft Entra app client ID"
                      value={emailOauthClientId}
                      onChange={(e) => setEmailOauthClientId(e.target.value)}
                    />
                    <p className="settings-hint">
                      Outlook.com, Hotmail, Live, and MSN accounts need your own Microsoft Entra
                      app registration before OAuth can work.
                    </p>
                    <details style={{ marginTop: "8px" }}>
                      <summary>Outlook.com setup checklist</summary>
                      <ol className="settings-hint">
                        <li>Create a Microsoft Entra app registration in Azure.</li>
                        <li>
                          Under Supported account types, allow personal Microsoft accounts.
                        </li>
                        <li>
                          Under Authentication, add the <strong>Mobile and desktop applications</strong>{" "}
                          platform with redirect URI <code>http://localhost</code>.
                        </li>
                        <li>
                          If Azure shows <strong>Allow public client flows</strong>, enable it for a
                          native/public client PKCE app.
                        </li>
                        <li>
                          Under API permissions, grant delegated Microsoft Graph{" "}
                          <code>Mail.ReadWrite</code>.
                        </li>
                        <li>
                          Paste the Application (client) ID here, keep tenant{" "}
                          <code>{MICROSOFT_EMAIL_DEFAULT_TENANT}</code> for personal accounts, then
                          click <strong>Connect Microsoft Account</strong>.
                        </li>
                      </ol>
                      <p className="settings-hint">
                        Client secret is optional. Leave it empty for a public/native desktop app
                        that uses PKCE.
                      </p>
                    </details>
                  </>
                ) : (
                  <>
                    <label>Password *</label>
                    <input
                      type="password"
                      className="settings-input"
                      placeholder="Your password or app password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    {def.appPasswordHint && <p className="settings-hint">{def.appPasswordHint}</p>}
                    {def.id === "protonmail" && (
                      <p className="settings-hint">
                        Requires Proton Mail Bridge to be installed and running locally.
                        Use the Bridge password shown in the Bridge app.
                      </p>
                    )}
                  </>
                )}
              </div>

              {isMicrosoftOAuth && (
                <>
                  <div className="settings-field">
                    <label>Client Secret (optional)</label>
                    <input
                      type="password"
                      className="settings-input"
                      placeholder="Microsoft client secret"
                      value={emailOauthClientSecret}
                      onChange={(e) => setEmailOauthClientSecret(e.target.value)}
                    />
                    <p className="settings-hint">
                      Leave empty when using a public/native client registration with PKCE.
                    </p>
                  </div>

                  <div className="settings-field">
                    <label>Tenant</label>
                    <input
                      type="text"
                      className="settings-input"
                      placeholder={MICROSOFT_EMAIL_DEFAULT_TENANT}
                      value={emailOauthTenant}
                      onChange={(e) => setEmailOauthTenant(e.target.value)}
                    />
                    <p className="settings-hint">
                      Use <code>{MICROSOFT_EMAIL_DEFAULT_TENANT}</code> for Outlook.com, Hotmail,
                      Live, and MSN accounts.
                    </p>
                  </div>

                  <div className="settings-field">
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={onConnectMicrosoftOAuth}
                      disabled={oauthBusy || !emailOauthClientId.trim()}
                    >
                      {oauthBusy
                        ? "Connecting..."
                        : oauthConnected
                          ? "Reconnect Microsoft Account"
                          : "Connect Microsoft Account"}
                    </button>
                    <p className="settings-hint">
                      CoWork opens the Microsoft sign-in flow in your browser and stores the
                      refresh token for Microsoft Graph mail access.
                    </p>
                    {oauthConnected && (
                      <p className="settings-hint">Microsoft account authorized successfully.</p>
                    )}
                    {oauthError && <p className="settings-hint warning">OAuth error: {oauthError}</p>}
                  </div>
                </>
              )}

              {!isMicrosoftOAuth && (
                <div className="email-modal-host-grid">
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
              )}

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

          {/* LOOM fields */}
          {isLoom && (
            <>
              <div className="settings-field">
                <label>LOOM Base URL *</label>
                <input
                  type="url"
                  className="settings-input"
                  placeholder="http://127.0.0.1:8787"
                  value={loomBaseUrl}
                  onChange={(e) => setLoomBaseUrl(e.target.value)}
                  autoFocus
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

              <div className="email-modal-host-grid">
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

          {/* Shared optional fields */}
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

          {testResult && (
            <div className={`test-result ${testResult.success ? "success" : "error"}`}>
              {testResult.success ? (
                <>✓ {testResult.message || "Channel added successfully"}</>
              ) : (
                <>✗ {testResult.error}</>
              )}
            </div>
          )}
        </div>

        <div className="email-modal-footer">
          <button className="button-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="button-primary"
            onClick={onSubmit}
            disabled={saving || !canSubmit}
          >
            {saving ? "Adding..." : "Add Email"}
          </button>
        </div>
      </div>
    </div>
  );
}
