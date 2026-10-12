import { describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { filterWorkspaces } from "../WorkspaceDropdownMenu";

const workspace = (name: string, path: string) => ({ id: name, name, path }) as Workspace;

const folders = [
  workspace("cowork", "/Users/me/Downloads/app/cowork"),
  workspace("ML Pipeline", "/Users/me/work/ml"),
  workspace("docs", "/Users/me/work/handbook"),
];

describe("filterWorkspaces", () => {
  it("returns every folder for an empty or blank query", () => {
    expect(filterWorkspaces(folders, "")).toBe(folders);
    expect(filterWorkspaces(folders, "   ")).toBe(folders);
  });

  it("matches the name or the path, ignoring case and surrounding spaces", () => {
    expect(filterWorkspaces(folders, " ml ").map((w) => w.name)).toEqual(["ML Pipeline"]);
    expect(filterWorkspaces(folders, "HANDBOOK").map((w) => w.name)).toEqual(["docs"]);
  });

  it("returns nothing when no folder matches", () => {
    expect(filterWorkspaces(folders, "zzz")).toEqual([]);
  });
});
