import { Code2, ExternalLink, FileDiff } from "lucide-react";
import type { FileInfo } from "../../utils/task-event-derived";

/** The page to preview: the latest written index.html, else any HTML file. */
export function pickBuildPreviewPath(files: FileInfo[]): string | null {
  const html = files.filter((file) => file.action !== "deleted" && /\.html?$/i.test(file.path));
  if (html.length === 0) return null;
  const byRecency = [...html].sort((a, b) => b.timestamp - a.timestamp);
  return (byRecency.find((file) => /(^|[\\/])index\.html?$/i.test(file.path)) ?? byRecency[0]).path;
}

/** Marks a run in the status strip as a build. */
export function BuildStripBadge() {
  return (
    <span className="build-strip-badge">
      <Code2 size={12} aria-hidden="true" />
      build
    </span>
  );
}

/** Opens the page the build wrote, as soon as there is one. */
export function BuildPreviewButton({
  path,
  onOpen,
}: {
  path: string;
  onOpen: (path: string) => void;
}) {
  const name = path.split(/[\\/]/).pop() || path;
  return (
    <button
      type="button"
      className="build-strip-preview"
      onClick={() => onOpen(path)}
      title={`Preview ${name}`}
    >
      <ExternalLink size={12} aria-hidden="true" />
      Preview
    </button>
  );
}

/** Opens the build's Changes pane. */
export function BuildChangesButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="build-strip-preview"
      onClick={onOpen}
      title="Review the files this build changed"
    >
      <FileDiff size={12} aria-hidden="true" />
      Changes
      <span className="build-strip-count">{count}</span>
    </button>
  );
}
