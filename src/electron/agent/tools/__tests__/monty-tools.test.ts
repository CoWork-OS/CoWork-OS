/**
 * Tests for MontyTools - deterministic sandboxed compute and workspace transforms.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

// Mock electron (FileTools imports electron.shell)
vi.mock("electron", () => ({
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

import { MontyTools } from "../monty-tools";
import { FileTools } from "../file-tools";

const mockDaemon = {
  logEvent: vi.fn(),
  registerArtifact: vi.fn(),
};

function mkWorkspace(tmpDir: string) {
  return {
    id: "ws-1",
    name: "Test Workspace",
    path: tmpDir,
    isTemp: false,
    permissions: {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
      unrestrictedFileAccess: false,
      allowedPaths: [],
    },
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
  } as Any;
}

describe("MontyTools", () => {
  let tmpDir: string;
  let tools: MontyTools;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-monty-"));
    const workspace = mkWorkspace(tmpDir);
    const fileTools = new FileTools(workspace, mockDaemon as Any, "task-1");
    tools = new MontyTools(workspace, mockDaemon as Any, "task-1", fileTools);
  });

  it("monty_run executes code with input", async () => {
    const res = await tools.montyRun({
      code: 'input["a"] + 1',
      inputs: { a: 41 },
    });

    expect(res.success).toBe(true);
    expect(res.output).toBe(42);
  });

  it("monty_run exposes safe stdlib helpers (json_parse/json_stringify/json_extract)", async () => {
    const res = await tools.montyRun({
      code: [
        "a = json_parse('{\"x\": 1}')",
        's = json_stringify({"b": 1, "a": 2}, {"sort_keys": True, "indent": 2})',
        "vals = json_extract('prefix {\"k\": 3} suffix')",
        '{"x": a["x"], "s": s, "k": vals[0]["k"]}',
      ].join("\n"),
      inputs: {},
    });

    if (!res.success) {
      // Helps debug failures in CI without guessing.
      // eslint-disable-next-line no-console
      console.log("monty_run error:", res.error);
    }

    expect(res.success).toBe(true);
    expect(res.output).toEqual({
      x: 1,
      s: '{\n  "a": 2,\n  "b": 1\n}',
      k: 3,
    });
  });

  it("extract_json pulls JSON from code fences and prose", async () => {
    const text = [
      "Here you go:",
      "```json",
      '{"a": 1, "b": 2}',
      "```",
      'and also: prefix {"c": 3} suffix',
    ].join("\\n");

    const first = await tools.extractJson({ text, mode: "first" });
    expect(first.success).toBe(true);
    expect(first.value).toEqual({ a: 1, b: 2 });

    const all = await tools.extractJson({ text, mode: "all", maxResults: 10 });
    expect(all.success).toBe(true);
    expect(all.values).toEqual([{ a: 1, b: 2 }, { c: 3 }]);
  });

  it("monty_list_transforms and monty_run_transform work with .cowork/transforms", async () => {
    const transformsDir = path.join(tmpDir, ".cowork", "transforms");
    await fs.mkdir(transformsDir, { recursive: true });
    await fs.writeFile(
      path.join(transformsDir, "double.monty"),
      ["# name: Double", '# description: Multiply input["n"] by 2', "", 'input["n"] * 2'].join(
        "\n",
      ),
      "utf8",
    );

    const listed = await tools.listTransforms({});
    expect(listed.success).toBe(true);
    expect(listed.transforms.map((t: Any) => t.id)).toContain("double");

    const ran = await tools.runTransform({ name: "double", inputs: { n: 21 } });
    // eslint-disable-next-line no-console
    console.log("runTransform result:", ran);
    expect(ran.success).toBe(true);
    expect(ran.output).toBe(42);
  });

  it("monty_transform_file reads input, runs transform, and writes output without returning file content", async () => {
    const transformsDir = path.join(tmpDir, ".cowork", "transforms");
    await fs.mkdir(transformsDir, { recursive: true });
    await fs.writeFile(
      path.join(transformsDir, "upper.monty"),
      [
        "# name: Upper",
        '# description: Uppercase input["text"]',
        "",
        'input["text"].upper()',
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(path.join(tmpDir, "in.txt"), "hello", "utf8");

    const res = await tools.transformFile({
      transform: "upper",
      inputPath: "in.txt",
      outputPath: "out.txt",
      overwrite: true,
    });

    // eslint-disable-next-line no-console
    console.log("transformFile result:", res);

    expect(res.success).toBe(true);
    expect(res.outputPath).toBe("out.txt");

    const out = await fs.readFile(path.join(tmpDir, "out.txt"), "utf8");
    expect(out).toBe("HELLO");
    expect(res).not.toHaveProperty("outputText");
  });
});
