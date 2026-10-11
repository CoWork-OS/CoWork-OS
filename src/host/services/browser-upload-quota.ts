import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { getUserDataRootDir } from "../../electron/utils/user-data-dir";
import { WebApplicationError } from "../web/WebApplication";

const MiB = 1024 * 1024;
const MAX_SCOPES = 2_048;
const MAX_LEDGER_BYTES = 1024 * 1024;

export interface BrowserUploadQuotaOptions {
  /** Host-owned storage shared across profiles, outside browser-writable workspaces. */
  uploadQuotaDirectory?: string;
  maxCommittedUploadBytes?: number;
  maxProfileCommittedUploadBytes?: number;
  maxWorkspaceCommittedUploadBytes?: number;
  maxCommittedUploadFiles?: number;
  maxProfileCommittedUploadFiles?: number;
  maxWorkspaceCommittedUploadFiles?: number;
  maxProfileUploadsPerMinute?: number;
  minUploadFreeBytes?: number;
}

interface Usage {
  bytes: number;
  files: number;
  attempts: number;
  windowStart: number;
}

interface Ledger {
  version: 1;
  total: Usage;
  pendingBytes: number;
  profiles: Record<string, Usage>;
  workspaces: Record<string, Usage>;
}

export interface BrowserUploadReservation {
  bytes: number;
  profile: string;
  workspace: string;
  settled: boolean;
}

/** Durable lifetime budgets. Interrupted reservations stay charged until local recovery. */
export class BrowserUploadQuota {
  constructor(private readonly options: BrowserUploadQuotaOptions) {}

  private get directory(): string {
    return (
      this.options.uploadQuotaDirectory ??
      path.join(getUserDataRootDir(), ".cowork", "policy", "browser-upload-quota")
    );
  }

