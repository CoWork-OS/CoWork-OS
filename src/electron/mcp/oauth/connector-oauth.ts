import { shell } from "electron";
import http from "http";
import { randomBytes, createHash } from "crypto";
import { URL } from "url";

export type ConnectorOAuthProvider =
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

export interface ConnectorOAuthRequest {
  provider: ConnectorOAuthProvider;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  loginUrl?: string; // Salesforce only
  subdomain?: string; // Zendesk only
  teamDomain?: string; // Slack only
}

export interface JiraResource {
  id: string;
  name: string;
  url: string;
  scopes?: string[];
}

export interface ConnectorOAuthResult {
  provider: ConnectorOAuthProvider;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  instanceUrl?: string; // Salesforce
  resources?: JiraResource[]; // Jira
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const OAUTH_CALLBACK_PORT = 18765;

export async function startConnectorOAuth(
  request: ConnectorOAuthRequest,
): Promise<ConnectorOAuthResult> {
  switch (request.provider) {
    case "salesforce":
      return startSalesforceOAuth(request);
    case "jira":
      return startJiraOAuth(request);
    case "hubspot":
      return startHubSpotOAuth(request);
    case "zendesk":
      return startZendeskOAuth(request);
    case "google-calendar":
    case "google-drive":
    case "gmail":
      return startGoogleOAuth(request);
    case "docusign":
      return startDocusignOAuth(request);
    case "outreach":
      return startOutreachOAuth(request);
    case "slack":
      return startSlackOAuth(request);
    default:
      throw new Error(`Unsupported OAuth provider: ${request.provider}`);
  }
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

function createCodeChallenge(verifier: string): string {
  const hash = createHash("sha256").update(verifier).digest();
  return base64Url(hash);
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startOAuthCallbackServer(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{
  redirectUri: string;
  state: string;
  waitForCode: () => Promise<{ code: string; state: string }>;
}> {
  const state = base64Url(randomBytes(16));

  return new Promise((resolve, reject) => {
    const server = http.createServer();

    let resolveCode: (value: { code: string; state: string }) => void = () => {};
    let rejectCode: (error: Error) => void = () => {};

    const codePromise = new Promise<{ code: string; state: string }>(
      (innerResolve, innerReject) => {
        resolveCode = innerResolve;
        rejectCode = innerReject;
      },
    );

    const timeout = setTimeout(() => {
      server.close();
      rejectCode(new Error("OAuth timed out. Please try again."));
    }, timeoutMs);

    server.on("request", (req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Invalid request");
        return;
      }

      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body style="font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', system-ui, sans-serif; padding: 24px;">
        <h2>Authorization complete</h2>
        <p>You can close this window and return to CoWork OS.</p>
      </body></html>`);

      clearTimeout(timeout);
      server.close();

      if (error) {
        rejectCode(new Error(errorDescription || error));
        return;
      }

      if (!code || !returnedState) {
        rejectCode(new Error("Missing OAuth code or state"));
        return;
      }

      if (returnedState !== state) {
        rejectCode(new Error("OAuth state mismatch"));
        return;
      }

      resolveCode({ code, state: returnedState });
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      const portMessage =
        error.code === "EADDRINUSE"
          ? `Port ${OAUTH_CALLBACK_PORT} is already in use. Close the conflicting app and try again.`
          : error.message;
      reject(new Error(`OAuth callback server failed: ${portMessage}`));
    });

    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timeout);
        server.close();
        reject(new Error("Failed to start OAuth callback server"));
        return;
      }

      const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
      resolve({
        redirectUri,
        state,
        waitForCode: () => codePromise,
      });
    });
  });
}

async function startSalesforceOAuth(request: ConnectorOAuthRequest): Promise<ConnectorOAuthResult> {
  const loginUrl = request.loginUrl || "https://login.salesforce.com";

  if (!request.clientId) {
    throw new Error("Salesforce OAuth requires a client ID");
  }
  if (!request.clientSecret) {
    throw new Error("Salesforce OAuth requires a client secret");
  }

  const scope =
    request.scopes && request.scopes.length > 0 ? request.scopes.join(" ") : "api refresh_token";

  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();

  const authUrl = new URL(`${loginUrl.replace(/\/$/, "")}/services/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);

  await shell.openExternal(authUrl.toString());

  const { code } = await waitForCode();

  const tokenUrl = `${loginUrl.replace(/\/$/, "")}/services/oauth2/token`;
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: request.clientId,
    client_secret: request.clientSecret,
    redirect_uri: redirectUri,
  });

  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Salesforce OAuth failed: ${text}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    instance_url?: string;
    token_type?: string;
  };
  if (!tokenData.access_token) {
    throw new Error("Salesforce OAuth did not return an access_token");
  }

  return {
    provider: "salesforce",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    instanceUrl: tokenData.instance_url,
    tokenType: tokenData.token_type,
  };
}

async function startJiraOAuth(request: ConnectorOAuthRequest): Promise<ConnectorOAuthResult> {
  if (!request.clientId) {
    throw new Error("Jira OAuth requires a client ID");
  }
  if (!request.clientSecret) {
    throw new Error("Jira OAuth requires a client secret");
  }

  const scope =
    request.scopes && request.scopes.length > 0
      ? request.scopes.join(" ")
      : "read:jira-user read:jira-work write:jira-work offline_access";

  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();

  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  const authUrl = new URL("https://auth.atlassian.com/authorize");
  authUrl.searchParams.set("audience", "api.atlassian.com");
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  await shell.openExternal(authUrl.toString());

  const { code } = await waitForCode();

  const tokenResponse = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: request.clientId,
      client_secret: request.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Jira OAuth failed: ${text}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!tokenData.access_token) {
    throw new Error("Jira OAuth did not return an access_token");
  }

  const resourcesResponse = await fetch(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/json",
      },
    },
  );

