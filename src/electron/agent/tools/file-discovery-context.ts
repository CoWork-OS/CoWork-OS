import {
  getMemoryRepoRoot,
  getTeamMemoryRepoRoots,
  isMemoryRepoReadAllowed,
  getMemoryRepoSwarmReadPrefix,
  getMemoryRepoBotFile,
  setMemoryRepoRoot,
  setTeamMemoryRepoRoots,
  runWithMemoryRepoAccess,
} from "../../security/memory-repo-access";
import {
  getSkillPackReadSnapshot,
  registerSkillPackRoot,
  runWithSkillPackReadAccess,
} from "../../security/skill-pack-read-access";
import * as path from "node:path";

/** Snapshot only the current tool call's read authority, never process-wide task grants. */
export function captureDiscoveryContext() {
  return {
    memoryRoot: getMemoryRepoRoot(),
    teamRoots: getTeamMemoryRepoRoots(),
    memoryScope: {
      readAllowed: isMemoryRepoReadAllowed(),
      swarmPrefix: getMemoryRepoSwarmReadPrefix(),
      botFile: getMemoryRepoBotFile(),
    },
    skillGrants: getSkillPackReadSnapshot(),
  };
}
export type DiscoveryContext = ReturnType<typeof captureDiscoveryContext>;

/** Called in a fresh, single-request worker; no authority survives its termination. */
export function runWithDiscoveryContext<T>(context: DiscoveryContext, fn: () => T): T {
  setMemoryRepoRoot(context.memoryRoot);
  setTeamMemoryRepoRoots(context.teamRoots);
  const grants = context.skillGrants.map((grant) => {
    // Registration rechecks the real root. A swapped symlink cannot inherit the snapshot grant.
    registerSkillPackRoot(grant.pluginName, grant.root, [path.join(grant.root, "SKILL.md")]);
    return grant;
  });
  return runWithMemoryRepoAccess(context.memoryScope, () => runWithSkillPackReadAccess(grants, fn));
}
