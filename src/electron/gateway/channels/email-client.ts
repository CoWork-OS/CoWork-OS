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
  password: string;
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
    this.options = options;
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
          this.handleImapData(data.toString());
        });

        this.imapSocket.once("connect", async () => {
          try {
            // Wait for server greeting
            await this.waitForResponse("OK");

            // Login
            await this.imapCommand(`LOGIN "${this.options.email}" "${this.options.password}"`);
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

  /**
   * Parse email from IMAP response (simplified)
   */
  private parseEmailResponse(response: string, uid: number): EmailMessage | null {
    const headers = new Map<string, string>();

    // Extract headers (simplified parsing)
    const headerMatch = response.match(/BODY\[HEADER\]\s*\{(\d+)\}\r\n([\s\S]*?)\r\n\r\n/i);
    if (headerMatch) {
      const headerText = headerMatch[2];
      const headerLines = headerText.split(/\r\n(?=[^\s])/);

      for (const line of headerLines) {
        const colonIndex = line.indexOf(":");
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line
            .substring(colonIndex + 1)
            .replace(/\r\n\s+/g, " ")
            .trim();
          headers.set(key, value);
        }
      }
    }

    // Extract text body (simplified)
    let text = "";
    const textMatch = response.match(/BODY\[TEXT\]\s*\{(\d+)\}\r\n([\s\S]*?)(?=\)|\*)/i);
    if (textMatch) {
      text = textMatch[2].trim();
    }

    // Parse From address
    const fromHeader = headers.get("from") || "";
    const from = this.parseEmailAddress(fromHeader);

    // Parse To addresses
    const toHeader = headers.get("to") || "";
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
      text: this.decodeBody(text),
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
    return header.split(",").map((addr) => this.parseEmailAddress(addr.trim()));
  }

  /**
   * Decode MIME header
   */
  private decodeHeader(header: string): string {
    // Handle =?charset?encoding?text?= format
    return header.replace(
      /=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi,
      (_: string, charset: string, encoding: string, text: string) => {
        if (encoding.toUpperCase() === "B") {
          return Buffer.from(text, "base64").toString("utf8");
        } else {
          return text
            .replace(/_/g, " ")
            .replace(/=([0-9A-F]{2})/gi, (__: string, hex: string) =>
              String.fromCharCode(parseInt(hex, 16)),
            );
        }
      },
    );
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
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const toAddresses = Array.isArray(options.to) ? options.to : [options.to];
      const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2)}@${this.options.smtpHost}>`;

      // Build email
      const headers = [
        `From: ${this.options.displayName ? `"${this.options.displayName}" ` : ""}<${this.options.email}>`,
        `To: ${toAddresses.join(", ")}`,
        `Subject: ${options.subject}`,
        `Message-ID: ${messageId}`,
        `Date: ${new Date().toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
      ];

      if (options.inReplyTo) {
        headers.push(`In-Reply-To: <${options.inReplyTo}>`);
      }

      if (options.references && options.references.length > 0) {
        headers.push(`References: ${options.references.map((r) => `<${r}>`).join(" ")}`);
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

        socket.on("data", (data) => {
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
                socket.write(`EHLO ${this.options.smtpHost}\r\n`);
                break;
              case 2: // After EHLO
                if (!this.options.smtpSecure && line.includes("STARTTLS")) {
                  socket.write("STARTTLS\r\n");
                } else {
                  socket.write(
                    `AUTH PLAIN ${Buffer.from(`\0${this.options.email}\0${this.options.password}`).toString("base64")}\r\n`,
                  );
                }
                break;
              case 3: // After STARTTLS or AUTH
                if (line.includes("220") && !this.options.smtpSecure) {
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
                  socket.write(`EHLO ${this.options.smtpHost}\r\n`);
                  step = 1;
                } else {
                  socket.write(`MAIL FROM:<${this.options.email}>\r\n`);
                }
                break;
              case 4: // After MAIL FROM
                socket.write(`RCPT TO:<${toAddresses[0]}>\r\n`);
                break;
              case 5: // After RCPT TO
                socket.write("DATA\r\n");
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

        socket.on("error", (error) => {
          reject(error);
        });

        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("SMTP connection timeout"));
        }, 30000);

        socket.on("close", () => {
          clearTimeout(timeout);
        });
      };

      connectSmtp();
    });
  }

  /**
   * Mark email as read
   */
  async markAsRead(uid: number): Promise<void> {
    await this.imapCommand(`UID STORE ${uid} +FLAGS (\\Seen)`);
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
