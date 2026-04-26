/**
 * Email Client (IMAP/SMTP)
 *
 * Email client using IMAP for receiving and SMTP for sending.
 * Provides a unified interface for email communication.
 *
 * Features:
 * - Real-time email receiving via IMAP IDLE
 * - Email sending via SMTP
 * - HTML and plain text support
 * - Attachment support
 * - Reply threading
 *
 * Requirements:
 * - IMAP server credentials
 * - SMTP server credentials
 * - Usually both use the same email/password
 *
 * Common Providers:
 * - Gmail: imap.gmail.com:993, smtp.gmail.com:587 (use App Password)
 * - Outlook: outlook.office365.com:993, smtp.office365.com:587
 * - Yahoo: imap.mail.yahoo.com:993, smtp.mail.yahoo.com:465
 */

import { EventEmitter } from "events";
import * as tls from "tls";
import * as net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

/**
 * Load CA certificates from the macOS system keychain so that TLS connections
 * trust locally-installed CAs (e.g. corporate proxies, antivirus TLS inspection).
 * Combined with Node's built-in root certificates for full coverage.
 */
let _cachedSystemCA: string[] | undefined;

function readKeychainCerts(keychains: string[]): string[] {
  const existing = keychains.filter((k) => fs.existsSync(k));
  if (existing.length === 0) return [];
  try {
    const pem = execFileSync("security", ["find-certificate", "-a", "-p", ...existing], {
      encoding: "utf-8",
      timeout: 8000,
    });
    return pem
      .split(/(?=-----BEGIN CERTIFICATE-----)/)
      .filter((c) => c.includes("BEGIN CERTIFICATE"));
  } catch {
    return [];
  }
}

function getSystemCA(): string[] {
  if (_cachedSystemCA) return _cachedSystemCA;

  // System keychains (always present on macOS).
  const systemKeychains = [
    "/Library/Keychains/System.keychain",
    "/System/Library/Keychains/SystemRootCertificates.keychain",
  ];

  // User keychains (some enterprise tools install trusted roots here).
  const home = os.homedir();
  const userKeychains = [
    path.join(home, "Library", "Keychains", "login.keychain-db"),
    path.join(home, "Library", "Keychains", "login.keychain"),
  ];

  const certs = [...readKeychainCerts(systemKeychains), ...readKeychainCerts(userKeychains)];

  _cachedSystemCA = [...tls.rootCertificates, ...certs];
  return _cachedSystemCA;
}

type DecodedMimeEntity = {
  plainText?: string;
  html?: string;
};

function normalizeMimeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Strip CR and LF from a value before it is placed in an RFC 2822 header field. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

function parseHeaderBlock(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  const normalized = normalizeMimeLineEndings(headerText);
  const headerLines = normalized.split(/\n(?=[^\s])/);

  for (const line of headerLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.substring(0, colonIndex).trim().toLowerCase();
    const value = line
      .substring(colonIndex + 1)
      .replace(/\n\s+/g, " ")
      .trim();
    headers.set(key, value);
  }

  return headers;
}

