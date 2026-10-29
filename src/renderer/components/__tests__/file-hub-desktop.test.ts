import { describe, expect, it } from "vitest";
import { resolveViewerWorkspacePath } from "../FileHub";

describe("resolveViewerWorkspacePath", () => {
  it("uses the workspace root the main process listed the file under", () => {
    expect(
      resolveViewerWorkspacePath(
        {
          path: "/Users/example/project/docs/plan.md",
          metadata: { workspacePath: "/Users/example/project" },
        },
        ["/Users/example"],
      ),
    ).toBe("/Users/example/project");
  });

  it("falls back to the innermost known workspace that contains the file", () => {
    expect(
      resolveViewerWorkspacePath({ path: "/Users/example/project/docs/plan.md" }, [
        "/Users/example",
        "/Users/example/project/",
        "/Users/example/projects",
      ]),
    ).toBe("/Users/example/project/");
  });

  it("does not treat a sibling folder with a shared prefix as containing the file", () => {
    expect(
      resolveViewerWorkspacePath({ path: "/Users/example/project-two/a.txt" }, [
        "/Users/example/project",
      ]),
    ).toBe("/Users/example/project-two");
  });

  it("falls back to the file's own folder when no workspace contains it", () => {
    expect(resolveViewerWorkspacePath({ path: "/tmp/output/report.pdf" }, [])).toBe("/tmp/output");
    expect(resolveViewerWorkspacePath({ path: "C:\\work\\report.docx" }, [])).toBe("C:\\work");
    expect(resolveViewerWorkspacePath({ path: "C:\\report.docx" }, [])).toBe("C:\\");
    expect(resolveViewerWorkspacePath({ path: "report.pdf" }, [])).toBeUndefined();
  });
});
