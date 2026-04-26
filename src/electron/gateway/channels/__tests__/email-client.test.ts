import { describe, expect, it, vi } from "vitest";
import { EmailClient, type EmailMessage } from "../email-client";

const iso88599Overrides: Record<string, number> = {
  Ğ: 0xd0,
  İ: 0xdd,
  Ş: 0xde,
  ğ: 0xf0,
  ı: 0xfd,
  ş: 0xfe,
};

function encodeIso88599Text(value: string): string {
  const bytes = Array.from(value).map((char) => {
    const override = iso88599Overrides[char];
    if (override !== undefined) return override;
    const code = char.charCodeAt(0);
    if (code > 0xff) throw new Error(`Unsupported ISO-8859-9 test character: ${char}`);
    return code;
  });
  return Buffer.from(bytes).toString("latin1");
}

function parseEmailResponse(
  client: EmailClient,
  response: string,
  uid: number,
): EmailMessage | null {
  return getTestAccess(client).parseEmailResponse(response, uid);
}

type EmailClientTestAccess = EmailClient & {
  parseEmailResponse(response: string, uid: number): EmailMessage | null;
  connectImap(): Promise<void>;
  selectMailbox(): Promise<void>;
  disconnectImap(): Promise<void>;
  imapCommand(command: string): Promise<string>;
  fetchEmail(uid: number): Promise<EmailMessage | null>;
};

function getTestAccess(client: EmailClient): EmailClientTestAccess {
  return client as unknown as EmailClientTestAccess;
}

