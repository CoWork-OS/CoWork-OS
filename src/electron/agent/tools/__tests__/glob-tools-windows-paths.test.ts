/**
 * GlobTools on Windows: path.relative() returns "\"-separated paths there, while glob patterns
 * use "/". The path module is simulated so the regression runs on every platform.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

const windowsPaths = vi.hoisted(() => ({ enabled: false }));

vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");
  const simulated: Record<string, unknown> = { ...actual };
  simulated.relative = (from: string, to: string) => {
    const relative = actual.relative(from, to);
    return windowsPaths.enabled ? relative.split("/").join("\\") : relative;
  };
  Object.defineProperty(simulated, "sep", {
    get: () => (windowsPaths.enabled ? "\\" : "/"),
    enumerable: true,
  });
  const moduleObject: Record<string, unknown> = {};
  Object.defineProperties(moduleObject, Object.getOwnPropertyDescriptors(simulated));
  moduleObject.default = simulated;
  return moduleObject;
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

import * as path from "path";
import { GlobTools } from "../glob-tools";
import { Workspace } from "../../../../shared/types";

describe("GlobTools with Windows path separators", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    windowsPaths.enabled = false;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("matches patterns that name directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-glob-windows-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "components", "Button.tsx"), "export {};\n");
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, "readme.tsx"), "export {};\n");

    const workspace: Workspace = {
      id: "test-workspace",
      name: "Test Workspace",
      path: root,
      permissions: { read: true, write: true, delete: false, network: false, shell: false },
      createdAt: Date.now(),
    };
    const tools = new GlobTools(workspace, { logEvent: vi.fn() } as Any, "task");
    const matchedPaths = async (pattern: string) => {
      const result = await tools.glob({ pattern });
      expect(result.success, result.error).toBe(true);
      return result.matches.map((match) => match.path.split("\\").join("/")).sort();
    };

    windowsPaths.enabled = true;
    expect(path.relative(root, path.join(root, "src", "index.ts"))).toBe("src\\index.ts");
    expect(await matchedPaths("src/**/*.tsx")).toEqual(["src/components/Button.tsx"]);
    expect(await matchedPaths("src/components/*.tsx")).toEqual(["src/components/Button.tsx"]);
    expect(await matchedPaths("src/*.ts")).toEqual(["src/index.ts"]);
    expect(await matchedPaths("**/*.tsx")).toEqual(["readme.tsx", "src/components/Button.tsx"]);
  });
});