  if (!resourcesResponse.ok) {
    const text = await resourcesResponse.text();
    throw new Error(`Jira OAuth resources fetch failed: ${text}`);
  }

  const resourcesData = await resourcesResponse.json();
  const resources: JiraResource[] = Array.isArray(resourcesData)
    ? resourcesData.map((resource) => ({
        id: resource.id,
        name: resource.name,
        url: resource.url,
        scopes: resource.scopes,
      }))
    : [];

  return {
    provider: "jira",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    tokenType: tokenData.token_type,
    resources,
  };
}

async function startHubSpotOAuth(request: ConnectorOAuthRequest): Promise<ConnectorOAuthResult> {
  if (!request.clientId) {
    throw new Error("HubSpot OAuth requires a client ID");
  }
  if (!request.clientSecret) {
    throw new Error("HubSpot OAuth requires a client secret");
  }

  const scope =
    request.scopes && request.scopes.length > 0
      ? request.scopes.join(" ")
      : "crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write crm.objects.deals.read crm.objects.deals.write";

  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();

  const authUrl = new URL("https://app.hubspot.com/oauth/authorize");
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);

  await shell.openExternal(authUrl.toString());

  const { code } = await waitForCode();

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: request.clientId,
    client_secret: request.clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const tokenResponse = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`HubSpot OAuth failed: ${text}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!tokenData.access_token) {
    throw new Error("HubSpot OAuth did not return an access_token");
  }

  return {
    provider: "hubspot",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    tokenType: tokenData.token_type,
  };
}

async function startZendeskOAuth(request: ConnectorOAuthRequest): Promise<ConnectorOAuthResult> {
  if (!request.clientId) {
    throw new Error("Zendesk OAuth requires a client ID");
  }
  if (!request.clientSecret) {
    throw new Error("Zendesk OAuth requires a client secret");
  }
  if (!request.subdomain) {
    throw new Error("Zendesk OAuth requires a subdomain");
  }

  const scope =
    request.scopes && request.scopes.length > 0 ? request.scopes.join(" ") : "read write";

  const baseUrl = `https://${request.subdomain}.zendesk.com`;
  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();

  const authUrl = new URL(`${baseUrl}/oauth/authorizations/new`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);

  await shell.openExternal(authUrl.toString());

  const { code } = await waitForCode();

  const tokenResponse = await fetch(`${baseUrl}/oauth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: request.clientId,
      client_secret: request.clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Zendesk OAuth failed: ${text}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  if (!tokenData.access_token) {
    throw new Error("Zendesk OAuth did not return an access_token");
  }

  return {
    provider: "zendesk",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    tokenType: tokenData.token_type,
    expiresIn: tokenData.expires_in,
  };
}

// --- Google OAuth (Calendar, Drive, Gmail) ---

const GOOGLE_SCOPES_MAP: Record<string, string> = {
  "google-calendar":
    "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
  "google-drive":
    "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
  gmail:
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.labels",
};

async function startGoogleOAuth(request: ConnectorOAuthRequest): Promise<ConnectorOAuthResult> {
  if (!request.clientId) {
    throw new Error("Google OAuth requires a client ID");
  }
  if (!request.clientSecret) {
    throw new Error("Google OAuth requires a client secret");
  }

  const defaultScope = GOOGLE_SCOPES_MAP[request.provider] || GOOGLE_SCOPES_MAP["gmail"];
  const scope =
    request.scopes && request.scopes.length > 0 ? request.scopes.join(" ") : defaultScope;

  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();

  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  await shell.openExternal(authUrl.toString());

  const { code } = await waitForCode();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: request.clientId,
      client_secret: request.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Google OAuth failed: ${text}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!tokenData.access_token) {
    throw new Error("Google OAuth did not return an access_token");
  }

  return {
    provider: request.provider,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    tokenType: tokenData.token_type,
  };
}

// --- DocuSign OAuth ---

async function startDocusignOAuth(request: ConnectorOAuthRequest): Promise<ConnectorOAuthResult> {
  if (!request.clientId) {
    throw new Error("DocuSign OAuth requires a client ID");
  }
  if (!request.clientSecret) {
    throw new Error("DocuSign OAuth requires a client secret");
  }

  const scope =
    request.scopes && request.scopes.length > 0 ? request.scopes.join(" ") : "signature";

  const baseUrl = request.loginUrl || "https://account-d.docusign.com";
  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();

  const authUrl = new URL(`${baseUrl}/oauth/auth`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  await shell.openExternal(authUrl.toString());

  const { code } = await waitForCode();

  const credentials = Buffer.from(`${request.clientId}:${request.clientSecret}`).toString("base64");
  const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`DocuSign OAuth failed: ${text}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!tokenData.access_token) {
    throw new Error("DocuSign OAuth did not return an access_token");
  }

  return {
    provider: "docusign",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    tokenType: tokenData.token_type,
  };
}

