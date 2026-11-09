import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Resolve a file below a trusted root without traversing workspace-controlled links. */
export function confinedFilePath(root: string, file: string, createParents = false): string {
  const lexicalRoot = path.resolve(root);
  const relative = path.relative(lexicalRoot, path.resolve(lexicalRoot, file));
  if (!relative || relative.split(path.sep).includes("..") || path.isAbsolute(relative)) {
    throw new Error("File is outside its root");
  }
  let current = fs.realpathSync(lexicalRoot);
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = index < segments.length - 1;
    if (!stat && parent && createParents) {
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat?.isSymbolicLink() || (stat && parent && !stat.isDirectory())) {
      throw new Error("Refusing a symbolic link or non-directory in file path");
    }
  }
  return current;
}

export function readConfinedFileSync(root: string, file: string): string {
  const target = confinedFilePath(root, file);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error("Expected a regular file");
    const before = fs.lstatSync(confinedFilePath(root, file));
    if (before.dev !== opened.dev || before.ino !== opened.ino)
      throw new Error("File changed before read");
    const text = fs.readFileSync(fd, "utf8");
    const checked = confinedFilePath(root, file);
    const current = fs.lstatSync(checked);
    if (checked !== target || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("File path changed during read");
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

export function writeConfinedFileSync(root: string, file: string, text: string): void {
  const target = confinedFilePath(root, file, true);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    if (confinedFilePath(root, file) !== target) throw new Error("File path changed during write");
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
