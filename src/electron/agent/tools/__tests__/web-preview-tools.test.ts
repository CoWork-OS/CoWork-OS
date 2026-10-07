import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { TOOL_GROUPS, TOOL_RISK_LEVELS } from "../../../../shared/types";
import { WebPreviewTools, parseWebPreviewActions } from "../web-preview-tools";

const dirs: string[] = [];
function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-preview-tools-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hi</h1>");
  fs.writeFileSync(path.join(dir, "notes.txt"), "text");
  return {
    id: "ws",
    name: "ws",
    path: dir,
    createdAt: 0,
    permissions: { read: true, write: true, delete: false, network: false, shell: false },
  } as Workspace;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("WebPreviewTools", () => {
  it("is unavailable in Node-only runtimes and reports the required runtime clearly", async () => {
    expect(WebPreviewTools.isAvailable()).toBe(false);
    await expect(
      new WebPreviewTools(makeWorkspace()).execute("preview_web_page", {
        path: "index.html",
      }),
    ).rejects.toThrow(/requires the Electron desktop runtime/);
  });

  it.each([
    ['<link rel="stylesheet" href="secret.txt">', false],
    ['<script src="secret.txt"></script>', false],
    ['<link rel="stylesheet" href="alias.css?version=1#style">', true],
  ])("rejects denied dependency content: %s", async (html, alias) => {
    const workspace = makeWorkspace();
    const secret = path.join(workspace.path, "secret.txt");
    fs.writeFileSync(secret, "DENIED_FILE_CONTENT");
    workspace.permissions.accessFilesystemRules = [{ path: secret, access: "deny" }];
    if (alias) fs.symlinkSync(secret, path.join(workspace.path, "alias.css"));
    fs.writeFileSync(path.join(workspace.path, "index.html"), html);
    await expect(
      new WebPreviewTools(workspace).execute("preview_web_page", {
        path: "index.html",
      }),
    ).rejects.toThrow(/profile_filesystem_denied/);
  });

  it.each([false, true])("rejects project-denied dependencies (symlink=%s)", async (alias) => {
    const workspace = makeWorkspace();
    const project = path.join(workspace.path, ".cowork/projects/private");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "ACCESS.md"), "## Deny\n- role: reviewer\n");
    fs.writeFileSync(path.join(project, "secret.js"), "document.body.textContent = 'PRIVATE';");
    if (alias) fs.symlinkSync(path.join(project, "secret.js"), path.join(workspace.path, "app.js"));
    fs.writeFileSync(
      path.join(workspace.path, "index.html"),
      `<script src="${alias ? "app.js" : ".cowork/projects/private/secret.js"}"></script>`,
    );
    const tools = new WebPreviewTools(
      workspace,
      { getTask: () => ({ assignedAgentRoleId: "reviewer" }) } as Any,
      "task-1",
    );
    await expect(tools.execute("preview_web_page", { path: "index.html" })).rejects.toThrow(
      /Denied by ACCESS.md/,
    );
  });

  it("authorizes package discovery before reading it", async () => {
    const workspace = makeWorkspace();
    const packagePath = path.join(workspace.path, "package.json");
    fs.writeFileSync(packagePath, '{"dependencies":{"react":"1"}}');
    workspace.permissions.accessFilesystemRules = [{ path: packagePath, access: "deny" }];
    await expect(
      new WebPreviewTools(workspace).execute("preview_web_page", {
        path: "index.html",
      }),
    ).rejects.toThrow(/profile_filesystem_denied/);
  });

  it("retains the ACL of a project whose directory is a symlink", async () => {
    const workspace = makeWorkspace();
    const project = path.join(workspace.path, "linked-project");
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(workspace.path, ".cowork/projects"), { recursive: true });
    fs.writeFileSync(path.join(project, "ACCESS.md"), "## Deny\n- role: reviewer\n");
    fs.writeFileSync(path.join(project, "secret.js"), "document.body.textContent = 'PRIVATE';");
    fs.symlinkSync(project, path.join(workspace.path, ".cowork/projects/private"));
    fs.writeFileSync(
      path.join(workspace.path, "index.html"),
      '<script src=".cowork/projects/private/secret.js"></script>',
    );
    const tools = new WebPreviewTools(
      workspace,
      { getTask: () => ({ assignedAgentRoleId: "reviewer" }) } as Any,
      "task-1",
    );
    await expect(tools.execute("preview_web_page", { path: "index.html" })).rejects.toThrow(
      /Denied by ACCESS.md/,
    );
  });

  it("rejects entry replacement while a manifest approval is pending", async () => {
    const workspace = makeWorkspace();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "preview-external-"));
    dirs.push(external);
    fs.writeFileSync(path.join(external, "package.json"), "{}");
    fs.symlinkSync(path.join(external, "package.json"), path.join(workspace.path, "package.json"));
    const project = path.join(workspace.path, ".cowork/projects/private");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "ACCESS.md"), "## Deny\n- role: reviewer\n");
    fs.writeFileSync(path.join(project, "secret.html"), "<main>PRIVATE</main>");
    let approvals = 0;
    const tools = new WebPreviewTools(
      workspace,
      {
        getTask: () => ({ assignedAgentRoleId: "reviewer" }),
        authorizeToolAction: async () => {
          approvals += 1;
          fs.unlinkSync(path.join(workspace.path, "index.html"));
          fs.symlinkSync(
            path.join(project, "secret.html"),
            path.join(workspace.path, "index.html"),
          );
          return true;
        },
        consumeExternalFileApproval: () => approvals > 0,
      } as Any,
      "task-1",
    );
    await expect(tools.execute("preview_web_page", { path: "index.html" })).rejects.toThrow(
      /changed while preparing preview/,
    );
    expect(approvals).toBe(1);
  });

  it("rechecks entry profile policy after another read awaits approval", async () => {
    const workspace = makeWorkspace();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "preview-policy-"));
    dirs.push(external);
    fs.writeFileSync(path.join(external, "package.json"), "{}");
    fs.symlinkSync(path.join(external, "package.json"), path.join(workspace.path, "package.json"));
    let approvals = 0;
    const tools = new WebPreviewTools(
      workspace,
      {
        authorizeToolAction: async () => {
          approvals += 1;
          workspace.permissions.accessWorkspaceRoots = [workspace.path, external];
          workspace.permissions.accessFilesystemRules = [
            { path: path.join(workspace.path, "index.html"), access: "deny" },
          ];
          return true;
        },
        consumeExternalFileApproval: () => approvals > 0,
      } as Any,
      "task-1",
    );
    await expect(tools.execute("preview_web_page", { path: "index.html" })).rejects.toThrow(
      /profile_filesystem_denied/,
    );
    expect(approvals).toBe(1);
  });
  it("exposes one read-only tool that explains when to use it", () => {
    const [tool] = WebPreviewTools.getToolDefinitions();
    expect(tool.name).toBe("preview_web_page");
    expect(tool.description).toMatch(/after writing or editing a web page/);
    expect(tool.input_schema.required).toEqual(["path"]);
    expect(TOOL_RISK_LEVELS.preview_web_page).toBe("read");
    expect(TOOL_GROUPS["group:read"]).toContain("preview_web_page");
  });

  it("validates actions", () => {
    expect(
      parseWebPreviewActions([
        { type: "click", selector: " #add " },
        { type: "type", selector: "input", text: "acme" },
        { type: "wait", ms: 99_999 },
      ]),
    ).toEqual([
      { type: "click", selector: "#add" },
      { type: "type", selector: "input", text: "acme" },
      { type: "wait", ms: 5_000 },
    ]);
    expect(parseWebPreviewActions(undefined)).toEqual([]);
    expect(() => parseWebPreviewActions([{ type: "click" }])).toThrow(/selector/);
    expect(() => parseWebPreviewActions([{ type: "eval", code: "1" }])).toThrow(
      /click, type or wait/,
    );
    expect(() =>
      parseWebPreviewActions(Array.from({ length: 21 }, () => ({ type: "wait", ms: 1 }))),
    ).toThrow(/At most 20/);
  });

  it("only previews HTML files inside the workspace", async () => {
    const tools = new WebPreviewTools(makeWorkspace());
    await expect(tools.execute("preview_web_page", { path: "notes.txt" })).rejects.toThrow(
      /\.html/,
    );
    await expect(tools.execute("preview_web_page", { path: "../outside.html" })).rejects.toThrow();
    await expect(tools.execute("preview_web_page", { path: "/etc/hosts.html" })).rejects.toThrow();
    await expect(tools.execute("other_tool", {})).rejects.toThrow(/Unknown tool/);
  });
});