function unquoteMimeParam(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseContentTypeHeader(header: string | undefined): {
  mimeType: string;
  boundary?: string;
  charset?: string;
} {
  const normalized = header?.trim() || "text/plain";
  const [rawMimeType, ...params] = normalized.split(";");
  const mimeType = rawMimeType.trim().toLowerCase() || "text/plain";
  const result: { mimeType: string; boundary?: string; charset?: string } = { mimeType };

  for (const param of params) {
    const equalsIndex = param.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = param.substring(0, equalsIndex).trim().toLowerCase();
    const value = unquoteMimeParam(param.substring(equalsIndex + 1));
    if (key === "boundary" && value) result.boundary = value;
    if (key === "charset" && value) result.charset = value.toLowerCase();
  }

  return result;
}

function splitMultipartBody(body: string, boundary: string): string[] {
  const normalized = normalizeMimeLineEndings(body);
  const delimiter = `--${boundary}`;
  const closingDelimiter = `--${boundary}--`;
  const parts: string[] = [];
  let current: string[] | null = null;

  for (const line of normalized.split("\n")) {
    if (line === delimiter) {
      if (current) {
        const part = current.join("\n").trim();
        if (part) parts.push(part);
      }
      current = [];
      continue;
    }

    if (line === closingDelimiter) {
      if (current) {
        const part = current.join("\n").trim();
        if (part) parts.push(part);
      }
      break;
    }

    if (current) {
      current.push(line);
    }
  }

  // Flush any trailing part if the closing delimiter was absent (malformed body)
  if (current) {
    const part = current.join("\n").trim();
    if (part) parts.push(part);
  }

  return parts;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeQuotedPrintable(text: string): Buffer {
  const normalized = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "=" && /^[0-9A-F]{2}$/i.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(normalized.charCodeAt(index));
  }

  return Buffer.from(bytes);
}

function countUtf8MojibakeHints(text: string): number {
  const matches = text.match(/(?:Ã.|Â.|â.|ð.)/g);
  return matches?.length || 0;
}

function repairUtf8Mojibake(text: string): string {
  const hintCount = countUtf8MojibakeHints(text);
  if (!text || hintCount === 0) return text;

  try {
    const repaired = Buffer.from(text, "latin1").toString("utf8");
    if (!repaired || repaired.includes("\uFFFD")) {
      return text;
    }

    return countUtf8MojibakeHints(repaired) < hintCount ? repaired : text;
  } catch {
    return text;
  }
}

function countReplacementCharacters(text: string): number {
  return (text.match(/\uFFFD/g) || []).length;
}

function decodeWithTextDecoder(buffer: Buffer, charset: string): string | null {
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return null;
  }
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function decodeLegacyFallback(
  buffer: Buffer,
  previousText: string,
  options?: { requireInvalidUtf8?: boolean },
): string {
  if (options?.requireInvalidUtf8 && isValidUtf8(buffer)) return previousText;

  const previousReplacementCount = countReplacementCharacters(previousText);
  if (previousReplacementCount === 0) return previousText;

  const candidates = ["windows-1254", "iso-8859-9", "windows-1252", "iso-8859-1"];
  let best = previousText;
  let bestScore =
    previousReplacementCount * 10 +
    countUtf8MojibakeHints(previousText) * 2;

  for (const charset of candidates) {
    const decoded = decodeWithTextDecoder(buffer, charset);
    if (!decoded) continue;

    const repaired = repairUtf8Mojibake(decoded);
    const score =
      countReplacementCharacters(repaired) * 10 +
      countUtf8MojibakeHints(repaired) * 2;
    if (score < bestScore) {
      best = repaired;
      bestScore = score;
    }
  }

  return best;
}

function decodeMimeBuffer(buffer: Buffer, charset?: string): string {
  const normalizedCharset = (charset || "utf-8").toLowerCase().replace(/^x-/, "");

  if (normalizedCharset === "utf-8" || normalizedCharset === "utf8") {
    const decoded = repairUtf8Mojibake(buffer.toString("utf8"));
    return decodeLegacyFallback(buffer, decoded, { requireInvalidUtf8: true });
  }

  if (
    normalizedCharset === "us-ascii" ||
    normalizedCharset === "ascii" ||
    normalizedCharset === "iso-8859-1" ||
    normalizedCharset === "latin1" ||
    normalizedCharset === "windows-1252" ||
    normalizedCharset === "cp1252"
  ) {
    const decoded = repairUtf8Mojibake(buffer.toString("latin1"));
    return decodeLegacyFallback(buffer, decoded);
  }

  // Use TextDecoder for all other charsets (ISO-8859-9/Turkish, Windows-1254,
  // ISO-8859-2 through ISO-8859-16, CJK encodings, etc.)
  try {
    const decoder = new TextDecoder(normalizedCharset);
    return decoder.decode(buffer);
  } catch {
    // Charset not recognised by TextDecoder — fall back to UTF-8, then Latin-1
    try {
      return repairUtf8Mojibake(buffer.toString("utf8"));
    } catch {
      return repairUtf8Mojibake(buffer.toString("latin1"));
    }
  }
}

function extractImapLiteral(response: string, section: "HEADER" | "TEXT"): string {
  const marker = `BODY[${section}]`;
  const startIndex = response.indexOf(marker);
  if (startIndex === -1) return "";

  const literalMatch = response.slice(startIndex).match(/^BODY\[(?:HEADER|TEXT)\]\s*\{(\d+)\}\r\n/i);
  if (!literalMatch) return "";

  const literalLength = Number.parseInt(literalMatch[1] || "0", 10);
  if (!Number.isFinite(literalLength) || literalLength < 0) return "";

  const literalStart = startIndex + literalMatch[0].length;
  const responseEncoding: BufferEncoding = /[^\u0000-\u00ff]/.test(response) ? "utf8" : "latin1";
  const byteStart = Buffer.byteLength(response.slice(0, literalStart), responseEncoding);
  const buffer = Buffer.from(response, responseEncoding);
  const literal = buffer.subarray(byteStart, byteStart + literalLength);

  // Headers are mostly ASCII plus RFC 2047 encoded words, and parsing them as
  // UTF-8 keeps existing non-encoded UTF-8 headers readable. Body literals must
  // stay byte-preserving until part-level charset decoding runs.
  return literal.toString(section === "HEADER" ? "utf8" : "latin1");
}

/**
 * Email message
 */
export interface EmailMessage {
  /** Message ID (unique identifier from headers) */
  messageId: string;
  /** UID (IMAP sequence number) */
  uid: number;
  /** From address */
  from: EmailAddress;
  /** To addresses */
  to: EmailAddress[];
  /** CC addresses */
  cc?: EmailAddress[];
  /** Subject */
  subject: string;
  /** Plain text body */
  text?: string;
  /** HTML body */
  html?: string;
  /** Date received */
  date: Date;
  /** In-Reply-To header */
  inReplyTo?: string;
  /** References header (thread) */
  references?: string[];
  /** Attachments */
  attachments?: EmailAttachment[];
  /** Is read */
  isRead: boolean;
  /** Raw headers */
  headers: Map<string, string>;
}

/**
 * Email address
 */
export interface EmailAddress {
  name?: string;
  address: string;
}

/**
 * Email attachment
 */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content?: Buffer;
}

