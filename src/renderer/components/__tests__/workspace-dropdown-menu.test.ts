import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Workspace } from "../../../shared/types";
import { WorkspaceDropdownMenu } from "../MainContent/WorkspaceDropdownMenu";

const workspace = (id: string, name: string) =>
  ({ id, name, path: `/tmp/${name}`, createdAt: 0, permissions: {} }) as unknown as Workspace;

const render = (props: Partial<React.ComponentProps<typeof WorkspaceDropdownMenu>>) =>
  renderToStaticMarkup(
    React.createElement(WorkspaceDropdownMenu, {
      workspaces: [workspace("a", "cowork"), workspace("b", "LaTeX PDFs")],
      currentWorkspaceId: "a",
      onSelect: () => {},
      onSelectNewFolder: () => {},
      ...props,
    }),
  );

describe("WorkspaceDropdownMenu", () => {
  it("offers removal for every folder except the current one", () => {
    const html = render({ onRemove: async () => {} });
    expect(html).toContain('aria-label="Remove LaTeX PDFs from CoWork"');
    expect(html).not.toContain('aria-label="Remove cowork from CoWork"');
  });

  it("shows no remove buttons when removal is not offered", () => {
    expect(render({})).not.toContain("workspace-dropdown-remove");
  });

  it("lists the footer actions, scratch work only when allowed", () => {
    expect(render({})).not.toContain("Work without a folder");
    const html = render({ onUseTempWorkspace: () => {} });
    expect(html).toContain("Work in another folder...");
    expect(html).toContain("Work without a folder");
  });
});
