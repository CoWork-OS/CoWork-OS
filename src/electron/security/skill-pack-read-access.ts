/**
 * Read-only access to an applied directory-backed skill's own plugin pack.
 *
 * A directory-backed pack skill (a `skillDirectories` entry in `cowork.plugin.json`) is a
 * SKILL.md that tells the agent to read its references, scripts and assets next to it. Packs
 * live outside the workspace, so under a named access profile those reads would stop at the
 * workspace boundary. `evaluateWorkspaceFilesystemAccess` therefore allows a READ under a
 * pack's root when, and only when:
 *  - the PluginRegistry loaded and registered that pack and built the skill from it
 *    (`registerSkillPackRoot`); disabled, failed, quarantined and uninstalled packs are never
 *    registered, and disabling a pack revokes the grant immediately;
 *  - the current tool call runs inside a task scope that applied that skill
 *    (`runWithSkillPackReadAccess`, opened by the executor around each tool call, the same
 *    way as the memory repo scope); the grant ends with the task's executor;
 *  - the real (canonical) target is inside the pack root as it was canonicalized when the
 *    pack loaded, so a symlink inside the pack cannot reach anything outside it.
 *
 * Writes and deletes are never granted here, and a profile deny rule still wins because the
 * evaluator checks it first. Outside a scope (IPC handlers, background services) nothing is
 * granted: fail closed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import type { CustomSkill } from "../../shared/types";
import { getUserDataDir } from "../utils/user-data-dir";

/** One applied skill's read grant: its pack and that pack's canonical root at grant time. */
export interface SkillPackReadGrant {
  pluginName: string;
  canonicalRoot: string;
}

interface RegisteredSkillPack {
  /** Lexical, absolute root as the registry loaded it. */
  root: string;
  /** Canonical root captured at registration; later symlink swaps cannot move it. */
  canonicalRoot: string;
  /** SKILL.md files the registry built directory-backed skills from (lexical, absolute). */
  skillFiles: Set<string>;
}

const registeredPacks = new Map<string, RegisteredSkillPack>();
const accessScope = new AsyncLocalStorage<readonly SkillPackReadGrant[]>();

/** Lexical containment of two absolute, already normalized paths. */
function isWithin(parent: string, candidate: string): boolean {
  const relative = nodePath.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

/** Real path of an existing directory, or null. Kept local: access-profile-paths imports us. */
function realDirectory(dir: string): string | null {
  try {
    const real = nodeFs.realpathSync.native(dir);
    return nodeFs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * A pack root that is a filesystem root or contains the home folder or CoWork's own data
 * folder would turn a skill grant into a read of arbitrary user files. Such a layout is never
 * produced by pack discovery; refuse it anyway.
 */
function isUnsafePackRoot(canonicalRoot: string): boolean {
  if (nodePath.dirname(canonicalRoot) === canonicalRoot) return true;
  const sensitive = [nodeOs.homedir()];
  try {
    sensitive.push(getUserDataDir());
  } catch {
    // Without a resolvable data folder the home-folder check still applies.
  }
  return sensitive
    .filter(Boolean)
    .flatMap((dir) => [nodePath.resolve(dir), realDirectory(dir)])
    .some((dir) => Boolean(dir) && isWithin(canonicalRoot, dir as string));
}

/**
 * Register a loaded pack whose directory-backed skills may read its root. Called by the
 * PluginRegistry after it registered at least one such skill. Returns false (and registers
 * nothing) for an unsafe root or when no skill file is inside the root.
 */
export function registerSkillPackRoot(
  pluginName: string,
  pluginRoot: string,
  skillFiles: readonly string[],
): boolean {
  const name = typeof pluginName === "string" ? pluginName.trim() : "";
  if (!name || typeof pluginRoot !== "string" || !pluginRoot.trim()) return false;
  const root = nodePath.resolve(pluginRoot);
  const canonicalRoot = realDirectory(root);
  const files = skillFiles
    .filter((file): file is string => typeof file === "string" && file.trim().length > 0)
    .map((file) => nodePath.resolve(file))
    .filter((file) => file !== root && isWithin(root, file));
  if (!canonicalRoot || files.length === 0 || isUnsafePackRoot(canonicalRoot)) {
    registeredPacks.delete(name);
    return false;
  }
  registeredPacks.set(name, { root, canonicalRoot, skillFiles: new Set(files) });
  return true;
}

/** Drop a pack's grants (pack disabled, reloaded, failed or uninstalled). */
export function unregisterSkillPackRoot(pluginName: string): void {
  registeredPacks.delete(pluginName);
}

/** The registered pack root (lexical) for a plugin, or null. */
export function getRegisteredSkillPackRoot(pluginName: string): string | null {
  return registeredPacks.get(pluginName)?.root ?? null;
}

/**
 * The read grant for a skill as the skill loader currently holds it, or null. Only the exact
 * directory-backed skill the registry built qualifies: a workspace or user skill that shadows
 * the id, an inline pack skill, or a skill whose metadata merely names a pack gets nothing.
 */
export function resolveSkillPackReadGrant(
  skill: Pick<CustomSkill, "source" | "filePath" | "metadata"> | null | undefined,
): SkillPackReadGrant | null {
  if (!skill || skill.source !== "managed") return null;
  const pluginName = skill.metadata?.pluginSource;
  if (typeof pluginName !== "string" || !pluginName) return null;
  const pack = registeredPacks.get(pluginName);
  if (!pack || typeof skill.filePath !== "string" || !skill.filePath) return null;
  if (!pack.skillFiles.has(nodePath.resolve(skill.filePath))) return null;
  return { pluginName, canonicalRoot: pack.canonicalRoot };
}

/** Run `fn` (one tool call) with the read grants of the task's applied pack skills. */
export function runWithSkillPackReadAccess<T>(
  grants: readonly (SkillPackReadGrant | null | undefined)[],
  fn: () => T,
): T {
  const unique = new Map<string, SkillPackReadGrant>();
  for (const grant of grants) {
    if (grant && typeof grant.pluginName === "string" && typeof grant.canonicalRoot === "string") {
      unique.set(`${grant.pluginName}\0${grant.canonicalRoot}`, {
        pluginName: grant.pluginName,
        canonicalRoot: grant.canonicalRoot,
      });
    }
  }
  return accessScope.run([...unique.values()], fn);
}

/** Pack roots the current tool call may read (still registered, unchanged since granted). */
export function getSkillPackReadRoots(): string[] {
  const grants = accessScope.getStore() || [];
  return grants
    .filter((grant) => registeredPacks.get(grant.pluginName)?.canonicalRoot === grant.canonicalRoot)
    .map((grant) => grant.canonicalRoot);
}

/**
 * Whether the current tool call may read `canonicalPath` as an applied skill's pack file.
 * Both the path as written and its real target must be inside the pack, so neither a symlink
 * inside the pack nor one pointing into it widens what the grant covers.
 */
export function isSkillPackReadAllowed(lexicalPath: string, canonicalPath: string): boolean {
  const grants = accessScope.getStore();
  if (!grants || grants.length === 0) return false;
  const lexical = nodePath.resolve(lexicalPath);
  return grants.some((grant) => {
    const pack = registeredPacks.get(grant.pluginName);
    if (!pack || pack.canonicalRoot !== grant.canonicalRoot) return false;
    if (!isWithin(pack.canonicalRoot, canonicalPath)) return false;
    return isWithin(pack.root, lexical) || isWithin(pack.canonicalRoot, lexical);
  });
}
