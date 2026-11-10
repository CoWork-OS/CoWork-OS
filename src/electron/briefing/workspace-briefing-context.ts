import fs from "fs";
import path from "path";

const KIT_DIRNAME = ".cowork";

function getLocalDateStamp(now: Date): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function readText(absPath: string): string | null {
  try {
    if (!fs.existsSync(absPath)) return null;
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    const text = fs.readFileSync(absPath, "utf8");
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

function parseBulletsUnderHeading(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const target = heading.trim().toLowerCase();
  const out: string[] = [];
  let active = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      active = headingMatch[1].trim().toLowerCase() === target;
      continue;
    }
    if (!active) continue;
    const bulletMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bulletMatch) {
      out.push(bulletMatch[1].trim());
    }
  }

  return out;
}

export function readWorkspacePriorities(workspacePath?: string): string | null {
  const root = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!root) return null;
  return readText(path.join(root, KIT_DIRNAME, "PRIORITIES.md"));
}

export function readWorkspaceOpenLoops(workspacePath?: string, now = new Date()): string[] {
  const root = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!root) return [];
  const dailyLog = readText(path.join(root, KIT_DIRNAME, "memory", `${getLocalDateStamp(now)}.md`));
  if (!dailyLog) return [];
  return parseBulletsUnderHeading(dailyLog, "Open Loops");
}
