import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Entries that determine how policy paths resolve. Preserve each symlink's
 * own physical name, rather than returning only its final canonical target.
 * Missing suffix entries matter too: a future symlink must not move a policy
 * boundary after a process or bind mount has snapshotted the current target.
 */
export function collectPolicyPathEntries(workspacePath: string, rawPaths: string[]): string[] {
  const entries = new Set<string>();
  for (const rawPath of rawPaths) {
    let expanded = rawPath.trim();
    if (!expanded) throw new Error("Sandbox policy path is required");
    if (expanded === "~") expanded = os.homedir();
    else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
      expanded = path.join(os.homedir(), expanded.slice(2));
    }
    const absolute = path.resolve(workspacePath, expanded);
    let current = path.parse(absolute).root;
    let pending = absolute.slice(current.length).split(path.sep).filter(Boolean);
    let followedLinks = 0;
    while (pending.length) {
      const component = pending.shift()!;
      if (component === ".") continue;
      if (component === "..") {
        current = path.dirname(current);
        continue;
      }
      const entry = path.join(current, component);
      entries.add(entry);
      let entryStat: fs.Stats | undefined;
      try {
        entryStat = fs.lstatSync(entry);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
      if (entryStat?.isSymbolicLink()) {
        if (++followedLinks > 40)
          throw new Error("Sandbox policy path has too many symbolic links");
        const target = fs.readlinkSync(entry);
        const targetRoot = path.isAbsolute(target) ? path.parse(target).root : "";
        if (targetRoot) current = targetRoot;
        pending = [...target.slice(targetRoot.length).split(path.sep).filter(Boolean), ...pending];
      } else {
        // Existing non-link prefixes use the filesystem's spelling (notably
        // case-insensitive volumes), while a symlink's own entry stays above.
        current = entryStat ? fs.realpathSync.native(entry) : entry;
      }
    }
  }
  return [...entries];
}
