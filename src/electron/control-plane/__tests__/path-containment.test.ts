import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePathWithinRoot } from "../path-containment";

describe("resolvePathWithinRoot", () => {
  it("resolves workspace-relative paths inside the root", () => {
    const root = path.join(path.sep, "tmp", "work");

    expect(resolvePathWithinRoot(root, "src/index.ts")).toBe(
      path.join(path.sep, "tmp", "work", "src", "index.ts"),
    );
  });

  it("allows the workspace root itself", () => {
    const root = path.join(path.sep, "tmp", "work");

    expect(resolvePathWithinRoot(root, ".")).toBe(root);
  });

  it("rejects sibling paths that share the root prefix", () => {
    const root = path.join(path.sep, "tmp", "work");

    expect(resolvePathWithinRoot(root, "../work-secrets")).toBeNull();
  });

  it("does not reject same-prefix descendants inside the root", () => {
    const root = path.join(path.sep, "tmp", "work");

    expect(resolvePathWithinRoot(root, "work-secrets/file.txt")).toBe(
      path.join(path.sep, "tmp", "work", "work-secrets", "file.txt"),
    );
  });
});
