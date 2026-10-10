/**
 * Holds what the user is about to import until they confirm it.
 *
 * The renderer only ever sees counts and site names, plus an unguessable token. The
 * secrets stay here in the main process, expire after a few minutes, and are dropped
 * the moment they are committed or cancelled. A token works once and only for the
 * profile it was prepared for.
 */

import { randomBytes, timingSafeEqual } from "crypto";
import type { CookieSetDetails } from "./cookie-import";
import type { ImportedLogin } from "./password-csv";

export const STAGED_IMPORT_TTL_MS = 5 * 60_000;
const MAX_STAGED = 4;

export interface StagedImport {
  profileKey: string;
  cookies: CookieSetDetails[];
  logins: ImportedLogin[];
  source: string;
  /** A password file the user picked; only the main process knows its path. */
  sourceFile?: string;
}

interface Entry extends StagedImport {
  token: string;
  expiresAt: number;
}

function wipe(entry: Entry): void {
  // Drop every reference; strings cannot be overwritten in place, so this is best effort.
  for (const login of entry.logins) login.password = "";
  for (const cookie of entry.cookies) cookie.value = "";
  entry.logins.length = 0;
  entry.cookies.length = 0;
}

export class ImportSessions {
  private entries = new Map<string, Entry>();

  constructor(
    private now: () => number = Date.now,
    private newToken: () => string = () => randomBytes(32).toString("hex"),
  ) {}

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        wipe(entry);
        this.entries.delete(token);
      }
    }
  }

  stage(data: StagedImport): string {
    this.sweep();
    // Oldest staged imports are dropped first.
    while (this.entries.size >= MAX_STAGED) {
      const oldest = this.entries.keys().next().value as string;
      wipe(this.entries.get(oldest)!);
      this.entries.delete(oldest);
    }
    const token = this.newToken();
    this.entries.set(token, { ...data, token, expiresAt: this.now() + STAGED_IMPORT_TTL_MS });
    return token;
  }

  /** Removes and returns a staged import. The caller owns (and must discard) the secrets. */
  take(token: unknown, profileKey: string): StagedImport | null {
    this.sweep();
    if (typeof token !== "string" || token.length !== 64) return null;
    let found: Entry | null = null;
    for (const entry of this.entries.values()) {
      const a = Buffer.from(entry.token);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) found = entry;
    }
    if (!found) return null;
    this.entries.delete(found.token);
    if (found.profileKey !== profileKey) {
      wipe(found);
      return null;
    }
    return found;
  }

  cancel(token: unknown): void {
    if (typeof token !== "string") return;
    const entry = this.entries.get(token);
    if (!entry) return;
    wipe(entry);
    this.entries.delete(token);
  }

  clear(): void {
    for (const entry of this.entries.values()) wipe(entry);
    this.entries.clear();
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }
}