// --- Outreach OAuth ---

async function startOutreachOAuth(request: ConnectorOAuthRequest): Promise<ConnectorOAuthResult> {
  if (!request.clientId) {
    throw new Error("Outreach OAuth requires a client ID");
  }
  if (!request.clientSecret) {
    throw new Error("Outreach OAuth requires a client secret");
  }

  const scope =
    request.scopes && request.scopes.length > 0
      ? request.scopes.join(" ")
      : "users.all prospects.all accounts.all";

  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();

  const authUrl = new URL("https://api.outreach.io/api/v2/oauth/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);

  await shell.openExternal(authUrl.toString());

  const { code } = await waitForCode();

  const tokenResponse = await fetch("https://api.outreach.io/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: request.clientId,
      client_secret: request.clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Outreach OAuth failed: ${text}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!tokenData.access_token) {
    throw new Error("Outreach OAuth did not return an access_token");
  }

  return {
    provider: "outreach",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    tokenType: tokenData.token_type,
  };
}

// --- Slack OAuth ---

async function startSlackOAuth(request: ConnectorOAuthRequest): Promise<ConnectorOAuthResult> {
  if (!request.clientId) {
    throw new Error("Slack OAuth requires a client ID");
  }
  if (!request.clientSecret) {
    throw new Error("Slack OAuth requires a client secret");
  }

  const scope =
    request.scopes && request.scopes.length > 0
      ? request.scopes.join(",")
      : "channels:read,channels:history,chat:write,users:read";

  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();

  const authUrl = new URL("https://slack.com/oauth/v2/authorize");
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  if (request.teamDomain) {
    authUrl.searchParams.set("team", request.teamDomain);
  }

  await shell.openExternal(authUrl.toString());

  const { code } = await waitForCode();

  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: request.clientId,
      client_secret: request.clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Slack OAuth failed: ${text}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    ok?: boolean;
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    error?: string;
    authed_user?: { access_token?: string };
  };

  if (!tokenData.ok || !tokenData.access_token) {
    throw new Error(`Slack OAuth failed: ${tokenData.error || "No access token returned"}`);
  }

  return {
    provider: "slack",
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    tokenType: tokenData.token_type,
  };
}
