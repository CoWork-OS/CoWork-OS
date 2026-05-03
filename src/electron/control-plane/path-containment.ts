import path from "node:path";

export function resolvePathWithinRoot(rootPath: string, requestedPath: string): string | null {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(path.join(resolvedRoot, requestedPath));
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return resolvedPath;
  }

  return null;
}
