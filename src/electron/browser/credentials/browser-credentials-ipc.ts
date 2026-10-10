/**
 * IPC for importing cookies and saved logins, and for filling a saved login.
 *
 * Trust rules enforced here (the renderer is a web context and is not trusted):
 * - Only the app's main window may call these handlers.
 * - The renderer never sees a password or a cookie value, only counts and site names.
 * - File paths come from a native file dialog in this process, never from the renderer.
 * - Committing an import and filling a login each need an approval the renderer cannot give
 *   for itself: a native confirmation (and Touch ID for fills when the Mac has it).
 */

import * as fs from "fs/promises";
import { browserPartitionFor, browserProfileKey } from "../../../shared/browser-profile";
import { IPC_CHANNELS } from "../../../shared/types";
import { fillLogin, registerFilledPassword, type FillTarget } from "./autofill";
import { applyCookies, mapCookies, type CookieJar, type CookieSetDetails } from "./cookie-import";
import { CsvError, decodeCsvBytes, MAX_CSV_BYTES } from "./csv";
import {
  chromiumBrowserById,
  detectBrowsers,
  ImportError,
  readChromiumCookies,
  readChromiumLogins,
  readFirefoxCookies,
  type ExternalBrowserDeps,
} from "./external-browsers";
import { ImportSessions, type StagedImport } from "./import-session";
import { parsePasswordCsv, type ImportedLogin } from "./password-csv";
import { VaultError, type BrowserVault } from "./vault";

type IpcMainLike = {
  handle: (channel: string, handler: (event: Any, data: Any) => unknown) => void;
};

export interface CredentialsIpcDeps {
  ipcMain: IpcMainLike;
  isMainWindowSender: (event: Any) => boolean;
  vault: BrowserVault;
  external: ExternalBrowserDeps;
  sessions: ImportSessions;
  /** The cookie jar of a workbench partition. */
  cookieJar: (partition: string) => CookieJar;
  /** The page of a workbench tab. */
  getTabContents: (taskId: string, sessionId: string) => Promise<FillTarget | null>;
  /** Native file picker (main-owned). Returns the chosen path or null. */
  pickPasswordFile: () => Promise<string | null>;
  /** Native yes/no confirmation. */
  confirm: (options: { message: string; detail: string; confirmLabel: string }) => Promise<boolean>;
  /** Touch ID when available; null when this Mac cannot do it. */
  promptBiometric: ((reason: string) => Promise<boolean>) | null;
  /** Overwrite then remove a file. */
  shredFile: (file: string) => Promise<void>;
  now?: () => number;
}

const readString = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;

const FILL_COOLDOWN_MS = 2_000;

