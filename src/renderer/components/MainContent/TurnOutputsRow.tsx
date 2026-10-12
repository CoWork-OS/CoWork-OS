import { FileChipIcon } from "../markdown-components";
import { useFileActionMenu } from "../FileActionMenu";
import type { TurnOutputFile } from "./turn-outputs";

const MAX_VISIBLE_FILES = 3;

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

export function describeTurnOutputs(files: TurnOutputFile[]): string {
  const count = files.length;
  const noun = count === 1 ? "file" : "files";
  return files.every((file) => file.action === "updated")
    ? `Updated ${count} ${noun}`
    : `Created ${count} ${noun}`;
}

/**
 * The single end-of-turn line listing the files a turn wrote. Each file opens in the side
 * panel (right-click for other apps or Finder); "View all" opens the Files list.
 */
export function TurnOutputsRow({
  files,
  workspacePath,
  onOpenFile,
  onViewAll,
}: {
  files: TurnOutputFile[];
  workspacePath: string;
  onOpenFile: (path: string) => void;
  onViewAll?: (primaryPath: string) => void;
}) {
  const { openFileActionMenu, menu } = useFileActionMenu({
    workspacePath,
    onOpenInPanel: onOpenFile,
  });
  if (files.length === 0) return null;
  const visibleFiles = files.slice(0, MAX_VISIBLE_FILES);
  const hiddenCount = files.length - visibleFiles.length;

  return (
    <div className="turn-outputs" role="group" aria-label="Files from this turn">
      <span className="turn-outputs-label">{describeTurnOutputs(files)}</span>
      <span className="turn-outputs-files">
        {visibleFiles.map((file) => (
          <button
            key={file.path}
            type="button"
            className="turn-outputs-file"
            onClick={() => onOpenFile(file.path)}
            onContextMenu={(event) => openFileActionMenu(event, file.path)}
            title={`${file.path}\n\nClick to open - Right-click for more options`}
          >
            <FileChipIcon filePath={file.path} />
            <span className="turn-outputs-file-name">{getFileName(file.path)}</span>
          </button>
        ))}
        {hiddenCount > 0 && <span className="turn-outputs-more">+{hiddenCount} more</span>}
      </span>
      {onViewAll && (
        <button
          type="button"
          className="turn-outputs-view-all"
          onClick={() => onViewAll(files[0].path)}
        >
          View all
        </button>
      )}
      {menu}
    </div>
  );
}
