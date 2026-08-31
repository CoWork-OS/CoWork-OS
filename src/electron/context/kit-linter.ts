import type { KitContract } from "./kit-contracts";
import type { ParsedKitDoc } from "./kit-parser";

export interface KitLintIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

function parseUpdatedDate(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function getKitDocAgeDays(doc: ParsedKitDoc, now = new Date()): number | null {
  const parsed = parseUpdatedDate(doc.meta.updated);
  if (parsed === null) return null;
  const diffMs = now.getTime() - parsed;
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

export function isKitDocStale(doc: ParsedKitDoc, contract: KitContract, now = new Date()): boolean {
  if (!contract.freshnessDays) return false;
  const ageDays = getKitDocAgeDays(doc, now);
  if (ageDays === null) return false;
  return ageDays > contract.freshnessDays;
}

export function lintKitDoc(
  doc: ParsedKitDoc,
  contract: KitContract,
  now = new Date(),
): KitLintIssue[] {
  const issues: KitLintIssue[] = [];
  const body = doc.body.toLowerCase();

  if (doc.truncated) {
    issues.push({
      level: "warning",
      code: "truncated_for_injection",
      message: `${doc.file} exceeded the prompt budget and was truncated for injection`,
    });
  }

  if (contract.freshnessDays && !doc.meta.updated) {
    issues.push({
      level: "warning",
      code: "missing_updated",
      message: `${doc.file} is missing an updated date in frontmatter`,
    });
  }

  if (contract.freshnessDays && isKitDocStale(doc, contract, now)) {
    issues.push({
      level: "warning",
      code: "stale",
      message: `${doc.file} appears stale based on its updated date`,
    });
  }

  for (const forbidden of contract.notHere) {
    if (!forbidden.trim()) continue;
    if (body.includes(forbidden.toLowerCase())) {
      issues.push({
        level: "warning",
        code: "possible_overlap",
        message: `${doc.file} may contain content that belongs elsewhere: ${forbidden}`,
      });
    }
  }

  if (doc.file === "ACCESS.md" || doc.file === "TOOLS.md") {
    const secretPatterns = [
      /api[_-]?key/i,
      /secret/i,
      /password/i,
      /bearer\s+[a-z0-9\-_.]+/i,
      /sk-[a-z0-9]/i,
      /ghp_[a-z0-9]/i,
    ];

    for (const pattern of secretPatterns) {
      if (pattern.test(doc.rawBody)) {
        issues.push({
          level: "error",
          code: "possible_secret",
          message: `${doc.file} appears to contain a secret or credential`,
        });
        break;
      }
    }
  }

  return issues;
}