export async function shredFileOnDisk(file: string): Promise<void> {
  // Best effort: on SSDs and APFS an overwrite is not guaranteed to reach the old blocks.
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error("not a regular file");
  const handle = await fs.open(file, "r+");
  try {
    await handle.write(Buffer.alloc(stat.size, 0), 0, stat.size, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.unlink(file);
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function summarize(staged: StagedImport) {
  const sites = new Set<string>();
  for (const login of staged.logins) sites.add(hostOf(login.origin));
  for (const cookie of staged.cookies) sites.add(hostOf(cookie.url));
  return {
    source: staged.source,
    cookies: staged.cookies.length,
    logins: staged.logins.length,
    // Names only, never usernames or values.
    sampleSites: [...sites].slice(0, 8),
  };
}

export function registerBrowserCredentialsIpc(deps: CredentialsIpcDeps): void {
  const { ipcMain, vault, sessions } = deps;
  const now = deps.now ?? Date.now;
  let busy = false;
  let fillCooldownUntil = 0;
  // The picked file's path outlives the staged secrets only until the user answers the delete prompt.
  const stagedFiles = new Map<string, string | undefined>();

  const guarded = (
    channel: string,
    run: (data: Any, event: Any) => unknown,
    onDenied: () => unknown,
  ) =>
    ipcMain.handle(channel, async (event, data) => {
      if (!deps.isMainWindowSender(event)) return onDenied();
      return run(data, event);
    });

  const failure = (error: unknown) => {
    if (error instanceof ImportError || error instanceof VaultError || error instanceof CsvError) {
      return { success: false as const, code: error.code, error: error.message };
    }
    if (error instanceof Error && error.name === "PasswordCsvError") {
      return { success: false as const, code: "bad_file", error: error.message };
    }
    return { success: false as const, code: "failed", error: "The import could not be completed." };
  };
  const denied = () => ({ success: false as const, code: "denied", error: "Not allowed." });
  const profileOf = (data: Any): { workspaceId: string; profileKey: string } | null => {
    const workspaceId = readString(data?.workspaceId);
    return workspaceId ? { workspaceId, profileKey: browserProfileKey(workspaceId) } : null;
  };

  guarded(
    IPC_CHANNELS.BROWSER_IMPORT_DETECT,
    async () => ({
      success: true as const,
      browsers: await detectBrowsers(deps.external),
      canStorePasswords: vault.canStore(),
    }),
    () => ({ success: false as const, browsers: [], canStorePasswords: false }),
  );

  guarded(
    IPC_CHANNELS.BROWSER_IMPORT_PREPARE,
    async (data) => {
      const profile = profileOf(data);
      const kind = data?.kind;
      if (!profile || (kind !== "browser" && kind !== "csv")) {
        return { success: false as const, code: "invalid", error: "Invalid request." };
      }
      if (busy)
        return { success: false as const, code: "busy", error: "An import is already running." };
      busy = true;
      try {
        const nowSeconds = Math.floor(now() / 1000);
        let cookies: CookieSetDetails[] = [];
        let logins: ImportedLogin[] = [];
        let source = "";
        let sourceFile: string | undefined;
        let skipped: Record<string, number> = {};

        if (kind === "csv") {
          const file = await deps.pickPasswordFile();
          if (!file)
            return { success: false as const, code: "cancelled", error: "No file chosen." };
          const stat = await fs.stat(file);
          if (!stat.isFile() || stat.size > MAX_CSV_BYTES) {
            return {
              success: false as const,
              code: "bad_file",
              error: "That file is not a usable password export.",
            };
          }
          const parsed = parsePasswordCsv(decodeCsvBytes(await fs.readFile(file)));
          logins = parsed.logins;
          skipped = parsed.skipped;
          source = "CSV file";
          sourceFile = file;
        } else {
          const browserId = readString(data?.browserId, 40);
          const profileId = readString(data?.profileId, 80);
          const wantCookies = data?.cookies === true;
          const wantPasswords = data?.passwords === true;
          if (!browserId || !profileId || (!wantCookies && !wantPasswords)) {
            return { success: false as const, code: "invalid", error: "Invalid request." };
          }
          const detected = (await detectBrowsers(deps.external)).find(
            (item) => item.id === browserId,
          );
          if (!detected || !detected.profiles.some((item) => item.id === profileId)) {
            return {
              success: false as const,
              code: "not_found",
              error: "That browser profile was not found.",
            };
          }
          source = detected.name;
          if (detected.kind === "firefox") {
            if (wantPasswords && !wantCookies) {
              return {
                success: false as const,
                code: "unsupported",
                error:
                  "Firefox passwords can't be read directly. Export them to a CSV file from Firefox and import that.",
              };
            }
            const mapped = mapCookies(
              await readFirefoxCookies(deps.external, profileId),
              nowSeconds,
            );
            cookies = mapped.cookies;
            skipped = { ...mapped.skipped };
          } else {
            const definition = chromiumBrowserById(browserId)!;
            if (wantCookies) {
              const mapped = mapCookies(
                await readChromiumCookies(deps.external, definition, profileId),
                nowSeconds,
              );
              cookies = mapped.cookies;
              skipped = { ...mapped.skipped };
            }
            if (wantPasswords)
              logins = await readChromiumLogins(deps.external, definition, profileId);
          }
        }
        if (cookies.length === 0 && logins.length === 0) {
          return { success: false as const, code: "empty", error: "Nothing to import was found." };
        }
        const staged: StagedImport = {
          profileKey: profile.profileKey,
          cookies,
          logins,
          source,
          sourceFile,
        };
        const token = sessions.stage(staged);
        return { success: true as const, token, skipped, ...summarize(staged) };
      } catch (error) {
        return failure(error);
      } finally {
        busy = false;
      }
    },
    denied,
  );

  guarded(
    IPC_CHANNELS.BROWSER_IMPORT_COMMIT,
    async (data) => {
      const profile = profileOf(data);
      if (!profile) return { success: false as const, code: "invalid", error: "Invalid request." };
      const staged = sessions.take(data?.token, profile.profileKey);
      if (!staged)
        return {
          success: false as const,
          code: "expired",
          error: "This import expired. Start it again.",
        };
      try {
        const includeCookies = data?.cookies !== false;
        const includePasswords = data?.passwords !== false;
        const cookies = includeCookies ? staged.cookies : [];
        const logins = includePasswords ? staged.logins : [];
        if (logins.length > 0 && !vault.canStore()) {
          return {
            success: false as const,
            code: "encryption_unavailable",
            error: "This Mac's secure storage isn't available, so passwords can't be saved safely.",
          };
        }
        const parts = [
          logins.length > 0 ? `${logins.length} saved login${logins.length === 1 ? "" : "s"}` : "",
          cookies.length > 0 ? `${cookies.length} cookie${cookies.length === 1 ? "" : "s"}` : "",
        ].filter(Boolean);
        if (parts.length === 0)
          return { success: false as const, code: "empty", error: "Nothing selected." };
        const approved = await deps.confirm({
          message: `Import ${parts.join(" and ")} from ${staged.source}?`,
          detail:
            `Including ${[...new Set([...logins.map((l) => hostOf(l.origin)), ...cookies.map((c) => hostOf(c.url))])].slice(0, 6).join(", ")}.\n\n` +
            "Passwords are encrypted with this Mac's secure storage and are only ever filled into the " +
            "exact site they belong to when you ask. Cookies can sign you in to those sites.",
          confirmLabel: "Import",
        });
        if (!approved)
          return { success: false as const, code: "cancelled", error: "Import cancelled." };

        const result = { cookies: 0, cookiesRejected: 0, logins: 0, loginsUpdated: 0 };
        if (logins.length > 0) {
          const added = vault.addMany(profile.profileKey, logins);
          result.logins = added.added;
          result.loginsUpdated = added.updated;
        }
        if (cookies.length > 0) {
          const applied = await applyCookies(
            deps.cookieJar(browserPartitionFor(profile.workspaceId)),
            cookies,
          );
          result.cookies = applied.imported;
          result.cookiesRejected = applied.rejected;
        }
        return { success: true as const, ...result, canDeleteFile: Boolean(staged.sourceFile) };
      } catch (error) {
        return failure(error);
      } finally {
        // Nothing from this import is kept in memory past this point.
        for (const login of staged.logins) login.password = "";
        for (const cookie of staged.cookies) cookie.value = "";
        if (staged.sourceFile) {
          stagedFiles.set(String(data?.token ?? ""), staged.sourceFile);
          while (stagedFiles.size > 8)
            stagedFiles.delete(stagedFiles.keys().next().value as string);
        }
      }
    },
    denied,
  );

  guarded(
    IPC_CHANNELS.BROWSER_IMPORT_DELETE_FILE,
    async (data) => {
      const token = typeof data?.token === "string" ? data.token : "";
      const file = stagedFiles.get(token);
      stagedFiles.delete(token);
      if (!file) return { success: false as const, code: "not_found", error: "No file to delete." };
      const approved = await deps.confirm({
        message: "Delete the password file?",
        detail:
          "It holds your passwords in plain text. The file will be overwritten and removed. " +
          "On SSDs an overwrite can't be guaranteed, so also empty the Trash and keep disk encryption on.",
        confirmLabel: "Delete file",
      });
      if (!approved) return { success: true as const, deleted: false };
      try {
        await deps.shredFile(file);
        return { success: true as const, deleted: true };
      } catch {
        return { success: false as const, code: "failed", error: "The file could not be deleted." };
      }
    },
    denied,
  );

  guarded(
    IPC_CHANNELS.BROWSER_IMPORT_CANCEL,
    (data) => {
      sessions.cancel(data?.token);
      if (typeof data?.token === "string") stagedFiles.delete(data.token);
      return { success: true as const };
    },
    denied,
  );

  guarded(
    IPC_CHANNELS.BROWSER_VAULT_LIST,
    (data) => {
      const profile = profileOf(data);
      return profile
        ? {
            success: true as const,
            logins: vault.list(profile.profileKey),
            canStore: vault.canStore(),
          }
        : { success: false as const, logins: [], canStore: false };
    },
    () => ({ success: false as const, logins: [], canStore: false }),
  );

  guarded(
    IPC_CHANNELS.BROWSER_VAULT_FOR_PAGE,
    (data) => {
      const profile = profileOf(data);
      const url = readString(data?.url, 2048);
      if (!profile || !url) return { success: true as const, logins: [] };
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return { success: true as const, logins: [] };
      }
      return { success: true as const, logins: vault.forOrigin(profile.profileKey, origin) };
    },
    () => ({ success: false as const, logins: [] }),
  );

  guarded(
    IPC_CHANNELS.BROWSER_VAULT_REMOVE,
    (data) => {
      const profile = profileOf(data);
      const id = readString(data?.id, 80);
      return { success: Boolean(profile && id && vault.remove(profile.profileKey, id)) };
    },
    () => ({ success: false }),
  );

  guarded(
    IPC_CHANNELS.BROWSER_VAULT_CLEAR,
    async (data) => {
      const profile = profileOf(data);
      if (!profile) return { success: false as const, removed: 0 };
      const approved = await deps.confirm({
        message: "Remove all saved logins?",
        detail: "They are deleted from this app. Your other browsers are not affected.",
        confirmLabel: "Remove all",
      });
      return approved
        ? { success: true as const, removed: vault.clear(profile.profileKey) }
        : { success: false as const, removed: 0 };
    },
    () => ({ success: false as const, removed: 0 }),
  );

  guarded(
    IPC_CHANNELS.BROWSER_VAULT_FILL,
    async (data) => {
      const profile = profileOf(data);
      const id = readString(data?.id, 80);
      const taskId = readString(data?.taskId, 200);
      const sessionId = readString(data?.sessionId, 200) ?? "default";
      if (!profile || !id || !taskId)
        return { success: false as const, code: "invalid", error: "Invalid request." };
      if (now() < fillCooldownUntil || busy) {
        return { success: false as const, code: "busy", error: "Try again in a moment." };
      }
      busy = true;
      try {
        const contents = await deps.getTabContents(taskId, sessionId);
        const approved = deps.promptBiometric
          ? await deps.promptBiometric("fill a saved login").catch(() => false)
          : await deps.confirm({
              message: "Fill this saved login?",
              detail: "The username and password will be entered on the page you are viewing.",
              confirmLabel: "Fill",
            });
        if (!approved) {
          fillCooldownUntil = now() + FILL_COOLDOWN_MS;
          return { success: false as const, code: "cancelled", error: "Not approved." };
        }
        const outcome = await vault.withSecret(profile.profileKey, id, (secret) =>
          fillLogin(contents, secret, (password) =>
            registerFilledPassword(taskId, sessionId, password),
          ),
        );
        if (!outcome.ok) {
          fillCooldownUntil = now() + FILL_COOLDOWN_MS;
          return {
            success: false as const,
            code: outcome.reason,
            error: "That login can't be filled on this page.",
          };
        }
        return { success: true as const, filledUsername: outcome.filledUsername };
      } catch (error) {
        fillCooldownUntil = now() + FILL_COOLDOWN_MS;
        return failure(error);
      } finally {
        busy = false;
      }
    },
    denied,
  );
}
