import * as fs from "fs";
import * as path from "path";
import type { PermissionRule } from "../../shared/types";
import { normalizePermissionScope, permissionRuleFingerprint } from "./permission-utils";

const MANIFEST_RELATIVE_PATH = path.join(".cowork", "policy", "permissions.json");

export interface WorkspacePermissionManifest {
  version: 1;
  rules: PermissionRule[];
}

export function getWorkspacePermissionManifestPath(workspacePath: string): string {
  return path.join(workspacePath, MANIFEST_RELATIVE_PATH);
}

export function loadWorkspacePermissionManifest(
  workspacePath: string,
): WorkspacePermissionManifest {
  const manifestPath = getWorkspacePermissionManifestPath(workspacePath);
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as WorkspacePermissionManifest;
    return normalizeManifest(parsed);
  } catch (error: Any) {
    if (error?.code !== "ENOENT") {
      console.warn("[WorkspacePermissionManifest] Failed to load manifest:", error);
    }
    return { version: 1, rules: [] };
  }
}

/**
 * Filter manifest rules down to the ones that are safe to honor.
 *
 * The manifest is a checked-in *mirror* of the workspace's SQLite rules, which
 * makes it untrusted input: anything with workspace write access can author it
 * — including the agent itself, and including a repository the user merely
 * cloned. Honoring a permissive rule straight from the file would let a
 * prompt-injected agent grant itself `run_command` by writing one JSON file.
 *
 * Restrictive rules (`deny`, `ask`) are honored as-is: they can only narrow
 * access, so a hostile author gains nothing by adding them. A permissive
 * (`allow`) rule is honored only when an equivalent row exists in the
 * workspace database, i.e. a rule the user actually approved on this machine —
 * which is exactly what the approval flow writes alongside the manifest entry.
 *
 * Consequence for shared repositories: a teammate's `allow` rules do not take
 * effect on first clone. They re-approve once, which creates their own database
 * row and from then on the mirror matches.
 */
export function filterTrustedManifestRules(
  manifestRules: PermissionRule[],
  workspaceDbRules: PermissionRule[],
): { rules: PermissionRule[]; droppedCount: number } {
  const trusted = new Set(workspaceDbRules.map((rule) => permissionRuleFingerprint(rule)));
  const rules = manifestRules.filter(
    (rule) => rule.effect !== "allow" || trusted.has(permissionRuleFingerprint(rule)),
  );
  return { rules, droppedCount: manifestRules.length - rules.length };
}

export function appendWorkspacePermissionManifestRule(
  workspacePath: string,
  rule: PermissionRule,
): { success: boolean; manifestPath: string; error?: string } {
  const manifestPath = getWorkspacePermissionManifestPath(workspacePath);
  try {
    const current = loadWorkspacePermissionManifest(workspacePath);
    const nextRules = [...current.rules];
    const normalizedRule: PermissionRule = {
      ...rule,
      source: "workspace_manifest",
      scope: normalizePermissionScope(rule.scope),
      createdAt: rule.createdAt || Date.now(),
    };
    const fingerprint = permissionRuleFingerprint(normalizedRule);
    if (!nextRules.some((existing) => permissionRuleFingerprint(existing) === fingerprint)) {
      nextRules.push(normalizedRule);
    }
    const dir = path.dirname(manifestPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          rules: nextRules,
        } satisfies WorkspacePermissionManifest,
        null,
        2,
      ) + "\n",
      "utf8",
    );
    return { success: true, manifestPath };
  } catch (error) {
    return {
      success: false,
      manifestPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function removeWorkspacePermissionManifestRule(
  workspacePath: string,
  rule: PermissionRule,
): { success: boolean; manifestPath: string; removed: boolean; error?: string } {
  const manifestPath = getWorkspacePermissionManifestPath(workspacePath);
  try {
    const current = loadWorkspacePermissionManifest(workspacePath);
    const fingerprint = permissionRuleFingerprint(rule);
    const nextRules = current.rules.filter(
      (existing) => permissionRuleFingerprint(existing) !== fingerprint,
    );
    const removed = nextRules.length !== current.rules.length;
    if (!removed) {
      return { success: true, manifestPath, removed: false };
    }
    const dir = path.dirname(manifestPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          rules: nextRules,
        } satisfies WorkspacePermissionManifest,
        null,
        2,
      ) + "\n",
      "utf8",
    );
    return { success: true, manifestPath, removed: true };
  } catch (error) {
    return {
      success: false,
      manifestPath,
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeManifest(manifest: WorkspacePermissionManifest): WorkspacePermissionManifest {
  return {
    version: 1,
    rules: Array.isArray(manifest?.rules)
      ? manifest.rules
          .filter((rule): rule is PermissionRule => !!rule && typeof rule === "object")
          .map((rule) => ({
            ...rule,
            source: "workspace_manifest",
            scope: normalizePermissionScope(rule.scope),
            createdAt: rule.createdAt || Date.now(),
          }))
      : [],
  };
}
