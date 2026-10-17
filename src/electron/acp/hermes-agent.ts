/**
 * A local Hermes Agent install as an ACP agent (docs/acp-acpx-integration.md).
 *
 * Hermes speaks the Agent Client Protocol over stdio with `hermes acp`. CoWork runs it
 * through the acpx runtime (`acpx --agent "<hermes> acp" ...`), so a Hermes task gets the
 * same treatment as any other external runtime: bounded access profiles reject it before
 * the process starts, and acpx's permission mode decides what Hermes may do unasked.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ACPAgentCard } from "./types";

export const HERMES_ACP_AGENT_ID = "runtime:hermes";

export interface HermesLocateOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  isFile?: (file: string) => boolean;
}

function defaultIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The `hermes` executable: HERMES_BIN, then PATH, then the installer's locations
 * (~/.local/bin/hermes, the virtualenv under the Hermes home). Null when not installed.
 */
export function findHermesExecutable(options: HermesLocateOptions = {}): string | null {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const windows = platform === "win32";
  const names = windows ? ["hermes.exe", "hermes.cmd"] : ["hermes"];

  const explicit = env.HERMES_BIN?.trim();
  if (explicit) return isFile(explicit) ? explicit : null;

  const pathDirs = String(env.PATH || env.Path || "")
    .split(windows ? ";" : ":")
    .filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }

  const hermesHome =
    env.HERMES_HOME?.trim() ||
    (windows && env.LOCALAPPDATA?.trim()
      ? path.join(env.LOCALAPPDATA.trim(), "hermes")
      : path.join(homedir, ".hermes"));
  const candidates = windows
    ? [path.join(hermesHome, "hermes-agent", "venv", "Scripts", "hermes.exe")]
    : [
        path.join(homedir, ".local", "bin", "hermes"),
        path.join(hermesHome, "hermes-agent", "venv", "bin", "hermes"),
      ];
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

/**
 * The command acpx starts for Hermes, as one string (acpx splits it itself, honouring
 * quotes, without a shell). Null when Hermes is not installed.
 */
export function hermesAcpCommand(options: HermesLocateOptions = {}): string | null {
  const executable = findHermesExecutable(options);
  if (!executable) return null;
  const quoted = /[\s"'\\]/.test(executable) ? JSON.stringify(executable) : executable;
  return `${quoted} acp`;
}

/** The ACP card for a local Hermes install, or null when Hermes is not installed. */
export function hermesAgentCard(options: HermesLocateOptions = {}): ACPAgentCard | null {
  if (!findHermesExecutable(options)) return null;
  const now = Date.now();
  return {
    id: HERMES_ACP_AGENT_ID,
    name: "Hermes Agent",
    description:
      "Your local Hermes Agent install, run over the Agent Client Protocol with its own memory, skills and model.",
    version: "1.0.0",
    provider: "Hermes Agent (local install)",
    capabilities: [
      { id: "general", name: "General" },
      { id: "code", name: "Code" },
      { id: "research", name: "Research" },
    ],
    origin: "local",
    externalRuntimeAgent: "hermes",
    registeredAt: now,
    lastActiveAt: now,
    status: "available",
  };
}
