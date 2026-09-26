import { refreshMicrosoftEmailAccessToken } from "../../utils/microsoft-email-oauth";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;

export type TeamsGraphErrorKind =
  | "auth_expired"
  | "tenant_blocked"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "transient"
  | "other";

export class TeamsGraphError extends Error {
  constructor(
    message: string,
    readonly kind: TeamsGraphErrorKind,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface TeamsTokenState {
  clientId?: string;
  tenant?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  scopes?: string[];
}

export interface TeamsGraphClientDeps {
  loadTokens: () => TeamsTokenState;
  saveTokens: (tokens: Partial<TeamsTokenState>) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  refresh?: typeof refreshMicrosoftEmailAccessToken;
}

type GraphErrorBody = {
  error?: { code?: string; message?: string; innerError?: { code?: string } };
};

function classify(status: number, body: GraphErrorBody): TeamsGraphError {
  const code = body.error?.innerError?.code || body.error?.code;
  const message = body.error?.message || `Microsoft Graph returned HTTP ${status}`;
  if (status === 401) {
    return new TeamsGraphError(
      "Microsoft rejected the Teams meeting token. Reconnect Teams meeting capture in Settings.",
      "auth_expired",
      status,
      code,
    );
  }
  if (status === 403 && code === "GraphAccessToTranscriptsDisabled") {
    return new TeamsGraphError(
      "A tenant administrator has turned off Microsoft Graph access to meeting transcripts. Ask them to enable transcript API access for Teams meetings.",
      "tenant_blocked",
      status,
      code,
    );
  }
  if (status === 403) return new TeamsGraphError(message, "forbidden", status, code);
  if (status === 404) return new TeamsGraphError(message, "not_found", status, code);
  if (status === 429) return new TeamsGraphError(message, "rate_limited", status, code);
  if (status >= 500) return new TeamsGraphError(message, "transient", status, code);
  return new TeamsGraphError(message, "other", status, code);
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  const base = Number.isFinite(header) && header > 0 ? header * 1000 : 1000 * 2 ** attempt;
  return Math.min(base, MAX_RETRY_AFTER_MS);
}

export class TeamsGraphClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly refresh: typeof refreshMicrosoftEmailAccessToken;

  constructor(private readonly deps: TeamsGraphClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.refresh = deps.refresh ?? refreshMicrosoftEmailAccessToken;
  }

  async json<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    pathOrUrl: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.send(method, pathOrUrl, body, headers);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async text(pathOrUrl: string, accept: string): Promise<string> {
    const response = await this.send("GET", pathOrUrl, undefined, { Accept: accept });
    return response.text();
  }

  /** Returns the raw response for streaming large content such as recordings. */
  async raw(pathOrUrl: string, accept = "*/*"): Promise<Response> {
    return this.send("GET", pathOrUrl, undefined, { Accept: accept });
  }

  /** Follow @odata.nextLink up to `maxPages`. */
  async collect<T>(path: string, maxPages = 5): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < maxPages; page++) {
      const result: { value?: T[]; "@odata.nextLink"?: string } = await this.json("GET", next);
      items.push(...(result.value || []));
      next = result["@odata.nextLink"];
    }
    return items;
  }

  private async send(
    method: string,
    pathOrUrl: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
    if (!url.startsWith("https://graph.microsoft.com/")) {
      throw new TeamsGraphError(
        `Refusing to send the Graph token to ${new URL(url).host}`,
        "other",
      );
    }
    let refreshedAfter401 = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(false);
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (response.ok) return response;

      if (response.status === 401 && !refreshedAfter401 && this.deps.loadTokens().refreshToken) {
        refreshedAfter401 = true;
        await this.accessToken(true);
        continue;
      }
      if (
        (response.status === 429 || response.status === 503 || response.status === 504) &&
        attempt < MAX_RETRIES
      ) {
        await this.sleep(retryDelayMs(response, attempt));
        continue;
      }
      const errorBody = (await response.json().catch(() => ({}))) as GraphErrorBody;
      throw classify(response.status, errorBody);
    }
  }

  private async accessToken(force: boolean): Promise<string> {
    const tokens = this.deps.loadTokens();
    const fresh =
      tokens.accessToken &&
      (!tokens.tokenExpiresAt || tokens.tokenExpiresAt - REFRESH_SKEW_MS > Date.now());
    if (fresh && !force) return tokens.accessToken as string;
    if (!tokens.refreshToken || !tokens.clientId) {
      if (tokens.accessToken && !force) return tokens.accessToken;
      throw new TeamsGraphError(
        "Teams meeting capture is not connected. Connect it in Settings.",
        "auth_expired",
      );
    }
    try {
      const result = await this.refresh({
        clientId: tokens.clientId,
        refreshToken: tokens.refreshToken,
        tenant: tokens.tenant,
        scopes: tokens.scopes,
      });
      this.deps.saveTokens({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || tokens.refreshToken,
        tokenExpiresAt: Date.now() + (result.expiresIn ?? 3600) * 1000,
        scopes: result.scopes || tokens.scopes,
      });
      return result.accessToken;
    } catch (error) {
      throw new TeamsGraphError(
        `Could not refresh the Teams meeting token (${error instanceof Error ? error.message : String(error)}). Reconnect in Settings.`,
        "auth_expired",
      );
    }
  }
}
