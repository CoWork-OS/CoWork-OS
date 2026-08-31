import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Workspace } from "../../../../shared/types";
import { SkillTools } from "../skill-tools";

describe("SkillTools access profile boundaries", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let in-place document edits turn a read grant into a write grant", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-tools-"));
    tempDirs.push(directory);
    const documentPath = path.join(directory, "source.docx");
    fs.writeFileSync(documentPath, "placeholder");

    const workspace: Workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: directory,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        accessFilesystemRules: [{ path: documentPath, access: "read" }],
      },
    };
    const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");

    await expect(
      tools.editDocument({
        sourcePath: "source.docx",
        action: "append",
        newContent: [{ type: "paragraph", text: "new content" }],
      }),
    ).rejects.toThrow(/active access profile/i);
  });
});
