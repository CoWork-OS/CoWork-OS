import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import type { Workspace } from "../../../shared/types";
import type { SandboxOptions } from "./sandbox-factory";
import { resolveAccessControlledPath } from "../../security/access-profile-paths";
import { escapeSandboxProfileString, validatePathForSandboxProfile } from "./security-utils";
import { collectPolicyPathEntries } from "./policy-paths";

/** Writable locations outside the workspace that are not policy roots. */
export interface MacOSWritableCacheRoots {
  /** Toolchain caches granted read-write (npm, go, pip, ...). */
  writableCaches?: readonly string[];
  /** Caches among those that keep a `.git` marker file in each top-level bucket (uv). */
  gitMarkerCaches?: readonly string[];
}

/**
 * Final, authoritative restrictions shared by both macOS process backends.
 * Positive grants elsewhere in a profile must not erase these boundaries.
 */
export function macOSFilesystemRestrictions(
  workspace: Workspace,
  options: SandboxOptions,
  runtimeTempDir: string,
  bounded: boolean,
  caches: MacOSWritableCacheRoots = {},
): string {
  const aliases = (rawPath: string): string[] => {
    const canonical = resolveAccessControlledPath(workspace.path, rawPath);
    validatePathForSandboxProfile(canonical);
    const paths = new Set([canonical]);
    if (canonical.startsWith("/private/var/")) paths.add(canonical.slice(8));
    if (canonical.startsWith("/var/")) paths.add(`/private${canonical}`);
    if (canonical.startsWith("/private/tmp/")) paths.add(canonical.slice(8));
    return [...paths];
  };
  const subpath = (value: string): string => `(subpath "${escapeSandboxProfileString(value)}")`;
  const union = (filters: string[]): string =>
    filters.length === 1 ? filters[0] : `(require-any ${filters.join(" ")})`;
  const rules = (workspace.permissions.accessFilesystemRules || []).map((rule) => ({
    access: rule.access,
    filter: union(aliases(rule.path).map(subpath)),
  }));
  const writeRules = rules.filter((rule) => rule.access === "write");
  let result = "\n; Authoritative filesystem policy restrictions\n(deny file-link)\n";

  // Seatbelt snapshots canonical rule targets, whereas the central evaluator
  // resolves them again for each operation. Pin the namespace used to resolve
  // those targets: replacing an existing link (including an intermediate or
  // chained link), or creating a missing prefix as a link, must not retarget
  // the policy after launch. Normal directory/file creation remains allowed.
  const policyPaths = [
    workspace.path,
    ...(workspace.permissions.accessWorkspaceRoots || []),
    ...(bounded ? [] : workspace.permissions.allowedPaths || []),
    ...(workspace.permissions.accessFilesystemRules || []).map((rule) => rule.path),
    ...(options.allowedReadPaths || []),
    ...(options.allowedWritePaths || []),
  ];
  // Renaming a directory checks the directory itself, not its descendants.
  // Otherwise moving a parent can remove a read/deny boundary, carry protected
  // git/policy data outside the workspace, or import it under an innocent name.
  // Seatbelt cannot inspect descendants atomically, so directory moves and
  // removals are denied in host roots outside the workspace. Inside the
  // workspace they are allowed when delete is on (see below). Private
  // scratch stays usable.
  const hostWriteRoots = [
    workspace.path,
    ...(workspace.permissions.accessWorkspaceRoots || []),
    ...(bounded ? [] : workspace.permissions.allowedPaths || []),
    ...(workspace.permissions.accessFilesystemRules || [])
      .filter((rule) => rule.access === "write")
      .map((rule) => rule.path),
    ...(options.allowedWritePaths || []),
    ...(bounded ? [] : [os.tmpdir(), "/private/tmp", "/private/var/folders"]),
  ];
  const writablePaths = [
    ...new Set([...hostWriteRoots.flatMap(aliases), path.resolve(workspace.path)]),
  ];
  const hostWrites = union(writablePaths.map(subpath));
  for (const entry of collectPolicyPathEntries(workspace.path, policyPaths)) {
    // Pin only entries the process could mutate. Immutable ancestors such as
    // /var -> /private/var are outside its host write grants and need no pins.
    const writable = writablePaths.some((root) => {
      const relative = path.relative(root, entry);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    });
    if (!writable) continue;
    validatePathForSandboxProfile(entry);
    let existingSymlink = false;
    try {
      existingSymlink = fs.lstatSync(entry).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    // Existing links cannot be retargeted without unlink/replacement. Only
    // missing/non-link entries need an additional create denial to prevent
    // future conversion into a symlink.
    const operations = existingSymlink
      ? "file-write-unlink"
      : "file-write-create file-write-unlink";
    result += `(deny ${operations} (require-all (vnode-type SYMLINK) (literal "${escapeSandboxProfileString(entry)}")))\n`;
  }
  const privateScratch = union(aliases(runtimeTempDir).map(subpath));
  const hostMutations = `(require-all ${hostWrites} (require-not ${privateScratch}))`;

  if (workspace.permissions.delete !== true) {
    // Without delete, nothing in a host root may be unlinked or renamed away.
    result += `(deny file-write-unlink ${hostMutations})\n`;
  } else {
    // With delete on, the workspace behaves like a normal project directory:
    // rm -r, rmdir, mv of directories, build tools that clean their output
    // directory and tools that build a directory under a temporary name and
    // rename it into place. What stays fixed:
    // - The workspace root, so the workspace cannot be moved away.
    // - Every directory on the way to a profile filesystem rule, so moving a
    //   parent cannot carry a denied or read-only subtree to a new, unruled
    //   path. (The rule targets themselves are pinned by the rules below.)
    // - Git and policy names: the regex denials below make .git and
    //   .cowork/policy immutable wherever they are reachable for writes,
    //   including after their parent directory has been moved, and no
    //   writable location (workspace, scratch, toolchain caches) can create
    //   one, so a repository cannot be assembled elsewhere and moved in.
    const workspaceRoots = [...new Set([...aliases(workspace.path), path.resolve(workspace.path)])];
    const workspaceTree = union(workspaceRoots.map(subpath));
    const pins = new Set(workspaceRoots);
    const rulePaths = (workspace.permissions.accessFilesystemRules || []).map((rule) => rule.path);
    for (const entry of collectPolicyPathEntries(workspace.path, rulePaths)) {
      if (workspaceRoots.some((root) => isWithin(root, entry))) pins.add(entry);
    }
    for (const pin of pins) {
      validatePathForSandboxProfile(pin);
      result += `(deny file-write-unlink (literal "${escapeSandboxProfileString(pin)}"))\n`;
    }
    const outsideWorkspace = `(require-all ${hostMutations} (require-not ${workspaceTree}))`;
    result += `(deny file-write-unlink (require-all (vnode-type DIRECTORY) ${outsideWorkspace}))\n`;
  }
  for (const rule of rules) {
    if (rule.access === "deny") {
      result += `(deny file-read* file-write* ${rule.filter})\n`;
    } else {
      // The central evaluator never derives a delete grant from a positive
      // read or write rule, even when the workspace delete capability is on.
      result += `(deny file-write-unlink ${rule.filter})\n`;
      if (rule.access === "read") {
        const filter = writeRules.length
          ? `(require-all ${rule.filter} (require-not ${union(writeRules.map((write) => write.filter))}))`
          : rule.filter;
        result += `(deny file-write* ${filter})\n`;
      }
    }
  }

  // Match future paths as well as existing ones, at every nesting level and
  // with the same case-insensitive segment semantics as the central evaluator.
  // Keep the pre-existing process sandbox's stronger .cowork/.env protection.
  // Scratch must reject protected names too: otherwise a process could build
  // a protected tree there and rename its innocent parent into the workspace.
  // Toolchain caches are the same kind of staging area (and a symlink in the
  // workspace could point into one), so they carry the protected-name denial
  // as well.
  const regexRoot = (root: string): string => root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const protectedNameFilter = (root: string): string => {
    const protectedSegments =
      "[.][gG][iI][tT]|[.][cC][oO][wW][oO][rR][kK]/[pP][oO][lL][iI][cC][yY]";
    const regex = `^${regexRoot(root)}/(.*/)?(${protectedSegments})(/|$)`;
    return `(regex ${JSON.stringify(regex)})`;
  };
  const protectedNameRegex = (root: string): string =>
    `(deny file-write* ${protectedNameFilter(root)})\n`;
  const markerCaches = new Set(caches.gitMarkerCaches || []);
  for (const cache of caches.writableCaches || []) {
    validatePathForSandboxProfile(cache);
    // No tool moves or removes its cache root; doing so would carry the
    // whole cache, markers included, into the workspace.
    result += `(deny file-write-unlink (literal "${escapeSandboxProfileString(cache)}"))\n`;
    if (!markerCaches.has(cache)) {
      result += protectedNameRegex(cache);
      continue;
    }
    // The only exception is the regular `.git` marker file directly inside a
    // versioned top-level bucket (sdists-v9/.git). Buckets themselves can
    // then never be moved, so a marker (whatever it is rewritten to contain)
    // never lands in the workspace as a git pointer. uv's own staging
    // directories (.tmpXXXX) do not match the bucket pattern: they stay
    // movable and cannot hold a marker.
    const bucket = `^${regexRoot(cache)}/[a-z0-9-]+-v[0-9]+`;
    const marker = `(require-all (vnode-type REGULAR-FILE) (regex ${JSON.stringify(`${bucket}/[.]git$`)}))`;
    const bucketDir = `(require-all (vnode-type DIRECTORY) (regex ${JSON.stringify(`${bucket}$`)}))`;
    result += `(deny file-write* (require-all ${protectedNameFilter(cache)} (require-not ${marker})))\n`;
    result += `(deny file-write-unlink ${bucketDir})\n`;
  }
  for (const root of [...aliases(workspace.path), ...aliases(runtimeTempDir)]) {
    result += protectedNameRegex(root);
    for (const relativePath of [
      ".git",
      ".cowork",
      ".env",
      ".env.local",
      ".env.production",
      ".env.development",
    ]) {
      result += `(deny file-write* ${subpath(path.join(root, relativePath))})\n`;
    }
  }
  return result;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
