import * as fs from "fs";
import * as path from "path";
import type { PermissionRule } from "../../shared/types";
import {
  normalizePermissionScope,
  permissionRuleFingerprint,
} from "./permission-utils";

const MANIFEST_RELATIVE_PATH = path.join(".cowork", "policy", "permissions.json");

export interface WorkspacePermissionManifest {
  version: 1;
  rules: PermissionRule[];
}

export function getWorkspacePermissionManifestPath(workspacePath: string): string {
  return path.join(workspacePath, MANIFEST_RELATIVE_PATH);
}

export function loadWorkspacePermissionManifest(workspacePath: string): WorkspacePermissionManifest {
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
