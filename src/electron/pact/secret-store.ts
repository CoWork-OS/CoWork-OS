/**
 * PACT secrets in SecureSettingsRepository (safeStorage, with the `app2:` AES-GCM fallback).
 *
 * Categories:
 * - `pact:grants`: delegation access and refresh tokens per grant.
 * - `pact:authorization`: device codes, user codes and sign-in links per pending request.
 * - `pact:signer`: the signer credential or the install's device key.
 * - `pact:receipts`: raw receipt JWS and claims (they carry the business user id).
 *
 * Every write uses `update`/`updateWithin`, which throw instead of reporting a refused write as
 * saved, so a token is never silently dropped and never falls back to plaintext. The pact_*
 * tables only hold the opaque references used as keys here.
 */
import type Database from "better-sqlite3";
import {
  DELETE_SECURE_SETTINGS,
  SecureSettingsRepository,
  type SettingsCategory,
} from "../database/SecureSettingsRepository";
import type { ReceiptClaims } from "./upstream/delegation";

export interface PactGrantSecret {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt: number;
}

export interface PactAuthorizationSecret {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
}

export interface PactSignerSecret {
  credential?: string;
  /** The signer URL and issuer the credential was entered for; a change voids it. */
  credentialSignerUrl?: string;
  credentialIssuer?: string;
  /** HMAC key for account-binding digests in the pact_* tables. */
  accountBindingKey?: string;
  deviceKey?: { privateJwk: Record<string, string>; publicJwk: Record<string, string> };
}

export interface PactReceiptSecret {
  jws: string;
  claims: ReceiptClaims;
}

export class PactSecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PactSecretUnavailableError";
  }
}

/** Storage for PACT secrets; the default is SecureSettingsRepository, tests use memory. */
export interface PactSecretStore {
  getGrant(ref: string): PactGrantSecret | undefined;
  putGrant(ref: string, secret: PactGrantSecret): void;
  /**
   * Replace a grant's tokens and apply `alsoApply` (SQL only) in the same transaction. Returns
   * false without writing when `alsoApply` refuses, e.g. because another refresh won.
   */
  rotateGrant(
    ref: string,
    secret: PactGrantSecret,
    alsoApply: (db: Database.Database) => boolean,
  ): boolean;
  deleteGrant(ref: string): void;
  getAuthorization(ref: string): PactAuthorizationSecret | undefined;
  putAuthorization(ref: string, secret: PactAuthorizationSecret): void;
  deleteAuthorization(ref: string): void;
  getSigner(): PactSignerSecret | undefined;
  putSigner(secret: PactSignerSecret | undefined): void;
  getReceipt(ref: string): PactReceiptSecret | undefined;
  putReceipt(ref: string, secret: PactReceiptSecret): void;
}

interface EntriesDocument<T> {
  version: 1;
  entries: Record<string, T>;
}

const MAX_RECEIPTS = 2000;
const MAX_AUTHORIZATIONS = 200;

function requireRepository(): SecureSettingsRepository {
  if (!SecureSettingsRepository.isInitialized()) {
    throw new PactSecretUnavailableError("Secure settings are not initialized");
  }
  return SecureSettingsRepository.getInstance();
}

export class SecureSettingsPactSecretStore implements PactSecretStore {
  constructor(private readonly repository: () => SecureSettingsRepository = requireRepository) {}

  private read<T>(category: SettingsCategory, ref: string): T | undefined {
    const result = this.repository().loadWithStatus<EntriesDocument<T>>(category);
    if (result.status === "not_found") return undefined;
    if (result.status !== "success") {
      throw new PactSecretUnavailableError(`PACT secrets are unreadable (${result.status})`);
    }
    const entries = result.data?.entries;
    if (!entries || !Object.prototype.hasOwnProperty.call(entries, ref)) return undefined;
    return entries[ref];
  }

  private write<T>(category: SettingsCategory, ref: string, value: T, cap?: number): void {
    this.repository().update<EntriesDocument<T>>(category, (current) => {
      const entries = { ...current?.entries };
      delete entries[ref];
      entries[ref] = value;
      const keys = Object.keys(entries);
      if (cap !== undefined && keys.length > cap) {
        // Insertion order is age order; drop the oldest beyond the cap.
        for (const key of keys.slice(0, keys.length - cap)) delete entries[key];
      }
      return { version: 1, entries };
    });
  }

