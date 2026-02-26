import { useMemo, useState } from "react";

export type ConnectorProvider =
  | "salesforce"
  | "jira"
  | "hubspot"
  | "zendesk"
  | "google-calendar"
  | "google-drive"
  | "gmail"
  | "docusign"
  | "outreach"
  | "slack";

interface ConnectorSetupModalProps {
  provider: ConnectorProvider;
  serverId: string;
  serverName: string;
  initialEnv?: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}

interface JiraResource {
  id: string;
  name: string;
  url: string;
  scopes?: string[];
}

export function ConnectorSetupModal({
  provider,
  serverId,
  serverName,
  initialEnv = {},
  onClose,
  onSaved,
}: ConnectorSetupModalProps) {
  const [mode, setMode] = useState<"oauth" | "manual">("oauth");
  const [saving, setSaving] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  // Salesforce fields
  const [sfClientId, setSfClientId] = useState(initialEnv.SALESFORCE_CLIENT_ID || "");
  const [sfClientSecret, setSfClientSecret] = useState(initialEnv.SALESFORCE_CLIENT_SECRET || "");
  const [sfLoginUrl, setSfLoginUrl] = useState(
    initialEnv.SALESFORCE_LOGIN_URL || "https://login.salesforce.com",
  );
  const [sfScopes, setSfScopes] = useState("api refresh_token");
  const [sfInstanceUrl, setSfInstanceUrl] = useState(initialEnv.SALESFORCE_INSTANCE_URL || "");
  const [sfAccessToken, setSfAccessToken] = useState(initialEnv.SALESFORCE_ACCESS_TOKEN || "");

  // Jira fields
  const [jiraClientId, setJiraClientId] = useState(initialEnv.JIRA_CLIENT_ID || "");
  const [jiraClientSecret, setJiraClientSecret] = useState(initialEnv.JIRA_CLIENT_SECRET || "");
  const [jiraScopes, setJiraScopes] = useState(
    "read:jira-user read:jira-work write:jira-work offline_access",
  );
  const [jiraBaseUrl, setJiraBaseUrl] = useState(initialEnv.JIRA_BASE_URL || "");
  const [jiraEmail, setJiraEmail] = useState(initialEnv.JIRA_EMAIL || "");
  const [jiraApiToken, setJiraApiToken] = useState(initialEnv.JIRA_API_TOKEN || "");
  const [jiraResources, setJiraResources] = useState<JiraResource[]>([]);
  const [selectedJiraResourceId, setSelectedJiraResourceId] = useState("");
  const [jiraOauthTokens, setJiraOauthTokens] = useState<{
    accessToken: string;
    refreshToken?: string;
  } | null>(null);

  // HubSpot fields
  const [hubspotClientId, setHubspotClientId] = useState(initialEnv.HUBSPOT_CLIENT_ID || "");
  const [hubspotClientSecret, setHubspotClientSecret] = useState(
    initialEnv.HUBSPOT_CLIENT_SECRET || "",
  );
  const [hubspotScopes, setHubspotScopes] = useState(
    "crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write crm.objects.deals.read crm.objects.deals.write",
  );
  const [hubspotAccessToken, setHubspotAccessToken] = useState(
    initialEnv.HUBSPOT_ACCESS_TOKEN || "",
  );

  // Zendesk fields
  const [zendeskSubdomain, setZendeskSubdomain] = useState(initialEnv.ZENDESK_SUBDOMAIN || "");
  const [zendeskClientId, setZendeskClientId] = useState(initialEnv.ZENDESK_CLIENT_ID || "");
  const [zendeskClientSecret, setZendeskClientSecret] = useState(
    initialEnv.ZENDESK_CLIENT_SECRET || "",
  );
  const [zendeskScopes, setZendeskScopes] = useState("read write");
  const [zendeskEmail, setZendeskEmail] = useState(initialEnv.ZENDESK_EMAIL || "");
  const [zendeskApiToken, setZendeskApiToken] = useState(initialEnv.ZENDESK_API_TOKEN || "");
  const [zendeskAccessToken, setZendeskAccessToken] = useState(
    initialEnv.ZENDESK_ACCESS_TOKEN || "",
  );

  // Google fields (shared for Calendar, Drive, Gmail)
  const [googleClientId, setGoogleClientId] = useState(initialEnv.GOOGLE_CLIENT_ID || "");
  const [googleClientSecret, setGoogleClientSecret] = useState(
    initialEnv.GOOGLE_CLIENT_SECRET || "",
  );
  const [googleAccessToken, setGoogleAccessToken] = useState(initialEnv.GOOGLE_ACCESS_TOKEN || "");
  const [googleRefreshToken, setGoogleRefreshToken] = useState(
    initialEnv.GOOGLE_REFRESH_TOKEN || "",
  );

  // DocuSign fields
  const [docusignClientId, setDocusignClientId] = useState(initialEnv.DOCUSIGN_CLIENT_ID || "");
  const [docusignClientSecret, setDocusignClientSecret] = useState(
    initialEnv.DOCUSIGN_CLIENT_SECRET || "",
  );
  const [docusignAccessToken, setDocusignAccessToken] = useState(
    initialEnv.DOCUSIGN_ACCESS_TOKEN || "",
  );
  const [docusignBaseUrl, setDocusignBaseUrl] = useState(
    initialEnv.DOCUSIGN_BASE_URL || "https://account-d.docusign.com",
  );

  // Outreach fields
  const [outreachClientId, setOutreachClientId] = useState(initialEnv.OUTREACH_CLIENT_ID || "");
  const [outreachClientSecret, setOutreachClientSecret] = useState(
    initialEnv.OUTREACH_CLIENT_SECRET || "",
  );
  const [outreachAccessToken, setOutreachAccessToken] = useState(
    initialEnv.OUTREACH_ACCESS_TOKEN || "",
  );

  // Slack fields
  const [slackClientId, setSlackClientId] = useState(initialEnv.SLACK_CLIENT_ID || "");
  const [slackClientSecret, setSlackClientSecret] = useState(initialEnv.SLACK_CLIENT_SECRET || "");
  const [slackBotToken, setSlackBotToken] = useState(initialEnv.SLACK_BOT_TOKEN || "");

  const isSalesforce = provider === "salesforce";
  const isJira = provider === "jira";
  const isHubSpot = provider === "hubspot";
  const isZendesk = provider === "zendesk";
  const isGoogle =
    provider === "google-calendar" || provider === "google-drive" || provider === "gmail";
  const isDocusign = provider === "docusign";
  const isOutreach = provider === "outreach";
  const isSlack = provider === "slack";

  const selectedJiraResource = useMemo(() => {
    if (!selectedJiraResourceId) return null;
    return jiraResources.find((resource) => resource.id === selectedJiraResourceId) || null;
  }, [jiraResources, selectedJiraResourceId]);

  const parseScopes = (value: string) =>
    value
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const sanitizeEnv = (env: Record<string, string | undefined>): Record<string, string> => {
    const merged: Record<string, string> = { ...initialEnv };
    Object.entries(env).forEach(([key, value]) => {
      if (value === undefined || value === "") {
        delete merged[key];
        return;
      }
      merged[key] = value;
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

  const saveEnv = async (env: Record<string, string | undefined>) => {
    setSaving(true);
    try {
      const merged = sanitizeEnv(env);
      await window.electronAPI.updateMCPServer(serverId, { env: merged });
      await reconnectServer();
      onSaved();
      onClose();
    } catch (error: Any) {
      setOauthError(error.message || "Failed to save credentials");
    } finally {
      setSaving(false);
    }
  };

  const handleSalesforceOAuth = async () => {
    setOauthBusy(true);
    setOauthError(null);
    try {
      const result = await window.electronAPI.startConnectorOAuth({
        provider: "salesforce",
        clientId: sfClientId,
        clientSecret: sfClientSecret,
        scopes: parseScopes(sfScopes),
        loginUrl: sfLoginUrl,
      });

      await saveEnv({
        SALESFORCE_ACCESS_TOKEN: result.accessToken,
        SALESFORCE_REFRESH_TOKEN: result.refreshToken || "",
        SALESFORCE_INSTANCE_URL: result.instanceUrl || sfInstanceUrl,
        SALESFORCE_CLIENT_ID: sfClientId,
        SALESFORCE_CLIENT_SECRET: sfClientSecret,
        SALESFORCE_LOGIN_URL: sfLoginUrl,
      });
    } catch (error: Any) {
      setOauthError(error.message || "Salesforce OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleJiraOAuth = async () => {
    setOauthBusy(true);
    setOauthError(null);
    try {
      const result = await window.electronAPI.startConnectorOAuth({
        provider: "jira",
        clientId: jiraClientId,
        clientSecret: jiraClientSecret,
        scopes: parseScopes(jiraScopes),
      });

      const resources = result.resources || [];
      setJiraResources(resources);
      if (resources.length === 0) {
        setOauthError("No Jira sites were returned for this account.");
        return;
      }
      if (resources.length === 1) {
        setSelectedJiraResourceId(resources[0].id);
      }
      setJiraOauthTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    } catch (error: Any) {
      setOauthError(error.message || "Jira OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleHubSpotOAuth = async () => {
    setOauthBusy(true);
    setOauthError(null);
    try {
      const result = await window.electronAPI.startConnectorOAuth({
        provider: "hubspot",
        clientId: hubspotClientId,
        clientSecret: hubspotClientSecret,
        scopes: parseScopes(hubspotScopes),
      });

      await saveEnv({
        HUBSPOT_ACCESS_TOKEN: result.accessToken,
        HUBSPOT_REFRESH_TOKEN: result.refreshToken || "",
        HUBSPOT_CLIENT_ID: hubspotClientId,
        HUBSPOT_CLIENT_SECRET: hubspotClientSecret,
      });
    } catch (error: Any) {
      setOauthError(error.message || "HubSpot OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleZendeskOAuth = async () => {
    setOauthBusy(true);
    setOauthError(null);
    try {
      const result = await window.electronAPI.startConnectorOAuth({
        provider: "zendesk",
        clientId: zendeskClientId,
        clientSecret: zendeskClientSecret,
        scopes: parseScopes(zendeskScopes),
        subdomain: zendeskSubdomain,
      });

      await saveEnv({
        ZENDESK_SUBDOMAIN: zendeskSubdomain,
        ZENDESK_ACCESS_TOKEN: result.accessToken,
        ZENDESK_REFRESH_TOKEN: result.refreshToken || "",
        ZENDESK_CLIENT_ID: zendeskClientId,
        ZENDESK_CLIENT_SECRET: zendeskClientSecret,
        ZENDESK_EMAIL: "",
        ZENDESK_API_TOKEN: "",
      });
    } catch (error: Any) {
      setOauthError(error.message || "Zendesk OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleGoogleOAuth = async () => {
    setOauthBusy(true);
    setOauthError(null);
    try {
      const result = await window.electronAPI.startConnectorOAuth({
        provider,
        clientId: googleClientId,
        clientSecret: googleClientSecret,
      });
      await saveEnv({
        GOOGLE_ACCESS_TOKEN: result.accessToken,
        GOOGLE_REFRESH_TOKEN: result.refreshToken || "",
        GOOGLE_CLIENT_ID: googleClientId,
        GOOGLE_CLIENT_SECRET: googleClientSecret,
      });
    } catch (error: Any) {
      setOauthError(error.message || "Google OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleDocusignOAuth = async () => {
    setOauthBusy(true);
    setOauthError(null);
    try {
      const result = await window.electronAPI.startConnectorOAuth({
        provider: "docusign",
        clientId: docusignClientId,
        clientSecret: docusignClientSecret,
        loginUrl: docusignBaseUrl,
      });
      await saveEnv({
        DOCUSIGN_ACCESS_TOKEN: result.accessToken,
        DOCUSIGN_REFRESH_TOKEN: result.refreshToken || "",
        DOCUSIGN_CLIENT_ID: docusignClientId,
        DOCUSIGN_CLIENT_SECRET: docusignClientSecret,
        DOCUSIGN_BASE_URL: docusignBaseUrl,
      });
    } catch (error: Any) {
      setOauthError(error.message || "DocuSign OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleOutreachOAuth = async () => {
    setOauthBusy(true);
    setOauthError(null);
    try {
      const result = await window.electronAPI.startConnectorOAuth({
        provider: "outreach",
        clientId: outreachClientId,
        clientSecret: outreachClientSecret,
      });
      await saveEnv({
        OUTREACH_ACCESS_TOKEN: result.accessToken,
        OUTREACH_REFRESH_TOKEN: result.refreshToken || "",
        OUTREACH_CLIENT_ID: outreachClientId,
        OUTREACH_CLIENT_SECRET: outreachClientSecret,
      });
    } catch (error: Any) {
      setOauthError(error.message || "Outreach OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleSlackOAuth = async () => {
    setOauthBusy(true);
    setOauthError(null);
    try {
      const result = await window.electronAPI.startConnectorOAuth({
        provider: "slack",
        clientId: slackClientId,
        clientSecret: slackClientSecret,
      });
      await saveEnv({
        SLACK_BOT_TOKEN: result.accessToken,
        SLACK_ACCESS_TOKEN: result.accessToken,
        SLACK_REFRESH_TOKEN: result.refreshToken || "",
        SLACK_CLIENT_ID: slackClientId,
        SLACK_CLIENT_SECRET: slackClientSecret,
      });
    } catch (error: Any) {
      setOauthError(error.message || "Slack OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleManualSave = async () => {
    if (isSalesforce) {
      await saveEnv({
        SALESFORCE_INSTANCE_URL: sfInstanceUrl,
        SALESFORCE_ACCESS_TOKEN: sfAccessToken,
        SALESFORCE_REFRESH_TOKEN: "",
      });
    } else if (isJira) {
      await saveEnv({
        JIRA_BASE_URL: jiraBaseUrl,
        JIRA_EMAIL: jiraEmail,
        JIRA_API_TOKEN: jiraApiToken,
        JIRA_ACCESS_TOKEN: "",
        JIRA_REFRESH_TOKEN: "",
        JIRA_CLIENT_ID: "",
        JIRA_CLIENT_SECRET: "",
      });
    } else if (isHubSpot) {
      await saveEnv({
        HUBSPOT_ACCESS_TOKEN: hubspotAccessToken,
        HUBSPOT_REFRESH_TOKEN: "",
      });
    } else if (isZendesk) {
      await saveEnv({
        ZENDESK_SUBDOMAIN: zendeskSubdomain,
        ZENDESK_EMAIL: zendeskEmail,
        ZENDESK_API_TOKEN: zendeskApiToken,
        ZENDESK_ACCESS_TOKEN: zendeskAccessToken,
        ZENDESK_REFRESH_TOKEN: "",
        ZENDESK_CLIENT_ID: "",
        ZENDESK_CLIENT_SECRET: "",
      });
    } else if (isGoogle) {
      await saveEnv({
        GOOGLE_ACCESS_TOKEN: googleAccessToken,
        GOOGLE_REFRESH_TOKEN: googleRefreshToken,
      });
    } else if (isDocusign) {
      await saveEnv({
        DOCUSIGN_ACCESS_TOKEN: docusignAccessToken,
        DOCUSIGN_BASE_URL: docusignBaseUrl,
      });
    } else if (isOutreach) {
      await saveEnv({
        OUTREACH_ACCESS_TOKEN: outreachAccessToken,
      });
    } else if (isSlack) {
      await saveEnv({
        SLACK_BOT_TOKEN: slackBotToken,
      });
    }
  };

  const handleJiraOauthSave = async () => {
    if (!jiraOauthTokens || !selectedJiraResource) {
      setOauthError("Select a Jira site before saving.");
      return;
    }
    const cloudBase = `https://api.atlassian.com/ex/jira/${selectedJiraResource.id}`;
    await saveEnv({
      JIRA_BASE_URL: cloudBase,
      JIRA_ACCESS_TOKEN: jiraOauthTokens.accessToken,
      JIRA_REFRESH_TOKEN: jiraOauthTokens.refreshToken || "",
      JIRA_CLIENT_ID: jiraClientId,
      JIRA_CLIENT_SECRET: jiraClientSecret,
      JIRA_EMAIL: "",
      JIRA_API_TOKEN: "",
    });
  };

  return (
    <div className="mcp-modal-overlay" onClick={onClose}>
      <div className="mcp-modal connector-setup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-modal-header">
          <div className="registry-details-title">
            <h3>{serverName} Setup</h3>
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
          <div className="settings-field">
            <label>Setup Method</label>
            <div className="connector-mode-toggle">
              <button
                className={`button-small ${mode === "oauth" ? "button-primary" : "button-secondary"}`}
                onClick={() => setMode("oauth")}
              >
                OAuth
              </button>
              <button
                className={`button-small ${mode === "manual" ? "button-primary" : "button-secondary"}`}
                onClick={() => setMode("manual")}
              >
                Manual Token
              </button>
            </div>
          </div>

          {mode === "oauth" && isSalesforce && (
            <>
              <div className="settings-field">
                <label>Client ID</label>
                <input
                  className="settings-input"
                  value={sfClientId}
                  onChange={(e) => setSfClientId(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Client Secret</label>
                <input
                  className="settings-input"
                  type="password"
                  value={sfClientSecret}
                  onChange={(e) => setSfClientSecret(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Login URL</label>
                <input
                  className="settings-input"
                  value={sfLoginUrl}
                  onChange={(e) => setSfLoginUrl(e.target.value)}
                />
                <p className="settings-hint">Use https://test.salesforce.com for sandbox orgs.</p>
              </div>
              <div className="settings-field">
                <label>Scopes</label>
                <input
                  className="settings-input"
                  value={sfScopes}
                  onChange={(e) => setSfScopes(e.target.value)}
                />
              </div>
              <p className="settings-hint">Redirect URI: http://127.0.0.1:18765/oauth/callback</p>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleSalesforceOAuth}
                  disabled={oauthBusy || !sfClientId || !sfClientSecret}
                >
                  {oauthBusy ? "Authorizing..." : "Authorize Salesforce"}
                </button>
              </div>
            </>
          )}

          {mode === "oauth" && isJira && (
            <>
              <div className="settings-field">
                <label>Client ID</label>
                <input
                  className="settings-input"
                  value={jiraClientId}
                  onChange={(e) => setJiraClientId(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Client Secret</label>
                <input
                  className="settings-input"
                  type="password"
                  value={jiraClientSecret}
                  onChange={(e) => setJiraClientSecret(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Scopes</label>
                <input
                  className="settings-input"
                  value={jiraScopes}
                  onChange={(e) => setJiraScopes(e.target.value)}
                />
              </div>
              <p className="settings-hint">Redirect URI: http://127.0.0.1:18765/oauth/callback</p>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleJiraOAuth}
                  disabled={oauthBusy || !jiraClientId || !jiraClientSecret}
                >
                  {oauthBusy ? "Authorizing..." : "Authorize Jira"}
                </button>
              </div>

              {jiraResources.length > 0 && (
                <div className="settings-field">
                  <label>Select Jira Site</label>
                  <select
                    className="settings-input"
                    value={selectedJiraResourceId}
                    onChange={(e) => setSelectedJiraResourceId(e.target.value)}
                  >
                    <option value="">Choose a site</option>
                    {jiraResources.map((resource) => (
                      <option key={resource.id} value={resource.id}>
                        {resource.name} ({resource.url})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {jiraOauthTokens && (
                <div className="connector-setup-actions">
                  <button
                    className="button-primary"
                    onClick={handleJiraOauthSave}
                    disabled={!selectedJiraResourceId || saving}
                  >
                    {saving ? "Saving..." : "Save Jira Connection"}
                  </button>
                </div>
              )}
            </>
          )}

          {mode === "oauth" && isHubSpot && (
            <>
              <div className="settings-field">
                <label>Client ID</label>
                <input
                  className="settings-input"
                  value={hubspotClientId}
                  onChange={(e) => setHubspotClientId(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Client Secret</label>
                <input
                  className="settings-input"
                  type="password"
                  value={hubspotClientSecret}
                  onChange={(e) => setHubspotClientSecret(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Scopes</label>
                <input
                  className="settings-input"
                  value={hubspotScopes}
                  onChange={(e) => setHubspotScopes(e.target.value)}
                />
              </div>
              <p className="settings-hint">Redirect URI: http://127.0.0.1:18765/oauth/callback</p>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleHubSpotOAuth}
                  disabled={oauthBusy || !hubspotClientId || !hubspotClientSecret}
                >
                  {oauthBusy ? "Authorizing..." : "Authorize HubSpot"}
                </button>
              </div>
            </>
          )}

          {mode === "oauth" && isZendesk && (
            <>
              <div className="settings-field">
                <label>Subdomain</label>
                <input
                  className="settings-input"
                  value={zendeskSubdomain}
                  onChange={(e) => setZendeskSubdomain(e.target.value)}
                  placeholder="your-company"
                />
              </div>
              <div className="settings-field">
                <label>Client ID</label>
                <input
                  className="settings-input"
                  value={zendeskClientId}
                  onChange={(e) => setZendeskClientId(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Client Secret</label>
                <input
                  className="settings-input"
                  type="password"
                  value={zendeskClientSecret}
                  onChange={(e) => setZendeskClientSecret(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Scopes</label>
                <input
                  className="settings-input"
                  value={zendeskScopes}
                  onChange={(e) => setZendeskScopes(e.target.value)}
                />
              </div>
              <p className="settings-hint">Redirect URI: http://127.0.0.1:18765/oauth/callback</p>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleZendeskOAuth}
                  disabled={
                    oauthBusy || !zendeskClientId || !zendeskClientSecret || !zendeskSubdomain
                  }
                >
                  {oauthBusy ? "Authorizing..." : "Authorize Zendesk"}
                </button>
              </div>
            </>
          )}

          {mode === "oauth" && isGoogle && (
            <>
              <div className="settings-field">
                <label>Client ID</label>
                <input
                  className="settings-input"
                  value={googleClientId}
                  onChange={(e) => setGoogleClientId(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Client Secret</label>
                <input
                  className="settings-input"
                  type="password"
                  value={googleClientSecret}
                  onChange={(e) => setGoogleClientSecret(e.target.value)}
                />
              </div>
              <p className="settings-hint">
                Create credentials at console.cloud.google.com. Redirect URI:
                http://127.0.0.1:18765/oauth/callback
              </p>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleGoogleOAuth}
                  disabled={oauthBusy || !googleClientId || !googleClientSecret}
                >
                  {oauthBusy ? "Authorizing..." : `Authorize ${serverName}`}
                </button>
              </div>
            </>
          )}

          {mode === "oauth" && isDocusign && (
            <>
              <div className="settings-field">
                <label>Client ID (Integration Key)</label>
                <input
                  className="settings-input"
                  value={docusignClientId}
                  onChange={(e) => setDocusignClientId(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Client Secret</label>
                <input
                  className="settings-input"
                  type="password"
                  value={docusignClientSecret}
                  onChange={(e) => setDocusignClientSecret(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Environment URL</label>
                <input
                  className="settings-input"
                  value={docusignBaseUrl}
                  onChange={(e) => setDocusignBaseUrl(e.target.value)}
                />
                <p className="settings-hint">
                  Use https://account-d.docusign.com for demo, https://account.docusign.com for
                  production.
                </p>
              </div>
              <p className="settings-hint">Redirect URI: http://127.0.0.1:18765/oauth/callback</p>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleDocusignOAuth}
                  disabled={oauthBusy || !docusignClientId || !docusignClientSecret}
                >
                  {oauthBusy ? "Authorizing..." : "Authorize DocuSign"}
                </button>
              </div>
            </>
          )}

          {mode === "oauth" && isOutreach && (
            <>
              <div className="settings-field">
                <label>Client ID</label>
                <input
                  className="settings-input"
                  value={outreachClientId}
                  onChange={(e) => setOutreachClientId(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Client Secret</label>
                <input
                  className="settings-input"
                  type="password"
                  value={outreachClientSecret}
                  onChange={(e) => setOutreachClientSecret(e.target.value)}
                />
              </div>
              <p className="settings-hint">Redirect URI: http://127.0.0.1:18765/oauth/callback</p>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleOutreachOAuth}
                  disabled={oauthBusy || !outreachClientId || !outreachClientSecret}
                >
                  {oauthBusy ? "Authorizing..." : "Authorize Outreach"}
                </button>
              </div>
            </>
          )}

          {mode === "oauth" && isSlack && (
            <>
              <div className="settings-field">
                <label>Client ID</label>
                <input
                  className="settings-input"
                  value={slackClientId}
                  onChange={(e) => setSlackClientId(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Client Secret</label>
                <input
                  className="settings-input"
                  type="password"
                  value={slackClientSecret}
                  onChange={(e) => setSlackClientSecret(e.target.value)}
                />
              </div>
              <p className="settings-hint">
                Create a Slack app at api.slack.com/apps. Redirect URI:
                http://127.0.0.1:18765/oauth/callback
              </p>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleSlackOAuth}
                  disabled={oauthBusy || !slackClientId || !slackClientSecret}
                >
                  {oauthBusy ? "Authorizing..." : "Authorize Slack"}
                </button>
              </div>
            </>
          )}

          {mode === "manual" && isSalesforce && (
            <>
              <div className="settings-field">
                <label>Instance URL</label>
                <input
                  className="settings-input"
                  value={sfInstanceUrl}
                  onChange={(e) => setSfInstanceUrl(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Access Token</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={sfAccessToken}
                  onChange={(e) => setSfAccessToken(e.target.value)}
                />
              </div>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleManualSave}
                  disabled={!sfInstanceUrl || !sfAccessToken || saving}
                >
                  {saving ? "Saving..." : "Save Salesforce Credentials"}
                </button>
              </div>
            </>
          )}

          {mode === "manual" && isJira && (
            <>
              <div className="settings-field">
                <label>Base URL</label>
                <input
                  className="settings-input"
                  value={jiraBaseUrl}
                  onChange={(e) => setJiraBaseUrl(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Email</label>
                <input
                  className="settings-input"
                  value={jiraEmail}
                  onChange={(e) => setJiraEmail(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>API Token</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={jiraApiToken}
                  onChange={(e) => setJiraApiToken(e.target.value)}
                />
              </div>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleManualSave}
                  disabled={!jiraBaseUrl || !jiraEmail || !jiraApiToken || saving}
                >
                  {saving ? "Saving..." : "Save Jira Credentials"}
                </button>
              </div>
            </>
          )}

          {mode === "manual" && isHubSpot && (
            <>
              <div className="settings-field">
                <label>Access Token</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={hubspotAccessToken}
                  onChange={(e) => setHubspotAccessToken(e.target.value)}
                />
              </div>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleManualSave}
                  disabled={!hubspotAccessToken || saving}
                >
                  {saving ? "Saving..." : "Save HubSpot Credentials"}
                </button>
              </div>
            </>
          )}

          {mode === "manual" && isZendesk && (
            <>
              <div className="settings-field">
                <label>Subdomain</label>
                <input
                  className="settings-input"
                  value={zendeskSubdomain}
                  onChange={(e) => setZendeskSubdomain(e.target.value)}
                  placeholder="your-company"
                />
              </div>
              <div className="settings-field">
                <label>Email</label>
                <input
                  className="settings-input"
                  value={zendeskEmail}
                  onChange={(e) => setZendeskEmail(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>API Token</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={zendeskApiToken}
                  onChange={(e) => setZendeskApiToken(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Access Token (optional)</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={zendeskAccessToken}
                  onChange={(e) => setZendeskAccessToken(e.target.value)}
                />
              </div>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleManualSave}
                  disabled={!zendeskSubdomain || !zendeskEmail || !zendeskApiToken || saving}
                >
                  {saving ? "Saving..." : "Save Zendesk Credentials"}
                </button>
              </div>
            </>
          )}

          {mode === "manual" && isGoogle && (
            <>
              <div className="settings-field">
                <label>Access Token</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={googleAccessToken}
                  onChange={(e) => setGoogleAccessToken(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Refresh Token (optional)</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={googleRefreshToken}
                  onChange={(e) => setGoogleRefreshToken(e.target.value)}
                />
              </div>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleManualSave}
                  disabled={!googleAccessToken || saving}
                >
                  {saving ? "Saving..." : `Save ${serverName} Credentials`}
                </button>
              </div>
            </>
          )}

          {mode === "manual" && isDocusign && (
            <>
              <div className="settings-field">
                <label>Base URL</label>
                <input
                  className="settings-input"
                  value={docusignBaseUrl}
                  onChange={(e) => setDocusignBaseUrl(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label>Access Token</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={docusignAccessToken}
                  onChange={(e) => setDocusignAccessToken(e.target.value)}
                />
              </div>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleManualSave}
                  disabled={!docusignAccessToken || saving}
                >
                  {saving ? "Saving..." : "Save DocuSign Credentials"}
                </button>
              </div>
            </>
          )}

          {mode === "manual" && isOutreach && (
            <>
              <div className="settings-field">
                <label>Access Token</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={outreachAccessToken}
                  onChange={(e) => setOutreachAccessToken(e.target.value)}
                />
              </div>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleManualSave}
                  disabled={!outreachAccessToken || saving}
                >
                  {saving ? "Saving..." : "Save Outreach Credentials"}
                </button>
              </div>
            </>
          )}

          {mode === "manual" && isSlack && (
            <>
              <div className="settings-field">
                <label>Bot Token</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  value={slackBotToken}
                  onChange={(e) => setSlackBotToken(e.target.value)}
                  placeholder="xoxb-..."
                />
              </div>
              <div className="connector-setup-actions">
                <button
                  className="button-primary"
                  onClick={handleManualSave}
                  disabled={!slackBotToken || saving}
                >
                  {saving ? "Saving..." : "Save Slack Credentials"}
                </button>
              </div>
            </>
          )}

          {oauthError && (
            <div className="mcp-server-error">
              <span className="mcp-error-icon">⚠</span>
              {oauthError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