/**
 * Email client options
 */
export interface EmailClientOptions {
  /** Authentication mode */
  authMethod?: "password" | "oauth";
  /** OAuth access token */
  accessToken?: string;
  /** Runtime token provider for OAuth refresh */
  oauthAccessTokenProvider?: () => Promise<string>;
  /** IMAP host */
  imapHost: string;
  /** IMAP port */
  imapPort: number;
  /** IMAP use TLS */
  imapSecure: boolean;
  /** SMTP host */
  smtpHost: string;
  /** SMTP port */
  smtpPort: number;
  /** SMTP use TLS */
  smtpSecure: boolean;
  /** Email address */
  email: string;
  /** Password */
  password?: string;
  /** Display name */
  displayName?: string;
  /** Mailbox to monitor */
  mailbox: string;
  /** Poll interval (fallback) */
  pollInterval: number;
  /** Verbose logging */
  verbose?: boolean;
}

/**
 * IMAP/SMTP Email Client
 *
 * Note: This is a simplified implementation. For production use,
 * consider using libraries like 'imap' and 'nodemailer'.
 */
export class EmailClient extends EventEmitter {
  private options: EmailClientOptions;
  private imapSocket?: tls.TLSSocket | net.Socket;
  private connected = false;
  private pollTimer?: NodeJS.Timeout;
  private lastSeenUid = 0;
  private commandTag = 0;
  // For this simplified IMAP client we allow one in-flight command at a time.
  // currentCallback returns true when the buffered response is complete.
  private currentCallback?: (buffer: string) => boolean;
  private responseBuffer = "";

  constructor(options: EmailClientOptions) {
    super();
    this.options = {
      ...options,
      authMethod: options.authMethod ?? "password",
    };
  }

  private async resolveAccessToken(): Promise<string> {
    if (this.options.oauthAccessTokenProvider) {
      const accessToken = await this.options.oauthAccessTokenProvider();
      this.options.accessToken = accessToken;
      return accessToken;
    }
    if (this.options.accessToken) {
      return this.options.accessToken;
    }
    throw new Error("OAuth access token is required");
  }

  private async getImapAuthCommand(): Promise<string> {
    if (this.options.authMethod === "oauth") {
      const accessToken = await this.resolveAccessToken();
      const xoauth2 = Buffer.from(
        `user=${this.options.email}\x01auth=Bearer ${accessToken}\x01\x01`,
        "utf8",
      ).toString("base64");
      return `AUTHENTICATE XOAUTH2 ${xoauth2}`;
    }

    return `LOGIN "${this.options.email}" "${this.options.password}"`;
  }

  private async getSmtpAuthCommand(): Promise<string> {
    if (this.options.authMethod === "oauth") {
      const accessToken = await this.resolveAccessToken();
      const xoauth2 = Buffer.from(
        `user=${this.options.email}\x01auth=Bearer ${accessToken}\x01\x01`,
        "utf8",
      ).toString("base64");
      return `AUTH XOAUTH2 ${xoauth2}\r\n`;
    }

    return `AUTH PLAIN ${Buffer.from(`\0${this.options.email}\0${this.options.password}`).toString("base64")}\r\n`;
  }

