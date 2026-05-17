import { describe, expect, it } from "vitest";

import {
  MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES,
  normalizeMicrosoftEmailReadScopes,
} from "../../../shared/microsoft-email";
import { buildMicrosoftEmailAuthorizeUrl } from "../microsoft-email-oauth";

describe("buildMicrosoftEmailAuthorizeUrl", () => {
  it("uses a single supported prompt value for Microsoft auth", () => {
    const authUrl = buildMicrosoftEmailAuthorizeUrl({
      tenant: "consumers",
      clientId: "client-id",
      redirectUri: "http://localhost:18767",
      scopes: MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES,
      state: "state-123",
      codeChallenge: "challenge-123",
      loginHint: "person@example.com",
    });

    expect(authUrl.origin).toBe("https://login.microsoftonline.com");
    expect(authUrl.pathname).toBe("/consumers/oauth2/v2.0/authorize");
    expect(authUrl.searchParams.get("prompt")).toBe("select_account");
    expect(authUrl.searchParams.get("scope")).toBe(MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES.join(" "));
    expect(authUrl.searchParams.get("scope")).not.toContain("Mail.Send");
    expect(authUrl.searchParams.get("login_hint")).toBe("person@example.com");
  });

  it("respects custom scopes without adding unsupported prompt combinations", () => {
    const authUrl = buildMicrosoftEmailAuthorizeUrl({
      tenant: "common",
      clientId: "client-id",
      redirectUri: "http://localhost:18767",
      scopes: ["offline_access", "https://outlook.office.com/IMAP.AccessAsUser.All"],
      state: "state-123",
      codeChallenge: "challenge-123",
    });

    expect(authUrl.searchParams.get("scope")).toBe(
      "offline_access https://outlook.office.com/IMAP.AccessAsUser.All",
    );
    expect(authUrl.searchParams.get("prompt")).toBe("select_account");
    expect(authUrl.searchParams.get("login_hint")).toBeNull();
  });

  it("can force consent when reauthenticating Microsoft email", () => {
    const authUrl = buildMicrosoftEmailAuthorizeUrl({
      tenant: "consumers",
      clientId: "client-id",
      redirectUri: "http://localhost:18767",
      scopes: MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES,
      state: "state-123",
      codeChallenge: "challenge-123",
      prompt: "consent",
    });

    expect(authUrl.searchParams.get("prompt")).toBe("consent");
  });
});

describe("normalizeMicrosoftEmailReadScopes", () => {
  it("drops legacy Mail.Send from read/sync scope requests", () => {
    expect(
      normalizeMicrosoftEmailReadScopes([
        "https://graph.microsoft.com/Mail.ReadWrite",
        "https://graph.microsoft.com/Mail.Send",
        "Mail.Send",
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "offline_access",
      ]),
    ).toEqual(MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES);
  });

  it("falls back to Graph read scopes when only legacy Outlook scopes are stored", () => {
    expect(
      normalizeMicrosoftEmailReadScopes([
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "https://outlook.office.com/SMTP.Send",
        "offline_access",
      ]),
    ).toEqual(MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES);
  });
});
