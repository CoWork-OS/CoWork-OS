import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function pinProjectRoot(configuredRoot: string): () => string {
  const root = fs.realpathSync(configuredRoot);
  const initial = fs.lstatSync(root);
  if (!initial.isDirectory()) throw new Error("Expected a project root directory");
  return () => {
    const current = fs.lstatSync(root);
    if (
      current.isSymbolicLink() ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      fs.realpathSync(root) !== root
    ) {
      throw new Error("Project root changed");
    }
    return root;
  };
}

/** Project paths may use a root alias, but never links inside that root. */
export function projectPath(root: string, value: string, createDirectory = false): string {
  const relative = path.relative(path.resolve(root), path.resolve(root, value));
  if (path.isAbsolute(relative) || relative.split(path.sep).includes(".."))
    throw new Error("Path must stay inside project root");
  let current = fs.realpathSync(root);
  if (!relative) return current;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) throw new Error("Refusing project symbolic link");
    if (createDirectory) {
      if (!stat) fs.mkdirSync(current);
      else if (!stat.isDirectory()) throw new Error("Expected a project directory");
    }
  }
  return current;
}

export function writeProjectOutput(root: string, file: string, data: Uint8Array): string {
  projectPath(root, path.dirname(file), true);
  const target = projectPath(root, file);
  const temp = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    if (projectPath(root, file) !== target) throw new Error("Project path changed");
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}