  /**
   * Check IMAP connection
   */
  async checkConnection(): Promise<{ success: boolean; email?: string; error?: string }> {
    try {
      await this.connectImap();
      await this.disconnectImap();
      return { success: true, email: this.options.email };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Start receiving emails
   */
  async startReceiving(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.connectImap();
      await this.selectMailbox();
      this.connected = true;
      this.emit("connected");

      // Start polling (IDLE requires more complex handling)
      this.startPolling();
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Connect to IMAP server
   */
  private async connectImap(): Promise<void> {
    return new Promise((resolve, reject) => {
      const connect = () => {
        if (this.options.imapSecure) {
          const servername = net.isIP(this.options.imapHost) ? undefined : this.options.imapHost;
          this.imapSocket = tls.connect({
            host: this.options.imapHost,
            port: this.options.imapPort,
            servername,
            ca: getSystemCA(),
            rejectUnauthorized: true,
          });
        } else {
          this.imapSocket = net.connect({
            host: this.options.imapHost,
            port: this.options.imapPort,
          });
        }

        const timeout = setTimeout(() => {
          reject(new Error("IMAP connection timeout"));
        }, 30000);

        this.imapSocket.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        this.imapSocket.on("data", (data) => {
          // Preserve raw IMAP literal bytes. MIME part charsets are decoded
          // after BODY literals are extracted.
          this.handleImapData(data.toString("latin1"));
        });

        this.imapSocket.once("connect", async () => {
          try {
            // Wait for server greeting
            await this.waitForResponse("OK");

            // Login
            const authCommand = await this.getImapAuthCommand();
            await this.imapCommand(authCommand);
            clearTimeout(timeout);
            resolve();
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        });

        if (!this.options.imapSecure) {
          (this.imapSocket as net.Socket).once("connect", () => {
            this.imapSocket!.emit("connect");
          });
        }
      };

      connect();
    });
  }

  /**
   * Handle IMAP data
   */
  private handleImapData(data: string): void {
    this.responseBuffer += data;

    if (!this.currentCallback) return;

    const done = this.currentCallback(this.responseBuffer);
    if (done) {
      this.responseBuffer = "";
      this.currentCallback = undefined;
    }
  }

  /**
   * Wait for server response
   */
  private async waitForResponse(expectedType: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.currentCallback = undefined;
        this.responseBuffer = "";
        reject(new Error("IMAP response timeout"));
      }, 10000);

      const cb = (buffer: string): boolean => {
        if (buffer.includes(expectedType)) {
          clearTimeout(timeout);
          resolve(buffer);
          return true;
        }
        if (buffer.includes("NO") || buffer.includes("BAD")) {
          clearTimeout(timeout);
          reject(new Error(`IMAP error: ${buffer}`));
          return true;
        }
        return false;
      };

      this.currentCallback = cb;

      // Handle the case where the server greeting arrives before we start waiting.
      if (this.responseBuffer) {
        const done = cb(this.responseBuffer);
        if (done) {
          this.responseBuffer = "";
          this.currentCallback = undefined;
        }
      }
    });
  }

