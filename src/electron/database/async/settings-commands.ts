import type Database from "better-sqlite3";
import {
  commitSecureSettingsWrites,
  MAX_SECURE_SETTINGS_WRITES,
  type SecureSettingsCommitResult,
  type SecureSettingsWrite,
} from "../secure-settings-sql";
import { InvalidCommandArgumentsError } from "./command-errors";
import {
  pulseClaim,
  type PulseClaimRequest,
  type PulseClaimResult,
  pulseCommit,
  type PulseCommitRequest,
  type PulseCommitResult,
  type PulseOp,
} from "../../telemetry/pulse-store-sql";

/**
 * Settings and policy transactions for the database worker (async SQLite migration plan,
 * DB5). The host encrypts; these commands only compare revisions and move ciphertext,
 * so no worker transaction waits on the keychain.
 */

const CATEGORY_PATTERN = /^[a-z0-9:._-]{1,128}$/i;
const MAX_CIPHERTEXT_CHARS = 16 * 1024 * 1024;

export function requireSecureSettingsWrites(value: unknown): SecureSettingsWrite[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SECURE_SETTINGS_WRITES) {
    throw new InvalidCommandArgumentsError(
      `writes must be a non-empty array of at most ${MAX_SECURE_SETTINGS_WRITES} writes`,
    );
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") {
      throw new InvalidCommandArgumentsError("each write must be an object");
    }
    const write = raw as Record<string, unknown>;
    if (typeof write.category !== "string" || !CATEGORY_PATTERN.test(write.category)) {
      throw new InvalidCommandArgumentsError("category must be a settings category name");
    }
    const expected = write.expectedRevision;
    if (
      expected !== "any" &&
      expected !== null &&
      !(typeof expected === "number" && Number.isInteger(expected) && expected >= 0)
    ) {
      throw new InvalidCommandArgumentsError(
        "expectedRevision must be a non-negative integer, null, or 'any'",
      );
    }
    let record: SecureSettingsWrite["record"] = null;
    if (write.record !== null) {
      const candidate = write.record as Record<string, unknown> | undefined;
      if (
        !candidate ||
        typeof candidate.encryptedData !== "string" ||
        candidate.encryptedData.length === 0 ||
        candidate.encryptedData.length > MAX_CIPHERTEXT_CHARS ||
        typeof candidate.checksum !== "string" ||
        !/^[0-9a-f]{64}$/.test(candidate.checksum)
      ) {
        throw new InvalidCommandArgumentsError("record must hold ciphertext and its checksum");
      }
      record = { encryptedData: candidate.encryptedData, checksum: candidate.checksum };
    }
    if (write.backupUnreadableAs !== undefined && typeof write.backupUnreadableAs !== "string") {
      throw new InvalidCommandArgumentsError("backupUnreadableAs must be a string");
    }
    return {
      category: write.category,
      expectedRevision: expected as SecureSettingsWrite["expectedRevision"],
      record,
      ...(write.backupUnreadableAs ? { backupUnreadableAs: write.backupUnreadableAs } : {}),
    };
  });
}

const MAX_PULSE_OPS = 16;
const MAX_PACKAGE_CHARS = 256 * 1024;

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCommandArgumentsError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new InvalidCommandArgumentsError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireTime(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InvalidCommandArgumentsError(`${name} must be a non-negative number`);
  }
  return value;
}

function requireRevision(value: unknown, allowAny: boolean): number | null | "any" {
  if (value === null) return null;
  if (allowAny && value === "any") return "any";
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new InvalidCommandArgumentsError("expectedRevision must be a revision or null");
}

