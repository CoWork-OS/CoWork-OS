import * as fs from "fs";
import * as path from "path";

/** Persist serialized pack state through the legacy file fallback. */
export function writePackStateFile(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(filePath, contents, "utf-8");
}
