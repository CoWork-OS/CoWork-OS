/** Close only after the user explicitly discards edits; saving must finish first. */
export function requestArtifactClose({
  fileName,
  hasUnsavedChanges,
  saving,
  onClose,
}: {
  fileName: string;
  hasUnsavedChanges: boolean;
  saving: boolean;
  onClose: () => void;
}): void {
  if (saving) return;
  if (
    hasUnsavedChanges &&
    !window.confirm(
      `Discard unsaved changes to "${fileName}"?\nCancel keeps the editor open so you can save your changes.`,
    )
  ) {
    return;
  }
  onClose();
}