function requirePulseOp(raw: unknown): PulseOp {
  const op = requireObject(raw, "op");
  switch (op.kind) {
    case "closeConsentWindows":
    case "openConsentWindow":
      return { kind: op.kind, now: requireTime(op.now, "now") };
    case "deleteConsentWindows":
    case "clearOutbox":
      return { kind: op.kind };
    case "deleteSentDaysExcept":
    case "deleteSentDaysFor":
      return { kind: op.kind, installationId: requireString(op.installationId, "installationId") };
    case "recordDelivered":
      return {
        kind: "recordDelivered",
        packageId: requireString(op.packageId, "packageId"),
        installationId: requireString(op.installationId, "installationId"),
        periodStart: requireString(op.periodStart, "periodStart"),
        now: requireTime(op.now, "now"),
      };
    case "incrementAttempt":
      return { kind: "incrementAttempt", packageId: requireString(op.packageId, "packageId") };
    default:
      throw new InvalidCommandArgumentsError("unknown Pulse op");
  }
}

function requirePulseCommit(raw: unknown): PulseCommitRequest {
  const args = requireObject(raw, "arguments");
  if (!Array.isArray(args.ops) || args.ops.length > MAX_PULSE_OPS) {
    throw new InvalidCommandArgumentsError(`ops must be an array of at most ${MAX_PULSE_OPS} ops`);
  }
  let record: PulseCommitRequest["record"] = null;
  if (args.record !== null) {
    record = requireSecureSettingsWrites([
      { category: "pulse", expectedRevision: "any", record: args.record },
    ])[0].record;
  }
  return {
    expectedRevision: requireRevision(args.expectedRevision, true),
    record,
    ops: args.ops.map(requirePulseOp),
    ...(typeof args.backupUnreadableAs === "string"
      ? { backupUnreadableAs: args.backupUnreadableAs }
      : {}),
  };
}

function requirePulseClaim(raw: unknown): PulseClaimRequest {
  const args = requireObject(raw, "arguments");
  let candidate: PulseClaimRequest["candidate"];
  if (args.candidate !== undefined) {
    const value = requireObject(args.candidate, "candidate");
    candidate = {
      packageId: requireString(value.packageId, "candidate.packageId"),
      periodStart: requireString(value.periodStart, "candidate.periodStart"),
      payloadJson: requireString(value.payloadJson, "candidate.payloadJson", MAX_PACKAGE_CHARS),
      createdAt: requireTime(value.createdAt, "candidate.createdAt"),
    };
  }
  const expectedRevision = requireRevision(args.expectedRevision, false);
  return {
    expectedRevision: expectedRevision === "any" ? null : expectedRevision,
    installationId: requireString(args.installationId, "installationId"),
    ...(candidate ? { candidate } : {}),
    dayPackageId: requireString(args.dayPackageId, "dayPackageId"),
  };
}

const PULSE_TABLES = [
  "secure_settings",
  "secure_settings_revision_clock",
  "pulse_consent_windows",
  "pulse_outbox",
  "pulse_sent_days",
] as const;

export const SETTINGS_COMMANDS = {
  /**
   * One Pulse decision or delivery result: settings ciphertext, consent windows and
   * outbox, under the settings revision the host read.
   */
  "pulse.commit": {
    kind: "write",
    tables: PULSE_TABLES,
    run(db: Database.Database, args: PulseCommitRequest): PulseCommitResult {
      return pulseCommit(db, requirePulseCommit(args));
    },
  },
  /** Queue today's package if still unsent and return the oldest queued day. */
  "pulse.claim": {
    kind: "write",
    tables: PULSE_TABLES,
    run(db: Database.Database, args: PulseClaimRequest): PulseClaimResult {
      return pulseClaim(db, requirePulseClaim(args));
    },
  },
  /** Commit encrypted settings rows under their revision checks, atomically. */
  "secureSettings.commit": {
    kind: "write",
    tables: [
      "secure_settings",
      "secure_settings_revision_clock",
      "secure_settings_unreadable_backup",
    ],
    run(
      db: Database.Database,
      args: { writes: SecureSettingsWrite[] },
    ): SecureSettingsCommitResult {
      const writes = requireSecureSettingsWrites(args?.writes);
      return commitSecureSettingsWrites(db, writes);
    },
  },
} as const;
