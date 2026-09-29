import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { HostIdentity, HostRuntimeKind } from "../../shared/host-api/contracts";

const WEB_HOST_ID_FILE = ".cowork-web-host-id";

/**
 * The browser sees this opaque ID, never the machine ID used to seal local settings.
 * Each profile has its own ID and each process start has a new generation.
 */
export async function createWebHostIdentity(options: {
  userDataDir: string;
  profileId: string;
  runtime: HostRuntimeKind;
  appVersion: string;
}): Promise<HostIdentity> {
  const installationId = await loadOrCreateWebHostId(options.userDataDir);
  return {
    installationId,
    profileId: options.profileId,
    generation: randomUUID(),
    runtime: options.runtime,
    platform: toHostPlatform(process.platform),
    appVersion: options.appVersion,
  };
}

async function loadOrCreateWebHostId(userDataDir: string): Promise<string> {
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  const idPath = path.join(userDataDir, WEB_HOST_ID_FILE);
  try {
    return parseWebHostId(await readFile(idPath, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const candidate = randomUUID();
  try {
    const handle = await open(idPath, "wx", 0o600);
    try {
      await handle.writeFile(`${candidate}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return candidate;
  } catch (error) {
    if (!isExistingFile(error)) throw error;
    return parseWebHostId(await readFile(idPath, "utf8"));
  }
}

function parseWebHostId(raw: string): string {
  const value = raw.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid browser host identity file.");
  }
  return value;
}

function toHostPlatform(value: NodeJS.Platform): HostIdentity["platform"] {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  return "other";
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}
