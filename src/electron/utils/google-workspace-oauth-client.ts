import type { GoogleWorkspaceSettingsData } from "../../shared/types";
import type { GoogleWorkspaceOAuthRequest } from "./google-workspace-oauth";

// Public OAuth client IDs are not secrets. Official builds should set this via
// COWORK_GOOGLE_OAUTH_CLIENT_ID or replace the fallback during release packaging.
const BUNDLED_GOOGLE_OAUTH_CLIENT_ID =
  "869694679579-q5pvm2817sl8abhjcrlbqg4jj4bl7n7f.apps.googleusercontent.com";

function normalize(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function getBundledGoogleWorkspaceOAuthClientId(): string | undefined {
  return (
    normalize(process.env.COWORK_GOOGLE_OAUTH_CLIENT_ID) ||
    normalize(BUNDLED_GOOGLE_OAUTH_CLIENT_ID)
  );
}

export function hasBundledGoogleWorkspaceOAuthClient(): boolean {
  return Boolean(getBundledGoogleWorkspaceOAuthClientId());
}

export function resolveGoogleWorkspaceOAuthRequest(
  request: GoogleWorkspaceOAuthRequest,
  settings?: GoogleWorkspaceSettingsData,
): GoogleWorkspaceOAuthRequest {
  const explicitClientId = normalize(request.clientId);
  const savedClientId = normalize(settings?.clientId);
  const bundledClientId = getBundledGoogleWorkspaceOAuthClientId();
  const clientId = explicitClientId || savedClientId || bundledClientId;

  if (!clientId) {
    return request;
  }

  const usingBundledClient = clientId === bundledClientId && !explicitClientId && !savedClientId;
  return {
    ...request,
    clientId,
    clientSecret: usingBundledClient ? undefined : (request.clientSecret ?? settings?.clientSecret),
  };
}
