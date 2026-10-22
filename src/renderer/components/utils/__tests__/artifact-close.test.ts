import { afterEach, describe, expect, it, vi } from "vitest";
import { requestArtifactClose } from "../artifact-close";

afterEach(() => vi.unstubAllGlobals());

describe("artifact close protection", () => {
  it.each([false, true])("keeps the editor mounted while saving, dirty=%s", (hasUnsavedChanges) => {
    const confirm = vi.fn().mockReturnValue(true);
    const onClose = vi.fn();
    vi.stubGlobal("window", { confirm });
    requestArtifactClose({ fileName: "notes.docx", hasUnsavedChanges, saving: true, onClose });
    expect(onClose).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([false, true])("respects the discard decision for document edits: %s", (discard) => {
    const confirm = vi.fn().mockReturnValue(discard);
    const onClose = vi.fn();
    vi.stubGlobal("window", { confirm });
    requestArtifactClose({
      fileName: "notes.docx",
      hasUnsavedChanges: true,
      saving: false,
      onClose,
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("notes.docx"));
    expect(onClose).toHaveBeenCalledTimes(discard ? 1 : 0);
  });
});
