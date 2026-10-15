/**
 * The Remote (OAuth) server form in MCP settings, shared by Add and Edit.
 * Stored secrets never reach the renderer: an edit starts with empty secret
 * fields, and a blank secret keeps the saved value.
 */
import type { RemoteOAuthServerRequest } from "../../shared/types";

export interface RemoteOAuthForm {
  kind: "workday" | "custom";
  name: string;
  region: string;
  tenant: string;
  url: string;
  authorizationUrl: string;
  tokenUrl: string;
  grant: "authorization_code" | "jwt_bearer";
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  jwtSubject: string;
  privateKey: string;
}

/** Which secrets the edited server already has stored (shown only as masks). */
export interface StoredRemoteSecrets {
  clientSecret: boolean;
  privateKey: boolean;
}

/** The settings display shape of a Remote (OAuth) server; secrets arrive masked. */
export interface RemoteOAuthServerDisplay {
  name: string;
  url?: string;
  auth?: {
    clientId?: string;
    clientSecret?: string;
    privateKey?: string;
    tokenUrl?: string;
    oauth?: {
      grant: "authorization_code" | "jwt_bearer";
      authorizationUrl?: string;
      redirectUri?: string;
      scopes?: string[];
      jwt?: { subject?: string };
      preset?: { kind: "workday"; region?: string; tenant?: string };
    };
  };
}

export const EMPTY_REMOTE_OAUTH_FORM: RemoteOAuthForm = {
  kind: "workday",
  name: "Workday",
  region: "us",
  tenant: "",
  url: "",
  authorizationUrl: "",
  tokenUrl: "",
  grant: "authorization_code",
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  scopes: "",
  jwtSubject: "",
  privateKey: "",
};

/** Prefills the form from a saved server. Secret fields stay empty. */
export function remoteOAuthFormFromServer(server: RemoteOAuthServerDisplay): {
  form: RemoteOAuthForm;
  stored: StoredRemoteSecrets;
} {
  const auth = server.auth;
  const oauth = auth?.oauth;
  const preset = oauth?.preset?.kind === "workday" ? oauth.preset : undefined;
  return {
    form: {
      kind: preset ? "workday" : "custom",
      name: server.name,
      region: preset?.region ?? "",
      tenant: preset?.tenant ?? "",
      url: preset ? "" : (server.url ?? ""),
      authorizationUrl: preset ? "" : (oauth?.authorizationUrl ?? ""),
      tokenUrl: preset ? "" : (auth?.tokenUrl ?? ""),
      grant: oauth?.grant ?? "authorization_code",
      clientId: auth?.clientId ?? "",
      clientSecret: "",
      redirectUri: oauth?.redirectUri ?? "",
      scopes: oauth?.scopes?.join(" ") ?? "",
      jwtSubject: oauth?.jwt?.subject ?? "",
      privateKey: "",
    },
    stored: { clientSecret: Boolean(auth?.clientSecret), privateKey: Boolean(auth?.privateKey) },
  };
}

/** The form can be submitted; an edit may leave a stored private key blank. */
export function remoteOAuthFormReady(
  form: RemoteOAuthForm,
  stored: StoredRemoteSecrets = { clientSecret: false, privateKey: false },
): boolean {
  return (
    Boolean(form.name.trim() && form.clientId.trim()) &&
    (form.kind === "workday"
      ? Boolean(form.region.trim() && form.tenant.trim())
      : Boolean(form.url.trim() && form.tokenUrl.trim()) &&
        (form.grant === "jwt_bearer" || Boolean(form.authorizationUrl.trim()))) &&
    (form.grant === "authorization_code" ||
      Boolean(form.jwtSubject.trim() && (form.privateKey.trim() || stored.privateKey)))
  );
}

/** The request main validates. Blank secrets are left out, so an edit keeps them. */
export function remoteOAuthRequest(form: RemoteOAuthForm): RemoteOAuthServerRequest {
  const optional = (value: string) => (value.trim() ? value.trim() : undefined);
  return {
    name: form.name.trim(),
    kind: form.kind,
    ...(form.kind === "workday"
      ? { region: form.region.trim(), tenant: form.tenant.trim() }
      : {
          url: form.url.trim(),
          tokenUrl: form.tokenUrl.trim(),
          authorizationUrl: optional(form.authorizationUrl),
        }),
    grant: form.grant,
    clientId: form.clientId.trim(),
    clientSecret: optional(form.clientSecret),
    redirectUri: optional(form.redirectUri),
    scopes: form.scopes.trim() ? form.scopes.trim().split(/\s+/) : undefined,
    ...(form.grant === "jwt_bearer"
      ? {
          jwtSubject: form.jwtSubject.trim(),
          ...(form.privateKey.trim() ? { privateKey: form.privateKey } : {}),
        }
      : {}),
  };
}
