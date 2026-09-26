import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const RELEASE_BRIEF_ID = "release-brief-v1";
const INPUT_HASHES = {
  "brief-instructions.md": "b4cac1e4f04fb9dde6bb0a638a6208dc11bf4a878f81cf6b791964bf0384c008",
  "issues.csv": "11d465c7964dea05a26ffffd2ffa0a4d4bf0c75ddc94dfae6f464b0e09612282",
  "release-notes.md": "87c0af4533e5fee823b47d3a89e7ae3f93774f27c20f5d79f9c7007ecf408872",
} as const;
const OUTPUTS = ["issues-clean.csv", "summary.json", "release-brief.html"] as const;
const HEADER = "id,title,status,priority,release_blocker,owner";

export type ReleaseBriefCheck = {
  missionId: typeof RELEASE_BRIEF_ID;
  passed: boolean;
  checks: string[];
  errors: string[];
  artifactHashes: Record<string, string>;
};

const sha256 = (content: Buffer | string): string =>
  createHash("sha256").update(content).digest("hex");

async function readRegularFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error(`Unsafe or oversized file: ${path.basename(filePath)}`);
  }
  const data = await fs.readFile(filePath);
  if (data.length > maxBytes) throw new Error(`Oversized file: ${path.basename(filePath)}`);
  return data;
}