  /**
   * Send IMAP command
   */
  private async imapCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.imapSocket) {
        reject(new Error("Not connected"));
        return;
      }

      const tag = `A${++this.commandTag}`;
      const fullCommand = `${tag} ${command}\r\n`;

      const timeout = setTimeout(() => {
        this.currentCallback = undefined;
        this.responseBuffer = "";
        reject(new Error("IMAP command timeout"));
      }, 30000);

      // Clear any leftover buffered data before issuing a new command.
      this.responseBuffer = "";

      this.currentCallback = (buffer: string): boolean => {
        if (buffer.includes(`${tag} OK`)) {
          clearTimeout(timeout);
          resolve(buffer);
          return true;
        }
        if (buffer.includes(`${tag} NO`) || buffer.includes(`${tag} BAD`)) {
          clearTimeout(timeout);
          reject(new Error(`IMAP error: ${buffer}`));
          return true;
        }
        return false;
      };

      this.imapSocket.write(fullCommand);
    });
  }

  /**
   * Select mailbox
   */
  private async selectMailbox(): Promise<void> {
    const response = await this.imapCommand(`SELECT "${this.options.mailbox}"`);
    // Parse UIDNEXT from response to get last UID
    const uidMatch = response.match(/UIDNEXT\s+(\d+)/i);
    if (uidMatch) {
      this.lastSeenUid = parseInt(uidMatch[1], 10) - 1;
    }
  }

  /**
   * Start polling for new emails
   */
  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        await this.checkNewEmails();
      } catch (error) {
        if (this.options.verbose) {
          console.error("Email poll error:", error);
        }
      }
    }, this.options.pollInterval);
  }

  /**
   * Check for new emails
   */
  private async checkNewEmails(): Promise<void> {
    try {
      // Search for new emails
      const response = await this.imapCommand(`UID SEARCH UID ${this.lastSeenUid + 1}:*`);
      const uidMatch = response.match(/SEARCH\s+([\d\s]+)/i);

      if (uidMatch) {
        const uids = uidMatch[1]
          .trim()
          .split(/\s+/)
          .filter((u) => u)
          .map((u) => parseInt(u, 10))
          .filter((u) => u > this.lastSeenUid);

        for (const uid of uids) {
          try {
            const email = await this.fetchEmail(uid);
            if (email) {
              this.emit("message", email);
              this.lastSeenUid = Math.max(this.lastSeenUid, uid);
            }
          } catch (error) {
            if (this.options.verbose) {
              console.error(`Error fetching email ${uid}:`, error);
            }
          }
        }
      }
    } catch  {
      // Reconnect if needed
      if (!this.imapSocket || this.imapSocket.destroyed) {
        try {
          await this.connectImap();
          await this.selectMailbox();
        } catch {
          // Will retry on next poll
        }
      }
    }
  }

  /**
   * Fetch email by UID
   */
  private async fetchEmail(uid: number): Promise<EmailMessage | null> {
    try {
      const response = await this.imapCommand(
        // Use BODY.PEEK so reading does not implicitly set \\Seen.
        // Mark-as-read is handled explicitly (see EmailAdapter + markAsRead config).
        `UID FETCH ${uid} (FLAGS BODY.PEEK[HEADER] BODY.PEEK[TEXT])`,
      );

      // Parse email from response (simplified)
      const email = this.parseEmailResponse(response, uid);
      return email;
    } catch (error) {
      if (this.options.verbose) {
        console.error(`Error fetching email ${uid}:`, error);
      }
      return null;
    }
  }

  /**
   * Fetch unread emails from the mailbox without modifying read state.
   * Intended for inbox summarization and diagnostics (not the gateway ingestion loop).
   */
  async fetchUnreadEmails(limit: number): Promise<EmailMessage[]> {
    const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 50);

    await this.connectImap();
    try {
      await this.selectMailbox();

      const response = await this.imapCommand("UID SEARCH UNSEEN");
      const uidMatch = response.match(/SEARCH\s+([\d\s]+)/i);
      const uids = uidMatch
        ? uidMatch[1]
            .trim()
            .split(/\s+/)
            .filter((u) => u)
            .map((u) => parseInt(u, 10))
            .filter((u) => Number.isFinite(u))
        : [];

      if (uids.length === 0) return [];

      // Return newest-first (best-effort; UIDs generally increase over time).
      const selected = uids.slice(-safeLimit).reverse();

      const emails: EmailMessage[] = [];
      for (const uid of selected) {
        const email = await this.fetchEmail(uid);
        if (email) emails.push(email);
      }
      return emails;
    } finally {
      await this.disconnectImap();
    }
  }

  async fetchRecentEmails(limit: number): Promise<EmailMessage[]> {
    const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 50);

    await this.connectImap();
    try {
      await this.selectMailbox();

      const response = await this.imapCommand("UID SEARCH ALL");
      const uidMatch = response.match(/SEARCH\s+([\d\s]+)/i);
      const uids = uidMatch
        ? uidMatch[1]
            .trim()
            .split(/\s+/)
            .filter((u) => u)
            .map((u) => parseInt(u, 10))
            .filter((u) => Number.isFinite(u))
        : [];

      if (uids.length === 0) return [];

      const selected = uids.slice(-safeLimit).reverse();

      const emails: EmailMessage[] = [];
      for (const uid of selected) {
        const email = await this.fetchEmail(uid);
        if (email) emails.push(email);
      }
      return emails;
    } finally {
      await this.disconnectImap();
    }
  }

  /**
   * Parse email from IMAP response (simplified)
   */
  private parseEmailResponse(response: string, uid: number): EmailMessage | null {
    let headers = new Map<string, string>();

    // Extract headers
    const headerLiteral = extractImapLiteral(response, "HEADER");
    if (headerLiteral) {
      headers = parseHeaderBlock(headerLiteral);
    }

    // Extract raw MIME body.
    const rawBody = extractImapLiteral(response, "TEXT").trim();
    const decodedBody = this.decodeMimeBody(
      rawBody,
      headers.get("content-type"),
      headers.get("content-transfer-encoding"),
    );

    // Parse From address
    const fromHeader = this.decodeHeader(headers.get("from") || "");
    const from = this.parseEmailAddress(fromHeader);

    // Parse To addresses
    const toHeader = this.decodeHeader(headers.get("to") || "");
    const to = this.parseEmailAddresses(toHeader);

    // Parse Message-ID
    const messageId = headers.get("message-id") || `${uid}@${this.options.imapHost}`;

    // Parse Date
    const dateHeader = headers.get("date") || "";
    const date = dateHeader ? new Date(dateHeader) : new Date();

    // Check if read
    const isRead = response.toLowerCase().includes("\\seen");

    return {
      messageId: messageId.replace(/[<>]/g, ""),
      uid,
      from,
      to,
      subject: this.decodeHeader(headers.get("subject") || "(No Subject)"),
      text: decodedBody.plainText || (decodedBody.html ? stripHtml(decodedBody.html) : ""),
      html: decodedBody.html,
      date,
      inReplyTo: headers.get("in-reply-to")?.replace(/[<>]/g, ""),
      references: headers
        .get("references")
        ?.split(/\s+/)
        .map((r) => r.replace(/[<>]/g, "")),
      isRead,
      headers,
    };
  }

  /**
   * Parse single email address
   */
  private parseEmailAddress(header: string): EmailAddress {
    const raw = header.trim();
    if (!raw) return { address: "" };

    const match = header.match(/^(?:"?([^"]*)"?\s+)?<?([^>]+)>?$/);
    if (match) {
      return {
        name: match[1]?.trim(),
        address: match[2].trim(),
      };
    }
    return { address: header.trim() };
  }

  /**
   * Parse multiple email addresses
   */
  private parseEmailAddresses(header: string): EmailAddress[] {
    if (!header.trim()) return [];
    return header
      .split(",")
      .map((addr) => this.parseEmailAddress(addr.trim()))
      .filter((address) => address.address);
  }

  /**
   * Decode MIME header
   */
  private decodeHeader(header: string): string {
    // Handle =?charset?encoding?text?= format
    const decoded = header.replace(
      /=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi,
      (_: string, charset: string, encoding: string, text: string) => {
        if (encoding.toUpperCase() === "B") {
          return decodeMimeBuffer(Buffer.from(text, "base64"), charset);
        }

        return decodeMimeBuffer(decodeQuotedPrintable(text.replace(/_/g, " ")), charset);
      },
    );

    return repairUtf8Mojibake(decoded);
  }

  /**
   * Decode body content
   */
  private decodeBody(text: string): string {
    // Handle quoted-printable
    return text
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  private decodeMimeBody(
    raw: string,
    contentTypeHeader?: string,
    transferEncodingHeader?: string,
  ): DecodedMimeEntity {
    const normalized = normalizeMimeLineEndings(raw).trim();
    if (!normalized) return {};

    let entityHeaders = new Map<string, string>();
    let body = normalized;

    const headerSeparator = normalized.indexOf("\n\n");
    if (headerSeparator !== -1) {
      const maybeHeaderBlock = normalized.slice(0, headerSeparator);
      const firstLine = maybeHeaderBlock.split("\n", 1)[0]?.trim() || "";
      if (!firstLine.startsWith("--") && /^[!-9;-~]+:/.test(firstLine)) {
        const parsedHeaders = parseHeaderBlock(maybeHeaderBlock);
        if (
          parsedHeaders.has("content-type") ||
          parsedHeaders.has("content-transfer-encoding") ||
          parsedHeaders.has("content-disposition") ||
          parsedHeaders.has("mime-version")
        ) {
          entityHeaders = parsedHeaders;
          body = normalized.slice(headerSeparator + 2);
        }
      }
    }

    const contentType = parseContentTypeHeader(
      entityHeaders.get("content-type") || contentTypeHeader || "text/plain",
    );
    const transferEncoding =
      (entityHeaders.get("content-transfer-encoding") || transferEncodingHeader || "").toLowerCase();

    if (contentType.mimeType.startsWith("multipart/") && contentType.boundary) {
      const parts = splitMultipartBody(body, contentType.boundary);
      let plainText: string | undefined;
      let html: string | undefined;

      for (const part of parts) {
        const decoded = this.decodeMimeBody(part);
        if (!plainText && decoded.plainText) plainText = decoded.plainText;
        if (!html && decoded.html) html = decoded.html;
      }

      return { plainText, html };
    }

    if (contentType.mimeType === "text/html") {
      const html = this.decodeMimeText(body, transferEncoding, contentType.charset);
      return { html };
    }

    if (contentType.mimeType.startsWith("text/") || !contentType.mimeType) {
      return {
        plainText: this.decodeMimeText(body, transferEncoding, contentType.charset),
      };
    }

    return {};
  }

  private decodeMimeText(body: string, transferEncoding: string, charset?: string): string {
    if (transferEncoding === "base64") {
      try {
        const compact = body.replace(/\s+/g, "");
        return decodeMimeBuffer(Buffer.from(compact, "base64"), charset).trim();
      } catch {
        return body.trim();
      }
    }

    if (transferEncoding === "quoted-printable") {
      try {
        return decodeMimeBuffer(decodeQuotedPrintable(body), charset).trim();
      } catch {
        return repairUtf8Mojibake(this.decodeBody(body).trim());
      }
    }

    // 8bit / 7bit / binary — re-decode through charset-aware path
    return decodeMimeBuffer(Buffer.from(body, "binary"), charset).trim();
  }

  /**
   * Disconnect IMAP
   */
  private async disconnectImap(): Promise<void> {
    if (this.imapSocket) {
      try {
        await this.imapCommand("LOGOUT");
      } catch {
        // Ignore logout errors
      }
      this.imapSocket.destroy();
      this.imapSocket = undefined;
    }
  }

  /**
   * Stop receiving
   */
  async stopReceiving(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    await this.disconnectImap();
    this.connected = false;
    this.emit("disconnected");
  }

  /**
   * Send email via SMTP
   */
  async sendEmail(options: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<string> {
    const authCommand = await this.getSmtpAuthCommand();

    return new Promise((resolve, reject) => {
      const toAddresses = (Array.isArray(options.to) ? options.to : [options.to]).map(
        sanitizeHeaderValue,
      );
      const ccAddresses = (options.cc
        ? Array.isArray(options.cc)
          ? options.cc
          : [options.cc]
        : []
      ).map(sanitizeHeaderValue);
      const bccAddresses = (options.bcc
        ? Array.isArray(options.bcc)
          ? options.bcc
          : [options.bcc]
        : []
      ).map(sanitizeHeaderValue);
      const envelopeRecipients = [...toAddresses, ...ccAddresses, ...bccAddresses].filter(Boolean);
      if (envelopeRecipients.length === 0) {
        reject(new Error("At least one recipient is required"));
        return;
      }
      const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2)}@${this.options.smtpHost}>`;

      // Build email
      const displayName = this.options.displayName
        ? sanitizeHeaderValue(this.options.displayName)
        : "";
      const fromAddress = sanitizeHeaderValue(this.options.email);
      const headers = [
        `From: ${displayName ? `"${displayName}" ` : ""}<${fromAddress}>`,
        `To: ${toAddresses.join(", ")}`,
        `Subject: ${sanitizeHeaderValue(options.subject)}`,
        `Message-ID: ${messageId}`,
        `Date: ${new Date().toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
      ];
      if (ccAddresses.length > 0) {
        headers.splice(2, 0, `Cc: ${ccAddresses.join(", ")}`);
      }

      if (options.inReplyTo) {
        headers.push(`In-Reply-To: <${sanitizeHeaderValue(options.inReplyTo)}>`);
      }

      if (options.references && options.references.length > 0) {
        headers.push(
          `References: ${options.references.map((r) => `<${sanitizeHeaderValue(r)}>`).join(" ")}`,
        );
      }

      const body = options.text || "";
      const email = headers.join("\r\n") + "\r\n\r\n" + body + "\r\n.\r\n";

      // Connect to SMTP
      const connectSmtp = () => {
        let socket: net.Socket | tls.TLSSocket;

        if (this.options.smtpSecure) {
          const servername = net.isIP(this.options.smtpHost) ? undefined : this.options.smtpHost;
          socket = tls.connect({
            host: this.options.smtpHost,
            port: this.options.smtpPort,
            servername,
            ca: getSystemCA(),
            rejectUnauthorized: true,
          });
        } else {
          socket = net.connect({
            host: this.options.smtpHost,
            port: this.options.smtpPort,
          });
        }

        let step = 0;
        let responseBuffer = "";
        let supportsStartTls = false;
        let startTlsComplete = this.options.smtpSecure;
        let rcptIndex = 0;
        let timeout: NodeJS.Timeout | undefined;

        const attachSmtpHandlers = (activeSocket: net.Socket | tls.TLSSocket) => {
          activeSocket.on("error", (error) => {
            reject(error);
          });

          activeSocket.on("close", () => {
            if (timeout) clearTimeout(timeout);
          });

          activeSocket.on("data", (data) => {
            responseBuffer += data.toString();

            // Check for complete response
            if (!responseBuffer.includes("\r\n")) return;

            const lines = responseBuffer.split("\r\n");
            responseBuffer = lines.pop() || "";

            for (const line of lines) {
              if (this.options.verbose) {
                console.log("SMTP <", line);
              }

              const code = parseInt(line.substring(0, 3), 10);
              if (/STARTTLS/i.test(line)) {
                supportsStartTls = true;
              }

              // Handle multi-line responses
              if (line[3] === "-") continue;

              if (code >= 400) {
                socket.destroy();
                reject(new Error(`SMTP error: ${line}`));
                return;
              }

              step++;
              switch (step) {
                case 1: // After greeting
                  supportsStartTls = false;
                  socket.write(`EHLO ${this.options.smtpHost}\r\n`);
                  break;
                case 2: // After EHLO
                  if (!startTlsComplete && supportsStartTls) {
                    socket.write("STARTTLS\r\n");
                  } else {
                    socket.write(authCommand);
                  }
                  break;
                case 3: // After STARTTLS or AUTH
                  if (line.includes("220") && !startTlsComplete) {
                    // Upgrade to TLS
                    const servername = net.isIP(this.options.smtpHost)
                      ? undefined
                      : this.options.smtpHost;
                    const tlsSocket = tls.connect({
                      socket: socket as net.Socket,
                      host: this.options.smtpHost,
                      servername,
                      ca: getSystemCA(),
                      rejectUnauthorized: true,
                    });
                    socket = tlsSocket;
                    startTlsComplete = true;
                    supportsStartTls = false;
                    responseBuffer = "";
                    step = 0;
                    attachSmtpHandlers(tlsSocket);
                    tlsSocket.once("secureConnect", () => {
                      tlsSocket.write(`EHLO ${this.options.smtpHost}\r\n`);
                      step = 1;
                    });
                  } else if (code === 334 && this.options.authMethod === "oauth") {
                    // Some SMTP servers still send a continuation challenge even when the
                    // XOAUTH2 initial client response is included on the AUTH line.
                    socket.write("\r\n");
                    step = 2;
                  } else {
                    socket.write(`MAIL FROM:<${this.options.email}>\r\n`);
                  }
                  break;
                case 4: // After MAIL FROM
                  socket.write(`RCPT TO:<${envelopeRecipients[rcptIndex++]}>\r\n`);
                  break;
                case 5: // After RCPT TO
                  if (rcptIndex < envelopeRecipients.length) {
                    socket.write(`RCPT TO:<${envelopeRecipients[rcptIndex++]}>\r\n`);
                    step = 4;
                  } else {
                    socket.write("DATA\r\n");
                  }
                  break;
                case 6: // After DATA
                  socket.write(email);
                  break;
                case 7: // After email sent
                  socket.write("QUIT\r\n");
                  socket.end();
                  resolve(messageId.replace(/[<>]/g, ""));
                  break;
              }
            }
          });
        };

        attachSmtpHandlers(socket);

        timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("SMTP connection timeout"));
        }, 30000);
      };

      connectSmtp();
    });
  }

  /**
   * Mark email as read
   */
  async markAsRead(uid: number): Promise<void> {
    await this.withSelectedMailbox(() => this.imapCommand(`UID STORE ${uid} +FLAGS (\\Seen)`));
  }

  /**
   * Mark email as unread
   */
  async markAsUnread(uid: number): Promise<void> {
    await this.withSelectedMailbox(() => this.imapCommand(`UID STORE ${uid} -FLAGS (\\Seen)`));
  }

  private async withSelectedMailbox<T>(operation: () => Promise<T>): Promise<T> {
    const needsConnection = !this.imapSocket || this.imapSocket.destroyed;
    if (!needsConnection) {
      return operation();
    }

    try {
      await this.connectImap();
      await this.selectMailbox();
      return await operation();
    } finally {
      await this.disconnectImap();
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get email address
   */
  getEmail(): string {
    return this.options.email;
  }
}