  private remove(category: SettingsCategory, ref: string): void {
    this.repository().update<EntriesDocument<unknown>>(category, (current) => {
      if (!current?.entries || !Object.prototype.hasOwnProperty.call(current.entries, ref)) {
        return undefined;
      }
      const { [ref]: _removed, ...rest } = current.entries;
      return Object.keys(rest).length > 0 ? { version: 1, entries: rest } : DELETE_SECURE_SETTINGS;
    });
  }

  getGrant(ref: string): PactGrantSecret | undefined {
    return this.read<PactGrantSecret>("pact:grants", ref);
  }

  putGrant(ref: string, secret: PactGrantSecret): void {
    this.write("pact:grants", ref, secret);
  }

  rotateGrant(
    ref: string,
    secret: PactGrantSecret,
    alsoApply: (db: Database.Database) => boolean,
  ): boolean {
    const outcome = this.repository().updateWithin<EntriesDocument<PactGrantSecret>>(
      "pact:grants",
      (current) => ({ version: 1, entries: { ...current?.entries, [ref]: secret } }),
      alsoApply,
    );
    return outcome !== null;
  }

  deleteGrant(ref: string): void {
    this.remove("pact:grants", ref);
  }

  getAuthorization(ref: string): PactAuthorizationSecret | undefined {
    return this.read<PactAuthorizationSecret>("pact:authorization", ref);
  }

  putAuthorization(ref: string, secret: PactAuthorizationSecret): void {
    this.write("pact:authorization", ref, secret, MAX_AUTHORIZATIONS);
  }

  deleteAuthorization(ref: string): void {
    this.remove("pact:authorization", ref);
  }

  getSigner(): PactSignerSecret | undefined {
    return this.read<PactSignerSecret>("pact:signer", "default");
  }

  putSigner(secret: PactSignerSecret | undefined): void {
    if (!secret) {
      this.remove("pact:signer", "default");
      return;
    }
    this.write("pact:signer", "default", secret);
  }

  getReceipt(ref: string): PactReceiptSecret | undefined {
    return this.read<PactReceiptSecret>("pact:receipts", ref);
  }

  putReceipt(ref: string, secret: PactReceiptSecret): void {
    this.write("pact:receipts", ref, secret, MAX_RECEIPTS);
  }
}

/** In-memory store for tests and for runs without secure storage (nothing persists). */
export class MemoryPactSecretStore implements PactSecretStore {
  private readonly grants = new Map<string, PactGrantSecret>();
  private readonly authorizations = new Map<string, PactAuthorizationSecret>();
  private readonly receipts = new Map<string, PactReceiptSecret>();
  private signer: PactSignerSecret | undefined;

  constructor(private readonly db?: Database.Database) {}

  getGrant(ref: string) {
    return this.grants.get(ref);
  }
  putGrant(ref: string, secret: PactGrantSecret) {
    this.grants.set(ref, { ...secret });
  }
  rotateGrant(ref: string, secret: PactGrantSecret, alsoApply: (db: Database.Database) => boolean) {
    if (this.db) {
      const applied = this.db.transaction(() => alsoApply(this.db!)).immediate();
      if (!applied) return false;
    }
    this.grants.set(ref, { ...secret });
    return true;
  }
  deleteGrant(ref: string) {
    this.grants.delete(ref);
  }
  getAuthorization(ref: string) {
    return this.authorizations.get(ref);
  }
  putAuthorization(ref: string, secret: PactAuthorizationSecret) {
    this.authorizations.set(ref, { ...secret });
  }
  deleteAuthorization(ref: string) {
    this.authorizations.delete(ref);
  }
  getSigner() {
    return this.signer;
  }
  putSigner(secret: PactSignerSecret | undefined) {
    this.signer = secret;
  }
  getReceipt(ref: string) {
    return this.receipts.get(ref);
  }
  putReceipt(ref: string, secret: PactReceiptSecret) {
    this.receipts.set(ref, secret);
  }
}
