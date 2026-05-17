import fs from "fs";
import path from "path";
import { WORKSPACE_KIT_CONTRACTS } from "../context/kit-contracts";

export interface MemoryPressureFileStatus {
  file: "USER.md" | "MEMORY.md" | "SOUL.md";
  relPath: string;
  exists: boolean;
  charCount: number;
  maxChars: number;
  pressure: number;
  level: "ok" | "watch" | "compact";
  duplicateLineCount: number;
  recommendations: string[];
}

export interface MemoryPressureReport {
  workspacePath: string;
  files: MemoryPressureFileStatus[];
  compactRecommended: boolean;
}

const PRESSURE_FILES: MemoryPressureFileStatus["file"][] = ["USER.md", "MEMORY.md", "SOUL.md"];

function normalizeLine(line: string): string {
  return line
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function duplicateLineCount(markdown: string): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const normalized = normalizeLine(line);
    if (normalized.length < 16 || normalized.startsWith("#")) continue;
    if (seen.has(normalized)) duplicates += 1;
    else seen.add(normalized);
  }
  return duplicates;
}

function levelForPressure(pressure: number): MemoryPressureFileStatus["level"] {
  if (pressure >= 0.8) return "compact";
  if (pressure >= 0.65) return "watch";
  return "ok";
}

export class MemoryPressureService {
  static analyze(workspacePath: string): MemoryPressureReport {
    const files = PRESSURE_FILES.map((file) => this.analyzeFile(workspacePath, file));
    return {
      workspacePath,
      files,
      compactRecommended: files.some((file) => file.level === "compact"),
    };
  }

  static analyzeFile(
    workspacePath: string,
    file: MemoryPressureFileStatus["file"],
  ): MemoryPressureFileStatus {
    const relPath = path.join(".cowork", file).replace(/\\/g, "/");
    const absPath = path.join(workspacePath, ".cowork", file);
    const contract = WORKSPACE_KIT_CONTRACTS[file];
    const maxChars = Math.max(1, contract?.maxChars ?? 3000);
    let content = "";
    let exists = false;
    try {
      content = fs.readFileSync(absPath, "utf8");
      exists = true;
    } catch {
      content = "";
    }

    const charCount = content.length;
    const pressure = Math.min(1, charCount / maxChars);
    const dupes = duplicateLineCount(content);
    const level = levelForPressure(pressure);
    const recommendations: string[] = [];

    if (!exists) recommendations.push("Create the file before relying on this memory lane.");
    if (level === "compact") {
      recommendations.push("Run compaction: merge related entries and archive stale or redundant lines.");
    } else if (level === "watch") {
      recommendations.push("Review soon: this file is approaching its prompt budget.");
    }
    if (dupes > 0) {
      recommendations.push(`Remove or merge ${dupes} duplicate line(s).`);
    }

    return {
      file,
      relPath,
      exists,
      charCount,
      maxChars,
      pressure,
      level,
      duplicateLineCount: dupes,
      recommendations,
    };
  }

  static buildCompactionInstructions(report: MemoryPressureReport): string {
    const compactFiles = report.files.filter(
      (file) => file.level === "compact" || file.duplicateLineCount > 0,
    );
    if (!compactFiles.length) return "";
    return [
      "Review hot-memory pressure and propose compaction candidates only; do not rewrite files automatically.",
      ...compactFiles.map(
        (file) =>
          `- ${file.relPath}: ${Math.round(file.pressure * 100)}% full, ${file.duplicateLineCount} duplicate line(s).`,
      ),
    ].join("\n");
  }
}