function parsePlainCsv(content: string): string[][] {
  // This mission deliberately uses a small, unquoted CSV schema. Reject an
  // unsupported dialect rather than silently checking the wrong columns.
  const lines = content.trimEnd().split(/\r?\n/);
  if (lines[0] !== HEADER || lines.some((line) => /["\r]/.test(line))) {
    throw new Error("CSV header or dialect changed");
  }
  const rows = lines.slice(1).map((line) => line.split(","));
  if (rows.some((row) => row.length !== 6)) throw new Error("CSV column count changed");
  return rows;
}

function sameSet(actual: unknown, expected: string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.every((item) => typeof item === "string") &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

function checkHtml(
  html: string,
  blockerIds: string[],
  ownerlessIds: string[],
  sourceIds: string[],
): string[] {
  const errors: string[] = [];
  if (
    !/<!doctype html>/i.test(html) ||
    !/<html\b/i.test(html) ||
    !/<body\b/i.test(html) ||
    !/<h1\b/i.test(html)
  ) {
    errors.push("HTML is missing a document, body, or title heading");
  }
  if (
    /<\s*\/?\s*(?:script|iframe|object|embed|form|input|button|meta|link|base|svg|math|video|audio|img|canvas|template)\b/i.test(
      html,
    ) ||
    /\bon\w+\s*=/i.test(html) ||
    /(?:href|src|action|formaction)\s*=/i.test(html) ||
    // Only data: URIs ("data:image/png"), not prose such as "Source data: issues.csv".
    /(?:url\s*\(|@import|javascript:|\bdata:[a-z]+\/[a-z0-9.+-]+|https?:\/\/|file:\/\/|<\s*\?xml)/i.test(
      html,
    )
  ) {
    errors.push("HTML contains active content, links, or external resources");
  }
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const reportedIds = [...text.matchAll(/\bAST-\d+\b/g)].map((match) => match[0]);
  if (reportedIds.some((id) => !sourceIds.includes(id)))
    errors.push("HTML mentions an issue ID absent from the source");
  // Strict patterns name the count unambiguously, so every match must equal the
  // source. Loose patterns ("12 issues") also match subsets ("3 issues block the
  // release"), so they can supply the expected value but never fail the check.
  for (const [label, expected, strictPatterns, loosePatterns] of [
    [
      "total issues",
      12,
      [
        /(?:total(?: unique)? issues?|issues total)\s*[:\-]?\s*(\d+)/gi,
        /(\d+)\s+(?:total|unique)\s+issues\b/gi,
      ],
      [/(\d+)\s+issues\b/gi],
    ],
    [
      "open issues",
      7,
      [/\bopen(?: issues)?\s*[:\-]\s*(\d+)/gi, /(\d+)\s+open(?: issues)?(?=\s*(?:[,.;:]|$))/gi],
      [],
    ],
    [
      "closed issues",
      5,
      [/\bclosed(?: issues)?\s*[:\-]\s*(\d+)/gi, /(\d+)\s+closed(?: issues)?(?=\s*(?:[,.;:]|$))/gi],
      [],
    ],
  ] as const) {
    const valuesFor = (patterns: readonly RegExp[]) =>
      patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => Number(match[1])));
    const strictValues = valuesFor(strictPatterns);
    const looseValues = valuesFor(loosePatterns);
    if (
      ![...strictValues, ...looseValues].includes(expected) ||
      strictValues.some((value) => value !== expected)
    ) {
      errors.push(`HTML ${label} count does not match the source`);
    }
  }
  for (const fact of [
    "Aster Notes",
    ...blockerIds,
    ...ownerlessIds,
    "release-notes.md",
    "issues.csv",
  ]) {
    if (!text.includes(fact)) errors.push(`HTML is missing source fact: ${fact}`);
  }
  return errors;
}

/** Trusted checker: call only for a workspace created by the first-task service. */
export async function verifyReleaseBrief(workspacePath: string): Promise<ReleaseBriefCheck> {
  const result: ReleaseBriefCheck = {
    missionId: RELEASE_BRIEF_ID,
    passed: false,
    checks: [],
    errors: [],
    artifactHashes: {},
  };
  const workspaceStat = await fs.lstat(workspacePath).catch(() => null);
  if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink()) {
    result.errors.push("Missing or unsafe sample workspace");
    return result;
  }
  const root = await fs.realpath(workspacePath);
  const outputDir = path.join(root, "outputs");
  const outputStat = await fs.lstat(outputDir).catch(() => null);
  if (!outputStat?.isDirectory() || outputStat.isSymbolicLink()) {
    result.errors.push("Missing or unsafe outputs directory");
    return result;
  }

  for (const [name, expectedHash] of Object.entries(INPUT_HASHES)) {
    try {
      const content = await readRegularFile(path.join(root, name), 64 * 1024);
      if (sha256(content) !== expectedHash) result.errors.push(`Sample input changed: ${name}`);
    } catch {
      result.errors.push(`Sample input missing or unsafe: ${name}`);
    }
  }
  if (result.errors.length) return result;
  result.checks.push("Sample inputs match the packaged fixture");

  const sourceRows = parsePlainCsv(
    (await readRegularFile(path.join(root, "issues.csv"), 64 * 1024)).toString("utf8"),
  );
  const uniqueRows = [...new Map(sourceRows.map((row) => [row[0], row])).values()];
  const open = uniqueRows.filter((row) => row[2] === "open");
  const closed = uniqueRows.filter((row) => row[2] === "closed");
  const blockerIds = open
    .filter((row) => row[4] === "yes")
    .map((row) => row[0])
    .sort();
  const ownerlessIds = open
    .filter((row) => row[5] === "")
    .map((row) => row[0])
    .sort();
  if (
    sourceRows.length !== 13 ||
    uniqueRows.length !== 12 ||
    open.length !== 7 ||
    closed.length !== 5 ||
    blockerIds.length !== 3 ||
    ownerlessIds.length !== 2
  ) {
    result.errors.push("Packaged fixture facts do not match the mission contract");
    return result;
  }

  const files: Record<string, string> = {};
  for (const name of OUTPUTS) {
    try {
      const content = await readRegularFile(path.join(outputDir, name), 256 * 1024);
      files[name] = content.toString("utf8");
      result.artifactHashes[name] = sha256(content);
    } catch {
      result.errors.push(`Missing or unsafe output: ${name}`);
    }
  }
  if (result.errors.length) return result;

  try {
    const cleanedRows = parsePlainCsv(files["issues-clean.csv"]);
    if (
      cleanedRows.length !== 12 ||
      cleanedRows.some((row, index) => JSON.stringify(row) !== JSON.stringify(uniqueRows[index]))
    ) {
      result.errors.push("Cleaned CSV does not preserve the twelve unique source rows in order");
    } else result.checks.push("Duplicate removed and source facts preserved");
  } catch {
    result.errors.push("Cleaned CSV cannot be parsed");
  }

  try {
    const summary = JSON.parse(files["summary.json"]);
    if (
      summary?.totalIssues !== 12 ||
      summary?.openIssues !== 7 ||
      summary?.closedIssues !== 5 ||
      !sameSet(summary?.openBlockerIds, blockerIds) ||
      !sameSet(summary?.openOwnerlessIds, ownerlessIds)
    ) {
      result.errors.push("Summary JSON counts or issue IDs differ from the source");
    } else result.checks.push("Structured summary matches source counts and issue IDs");
  } catch {
    result.errors.push("Summary JSON cannot be parsed");
  }

  result.errors.push(
    ...checkHtml(
      files["release-brief.html"],
      blockerIds,
      ownerlessIds,
      uniqueRows.map((row) => row[0]),
    ),
  );
  if (!result.errors.length)
    result.checks.push("HTML has required facts and no active or remote content");
  result.passed = result.errors.length === 0;
  return result;
}

export function releaseBriefInputHashes(): Readonly<Record<string, string>> {
  return INPUT_HASHES;
}
