export const MICROSOFT_CONSUMER_IMAP_UNSUPPORTED_MESSAGE =
  "Outlook.com, Hotmail, Live, and MSN accounts require OAuth2/Modern Auth. Use the Outlook.com provider and connect with Microsoft OAuth instead of a password. Before connecting, create a Microsoft Entra app registration for personal Microsoft accounts, add the Mobile and desktop redirect URI http://localhost, and grant delegated Microsoft Graph Mail.ReadWrite permission.";

function normalizeEmailDomain(email: string | undefined): string | null {
  if (!email) return null;
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return null;
  const domain = email
    .slice(atIndex + 1)
    .trim()
    .toLowerCase();
  return domain || null;
}

export function isMicrosoftConsumerEmailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return (
    domain === "msn.com" ||
    domain === "passport.com" ||
    domain === "outlook.com" ||
    domain === "hotmail.com" ||
    domain === "live.com" ||
    domain.startsWith("outlook.") ||
    domain.startsWith("hotmail.") ||
    domain.startsWith("live.")
  );
}

export function isMicrosoftConsumerEmailAddress(email: string | undefined): boolean {
  return isMicrosoftConsumerEmailDomain(normalizeEmailDomain(email));
}

export function getUnsupportedManualEmailSetupMessage(config: {
  email?: string;
  imapHost?: string;
  smtpHost?: string;
}): string | null {
  if (isMicrosoftConsumerEmailAddress(config.email)) {
    return MICROSOFT_CONSUMER_IMAP_UNSUPPORTED_MESSAGE;
  }

  return null;
}