  async assertTargetAllowed(parentPath: string): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.realpath(this.directory);
    const relative = path.relative(directory, parentPath);
    if (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ) {
      throw new WebApplicationError(
        "FORBIDDEN",
        "Host upload accounting storage is unavailable to browser uploads.",
        403,
        false,
      );
    }
  }

  async reserve(
    profileId: string,
    workspaceIdentity: string,
    bytes: number,
    freeBytes: () => Promise<bigint>,
  ): Promise<BrowserUploadReservation> {
    const profile = key(profileId);
    const workspace = key(workspaceIdentity);
    return this.update(async (ledger) => {
      const profileUsage = ledger.profiles[profile] ?? emptyUsage();
      const workspaceUsage = ledger.workspaces[workspace] ?? emptyUsage();
      if (
        (!ledger.profiles[profile] && Object.keys(ledger.profiles).length >= MAX_SCOPES) ||
        (!ledger.workspaces[workspace] && Object.keys(ledger.workspaces).length >= MAX_SCOPES)
      )
        throw quotaExceeded();
      const scopes: [Usage, number, number][] = [
        [
          ledger.total,
          limit(this.options.maxCommittedUploadBytes, 4096 * MiB),
          limit(this.options.maxCommittedUploadFiles, 8192),
        ],
        [
          profileUsage,
          limit(this.options.maxProfileCommittedUploadBytes, 1024 * MiB),
          limit(this.options.maxProfileCommittedUploadFiles, 4096),
        ],
        [
          workspaceUsage,
          limit(this.options.maxWorkspaceCommittedUploadBytes, 512 * MiB),
          limit(this.options.maxWorkspaceCommittedUploadFiles, 2048),
        ],
      ];
      for (const [usage, maxBytes, maxFiles] of scopes) {
        if (usage.bytes + bytes > maxBytes || usage.files + 1 > maxFiles) throw quotaExceeded();
      }
      const now = Date.now();
      if (now >= profileUsage.windowStart + 60_000) {
        profileUsage.windowStart = now;
        profileUsage.attempts = 0;
      }
      if (profileUsage.attempts >= limit(this.options.maxProfileUploadsPerMinute, 60)) {
        throw new WebApplicationError(
          "RATE_LIMITED",
          "Browser upload rate limit reached. Try again later.",
          429,
          true,
        );
      }
      await this.assertFreeSpace(freeBytes, ledger.pendingBytes + bytes);
      for (const [usage] of scopes) {
        usage.bytes += bytes;
        usage.files += 1;
      }
      profileUsage.attempts += 1;
      ledger.pendingBytes += bytes;
      ledger.profiles[profile] = profileUsage;
      ledger.workspaces[workspace] = workspaceUsage;
      return { bytes, profile, workspace, settled: false };
    });
  }

  /** Only refund a failed upload after every owned staging/final file is absent. */
  async settle(
    reservation: BrowserUploadReservation,
    committedBytes: number | null,
  ): Promise<void> {
    if (reservation.settled) throw new Error("Upload reservation already settled.");
    if (
      committedBytes !== null &&
      (!Number.isSafeInteger(committedBytes) ||
        committedBytes < 0 ||
        committedBytes > reservation.bytes)
    ) {
      throw new Error("Invalid upload reservation settlement.");
    }
    // The rename may succeed even if the following directory flush fails. Never
    // retry/refund an uncertain settlement against aggregate counters: doing so
    // could release another upload's reservation. Retain charges on any error.
    reservation.settled = true;
    await this.update(async (ledger) => {
      const refund = reservation.bytes - (committedBytes ?? 0);
      for (const usage of [
        ledger.total,
        ledger.profiles[reservation.profile],
        ledger.workspaces[reservation.workspace],
      ]) {
        if (!usage || usage.bytes < reservation.bytes || usage.files < 1)
          throw new Error("Invalid upload quota state.");
        usage.bytes -= refund;
        if (committedBytes === null) usage.files -= 1;
      }
      if (ledger.pendingBytes < reservation.bytes) throw new Error("Invalid pending upload quota.");
      ledger.pendingBytes -= reservation.bytes;
    });
  }

  async assertFreeSpace(freeBytes: () => Promise<bigint>, neededBytes: number): Promise<void> {
    const floor = limit(this.options.minUploadFreeBytes, 1024 * MiB, 0);
    if ((await freeBytes()) < BigInt(floor) + BigInt(neededBytes)) {
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "Insufficient free space for a browser upload.",
        503,
        true,
      );
    }
  }

  private async update<T>(operation: (ledger: Ledger) => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.directory, "quota.lock");
    const deadline = Date.now() + 2_000;
    let lock: fs.FileHandle;
    for (;;) {
      try {
        lock = await fs.open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
          0o600,
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new WebApplicationError(
            "RATE_LIMITED",
            "Browser upload accounting is busy or requires local recovery.",
            429,
            true,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    // Never steal an existing lock: a paused writer must retain exclusive ownership.
    // A crash-held lock requires local recovery; committed quota is never reset automatically.
    const ledgerPath = path.join(this.directory, "quota.json");
    const tempPath = path.join(this.directory, `quota-${crypto.randomUUID()}.tmp`);
    try {
      const ledger = await readLedger(ledgerPath);
      const result = await operation(ledger);
      const handle = await fs.open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(ledger));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, ledgerPath);
      await this.flushLedgerDirectory();
      return result;
    } finally {
      await fs.unlink(tempPath).catch(() => undefined);
      await lock.close();
      await fs.unlink(lockPath);
    }
  }

  /** @internal Fault injection at the ambiguous rename/directory-flush boundary. */
  protected async flushLedgerDirectory(): Promise<void> {
    if (process.platform === "win32") return;
    const directory = await fs.open(this.directory, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

async function readLedger(filePath: string): Promise<Ledger> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, total: emptyUsage(), pendingBytes: 0, profiles: {}, workspaces: {} };
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_LEDGER_BYTES)
      throw new Error("Invalid upload quota ledger.");
    const data = JSON.parse(await handle.readFile("utf8")) as Ledger;
    if (
      data.version !== 1 ||
      !validUsage(data.total) ||
      !validNumber(data.pendingBytes) ||
      data.pendingBytes > data.total.bytes
    ) {
      throw new Error("Invalid upload quota ledger.");
    }
    for (const entries of [data.profiles, data.workspaces]) {
      if (
        !entries ||
        typeof entries !== "object" ||
        Array.isArray(entries) ||
        Object.keys(entries).length > MAX_SCOPES
      )
        throw new Error("Invalid upload quota scopes.");
      let bytes = 0;
      let files = 0;
      for (const [id, usage] of Object.entries(entries)) {
        if (!/^[0-9a-f]{64}$/.test(id) || !validUsage(usage))
          throw new Error("Invalid upload quota scope.");
        bytes += usage.bytes;
        files += usage.files;
      }
      if (bytes !== data.total.bytes || files !== data.total.files)
        throw new Error("Inconsistent upload quota ledger.");
    }
    return data;
  } finally {
    await handle.close();
  }
}

function emptyUsage(): Usage {
  return { bytes: 0, files: 0, attempts: 0, windowStart: 0 };
}
function validNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function validUsage(value: Usage): boolean {
  return (
    Boolean(value) &&
    [value.bytes, value.files, value.attempts, value.windowStart].every(validNumber)
  );
}
function key(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function limit(value: number | undefined, fallback: number, minimum = 1): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= 16 * 1024 * MiB
    ? value
    : fallback;
}
function quotaExceeded(): WebApplicationError {
  return new WebApplicationError(
    "RATE_LIMITED",
    "Persistent browser upload quota reached. Local storage review is required.",
    429,
    false,
  );
}