describe("EmailClient MIME parsing", () => {
  it("decodes multipart Outlook-style bodies without leaking MIME boundaries", () => {
    const boundary = "=-xwCuxuH0T6h099jGCleMzg=";
    const headerText =
      `From: Microsoft account team <account-security-noreply@accountprotection.microsoft.com>\r\n` +
      `To: user@msn.com\r\n` +
      `Subject: Microsoft hesabınıza yeni uygulamalar bağlandı\r\n` +
      `Date: Sun, 29 Mar 2026 22:02:00 +0000\r\n` +
      `Message-ID: <msg-1@example.com>\r\n` +
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
      `\r\n`;
    const bodyText =
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Transfer-Encoding: quoted-printable\r\n` +
      `\r\n` +
      `MSN Mail App, test=0AReview this sign-in.\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n`;
    const htmlBody = Buffer.from(
      "<p>MSN Mail App, test</p><p>Review this sign-in.</p>",
      "utf8",
    ).toString("base64");

    const response =
      `* 23 FETCH (FLAGS () BODY[HEADER] {${Buffer.byteLength(headerText)}}\r\n` +
      headerText +
      ` BODY[TEXT] {${Buffer.byteLength(bodyText + htmlBody + `\r\n--${boundary}--\r\n`)}}\r\n` +
      bodyText +
      `${htmlBody}\r\n` +
      `--${boundary}--\r\n` +
      `)\r\n`;

    const client = new EmailClient({
      imapHost: "imap-mail.outlook.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp-mail.outlook.com",
      smtpPort: 587,
      smtpSecure: false,
      email: "user@msn.com",
      password: "test-password",
      mailbox: "INBOX",
      pollInterval: 30000,
    });

    const email = parseEmailResponse(client, response, 23);

    expect(email).toBeTruthy();
    expect(email?.subject).toBe("Microsoft hesabınıza yeni uygulamalar bağlandı");
    expect(email?.from).toEqual({
      name: "Microsoft account team",
      address: "account-security-noreply@accountprotection.microsoft.com",
    });
    expect(email?.to).toEqual([{ address: "user@msn.com" }]);
    expect(email?.text).toBe("MSN Mail App, test\nReview this sign-in.");
    expect(email?.html).toContain("<p>MSN Mail App, test</p>");
    expect(email?.text).not.toContain(`--${boundary}`);
    expect(email?.text).not.toContain("Content-Transfer-Encoding");
  });

  it("does not truncate BODY[TEXT] when the message body contains asterisks", () => {
    const boundary = "=-xwCuxuH0T6h099jGCleMzg==";
    const bodyText =
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n` +
      `\r\n` +
      `MSN Mail App, user**@msn.com adlı Microsoft hesabına bağlandı.\r\n` +
      `\r\n` +
      `Bu erişim iznini siz vermediyseniz lütfen uygulamaları hesabınızdan kaldırın.\r\n` +
      `\r\n` +
      `--${boundary}--\r\n`;
    const headerText =
      `From: Microsoft hesap ekibi <account-security-noreply@accountprotection.microsoft.com>\r\n` +
      `To: <user@msn.com>\r\n` +
      `Subject: Microsoft hesabınıza yeni uygulamalar bağlandı\r\n` +
      `Date: Sun, 29 Mar 2026 22:02:00 +0000\r\n` +
      `Message-ID: <msg-2@example.com>\r\n` +
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
      `\r\n`;

    const response =
      `* 24 FETCH (FLAGS () BODY[HEADER] {${Buffer.byteLength(headerText)}}\r\n` +
      headerText +
      ` BODY[TEXT] {${Buffer.byteLength(bodyText)}}\r\n` +
      bodyText +
      ` UID 24)\r\nA4 OK FETCH completed.\r\n`;

    const client = new EmailClient({
      imapHost: "imap-mail.outlook.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp-mail.outlook.com",
      smtpPort: 587,
      smtpSecure: false,
      email: "user@msn.com",
      password: "test-password",
      mailbox: "INBOX",
      pollInterval: 30000,
    });

    const email = parseEmailResponse(client, response, 24);

    expect(email?.text).toContain("user**@msn.com");
    expect(email?.text).toContain("Bu erişim iznini siz vermediyseniz");
  });

  it("repairs utf-8 mojibake for MSN subjects and plain-text bodies", () => {
    const headerText =
      `From: OLX <noreply@olx.pt>\r\n` +
      `To: <user@msn.com>\r\n` +
      `Subject: =?ISO-8859-1?Q?Altera=C3=A7=C3=B5es_aos_Termos_e_Condi=C3=A7=C3=B5es?=\r\n` +
      `Date: Sun, 29 Mar 2026 22:02:00 +0000\r\n` +
      `Message-ID: <msg-3@example.com>\r\n` +
      `Content-Type: text/plain; charset=iso-8859-1\r\n` +
      `Content-Transfer-Encoding: quoted-printable\r\n` +
      `\r\n`;
    const bodyText =
      `Altera=C3=A7=C3=B5es aos Termos e Condi=C3=A7=C3=B5es=0D=0A` +
      `Os termos atualizados entram em vigor para os utilizadores existentes na OLX.\r\n`;

    const response =
      `* 25 FETCH (FLAGS () BODY[HEADER] {${Buffer.byteLength(headerText)}}\r\n` +
      headerText +
      ` BODY[TEXT] {${Buffer.byteLength(bodyText)}}\r\n` +
      bodyText +
      ` UID 25)\r\nA5 OK FETCH completed.\r\n`;

    const client = new EmailClient({
      imapHost: "imap-mail.outlook.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp-mail.outlook.com",
      smtpPort: 587,
      smtpSecure: false,
      email: "user@msn.com",
      password: "test-password",
      mailbox: "INBOX",
      pollInterval: 30000,
    });

    const email = parseEmailResponse(client, response, 25);

    expect(email?.subject).toBe("Alterações aos Termos e Condições");
    expect(email?.text).toContain("Alterações aos Termos e Condições");
    expect(email?.text).toContain("utilizadores existentes na OLX");
    expect(email?.text).not.toContain("Ã");
  });

  it("preserves non-UTF8 IMAP literals until charset-aware body decoding", () => {
    const encodedSubject = Buffer.from(
      "E-Postanızın Güncelliğini Doğrulayınız",
      "utf8",
    ).toString("base64");
    const headerText =
      `From: Garanti BBVA <no-reply@example.com>\r\n` +
      `To: <user@msn.com>\r\n` +
      `Subject: =?UTF-8?B?${encodedSubject}?=\r\n` +
      `Date: Sun, 29 Mar 2026 22:02:00 +0000\r\n` +
      `Message-ID: <msg-4@example.com>\r\n` +
      `Content-Type: text/html; charset=iso-8859-9\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n` +
      `\r\n`;
    const html = `<h1>E-Postanızın Güncelliğini Doğrulayınız</h1><p>güvenliğiniz için lütfen doğrulayınız.</p>`;
    const bodyText = encodeIso88599Text(html);

    const response =
      `* 26 FETCH (FLAGS () BODY[HEADER] {${Buffer.byteLength(headerText)}}\r\n` +
      headerText +
      ` BODY[TEXT] {${Buffer.byteLength(bodyText, "latin1")}}\r\n` +
      bodyText +
      ` UID 26)\r\nA6 OK FETCH completed.\r\n`;

    const client = new EmailClient({
      imapHost: "imap-mail.outlook.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp-mail.outlook.com",
      smtpPort: 587,
      smtpSecure: false,
      email: "user@msn.com",
      password: "test-password",
      mailbox: "INBOX",
      pollInterval: 30000,
    });

    const email = parseEmailResponse(client, response, 26);

    expect(email?.html).toContain("E-Postanızın Güncelliğini Doğrulayınız");
    expect(email?.text).toContain("güvenliğiniz için lütfen doğrulayınız");
    expect(email?.text).not.toContain("�");
  });

  it("falls back to Turkish single-byte decoding when a body is mislabeled as utf-8", () => {
    const headerText =
      `From: Garanti BBVA <no-reply@example.com>\r\n` +
      `To: <user@msn.com>\r\n` +
      `Subject: E-Postanızın Güncelliğini Doğrulayınız\r\n` +
      `Date: Sun, 29 Mar 2026 22:02:00 +0000\r\n` +
      `Message-ID: <msg-5@example.com>\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Transfer-Encoding: quoted-printable\r\n` +
      `\r\n`;
    const bodyText =
      `E-Postan=FDz=FDn g=FCncelleme do=F0rulamas=FD\r\n` +
      `G=FCvenli=F0iniz i=E7in l=FCtfen do=F0rulay=FDn=FDz.\r\n`;

    const response =
      `* 27 FETCH (FLAGS () BODY[HEADER] {${Buffer.byteLength(headerText)}}\r\n` +
      headerText +
      ` BODY[TEXT] {${Buffer.byteLength(bodyText)}}\r\n` +
      bodyText +
      ` UID 27)\r\nA7 OK FETCH completed.\r\n`;

    const client = new EmailClient({
      imapHost: "imap-mail.outlook.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp-mail.outlook.com",
      smtpPort: 587,
      smtpSecure: false,
      email: "user@msn.com",
      password: "test-password",
      mailbox: "INBOX",
      pollInterval: 30000,
    });

    const email = parseEmailResponse(client, response, 27);

    expect(email?.text).toContain("E-Postanızın güncelleme doğrulaması");
    expect(email?.text).toContain("Güvenliğiniz için lütfen doğrulayınız");
    expect(email?.text).not.toContain("�");
  });

  it("fetches recent emails from all UIDs instead of unread-only search", async () => {
    const client = new EmailClient({
      imapHost: "imap-mail.outlook.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp-mail.outlook.com",
      smtpPort: 587,
      smtpSecure: false,
      email: "user@msn.com",
      password: "test-password",
      mailbox: "INBOX",
      pollInterval: 30000,
    });

    const clientAccess = getTestAccess(client);
    const connectSpy = vi.spyOn(clientAccess, "connectImap").mockResolvedValue(undefined);
    const selectSpy = vi.spyOn(clientAccess, "selectMailbox").mockResolvedValue(undefined);
    const disconnectSpy = vi.spyOn(clientAccess, "disconnectImap").mockResolvedValue(undefined);
    const commandSpy = vi
      .spyOn(clientAccess, "imapCommand")
      .mockResolvedValue("* SEARCH 11 12 13 14\r\nA1 OK SEARCH completed.\r\n");
    const fetchSpy = vi.spyOn(clientAccess, "fetchEmail").mockImplementation(async (uid: number) => ({
      uid,
      messageId: `msg-${uid}`,
      from: { address: "sender@example.com" },
      to: [{ address: "user@msn.com" }],
      subject: `Message ${uid}`,
      text: `Body ${uid}`,
      date: new Date("2026-03-29T22:00:00Z"),
      isRead: uid !== 14,
      headers: new Map(),
    }));

    const messages = await client.fetchRecentEmails(3);

    expect(connectSpy).toHaveBeenCalled();
    expect(selectSpy).toHaveBeenCalled();
    expect(commandSpy).toHaveBeenCalledWith("UID SEARCH ALL");
    expect(fetchSpy).toHaveBeenNthCalledWith(1, 14);
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 13);
    expect(fetchSpy).toHaveBeenNthCalledWith(3, 12);
    expect(disconnectSpy).toHaveBeenCalled();
    expect(messages.map((message) => message.uid)).toEqual([14, 13, 12]);
  });
});
