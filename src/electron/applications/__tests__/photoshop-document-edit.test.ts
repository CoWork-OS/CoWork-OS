import { applicationJson } from "../application-operation-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  PhotoshopEditSchema,
  expectedPhotoshopEdit,
  photoshopEditUnmet,
  photoshopReadSnapshotScript,
  photoshopEditSnapshotScript,
  type PhotoshopModel,
} from "../photoshop-document-edit";
import { createPhotoshopEditAdapter, photoshopEditResources } from "../photoshop-edit-adapter";
import {
  ApplicationAdapterCatalog,
  type ApplicationAdapterContext,
} from "../ApplicationAdapterCatalog";
import { ApplicationOperationRequestSchema } from "../../../shared/application-execution";
import {
  NativeApplicationTools,
  LOCAL_PHOTOSHOP_TOOLS,
} from "../../agent/tools/native-application-tools";
import { evaluateToolPolicy } from "../../agent/tool-policy-engine";
import { PermissionEngine } from "../../agent/runtime/PermissionEngine";
import { getDefaultRuntimeToolMetadata } from "../../agent/tools/runtime-tool-definition";
vi.mock("../native-desktop-session", () => ({
  requireNativeDesktopSession: vi.fn(async () => {}),
}));
afterEach(() => vi.restoreAllMocks());
type NativeToolHooks = {
  script: NativeApplicationTools["script"];
  compileNative: NativeApplicationTools["compileNative"];
  launchPhotoshop: NativeApplicationTools["launchPhotoshop"];
  requireRunning: NativeApplicationTools["requireRunning"];
};

const model: PhotoshopModel = {
  width: 1200,
  height: 630,
  resolution: 72,
  mode: "DocumentMode.RGB",
  layers: [
    {
      path: ["Group"],
      kind: "group",
      visible: true,
      opacity: 100,
      bounds: [0, 0, 1200, 630],
      locked: false,
    },
    {
      path: ["Group", "Title"],
      kind: "text",
      visible: true,
      opacity: 100,
      bounds: [100, 100, 600, 160],
      locked: false,
      text: {
        contents: "Old title",
        font: "ArialMT",
        size: 48,
        color: "FFFFFF",
        position: [100, 160],
      },
    },
    {
      path: ["Background"],
      kind: "raster",
      visible: true,
      opacity: 100,
      bounds: [0, 0, 1200, 630],
      locked: false,
    },
  ],
};
const edit = {
  app: "photoshop" as const,
  sourcePath: "/tmp/source.psd",
  sourceSha256: "a".repeat(64),
  path: "/tmp/revised.psd",
  exportPath: "/tmp/revised.png",
  changes: [
    {
      op: "set_text" as const,
      layerPath: ["Group", "Title"],
      contents: 'New "title"',
      fontSize: 36,
      color: "51d6b5",
    },
    {
      op: "translate_layer" as const,
      layerPath: ["Group", "Title"],
      x: 12,
      y: 24,
    },
    { op: "rename_layer" as const, layerPath: ["Group"], name: "Campaign" },
    { op: "set_opacity" as const, layerPath: ["Background"], opacity: 70 },
  ],
};
function readback(m = model, hash = edit.sourceSha256) {
  return {
    path: edit.sourcePath,
    saved: true,
    appVersion: "27.11",
    model: m,
    persisted: {
      sha256: hash,
      width: 1200,
      height: 630,
      export: {
        sha256: "png",
        path: edit.exportPath,
        width: 1200,
        height: 630,
      },
    },
  };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "photoshop-edit-test-"));
  const source = path.join(root, "source.psd"),
    bytes = Buffer.alloc(26);
  bytes.write("8BPS");
  bytes.writeUInt16BE(1, 4);
  bytes.writeUInt32BE(630, 14);
  bytes.writeUInt32BE(1200, 18);
  await fs.writeFile(source, bytes);
  const input = {
    ...edit,
    sourcePath: source,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    path: path.join(root, "revised.psd"),
    exportPath: path.join(root, "revised.png"),
  };
  const authorize = vi.fn(async (p: string) => p),
    approval = vi.fn(async () => true);
  const tools = new NativeApplicationTools(
    { authorizeApplicationPath: authorize } as never,
    { requestApproval: approval } as never,
    "task",
    true,
  );
  vi.spyOn(tools as unknown as NativeToolHooks, "requireRunning").mockResolvedValue("27.11");
  vi.spyOn(tools as unknown as NativeToolHooks, "compileNative").mockResolvedValue(undefined);
  const script = vi
    .spyOn(tools as unknown as NativeToolHooks, "script")
    .mockImplementation(async (s: string) =>
      s.includes("var changes=") ? input.path : JSON.stringify({ appVersion: "27.11", model }),
    );
  return { root, input, bytes, tools, authorize, approval, script };
}
describe("Existing Photoshop document editing", () => {
  it("rejects in-place outputs, unknown scripts and unbound source versions", () => {
    expect(() => PhotoshopEditSchema.parse({ ...edit, path: edit.sourcePath })).toThrow();
    expect(() =>
      PhotoshopEditSchema.parse({
        ...edit,
        arbitraryScript: "save user document",
      }),
    ).toThrow();
    expect(() => PhotoshopEditSchema.parse({ ...edit, sourceSha256: "" })).toThrow();
  });
  it("applies nested-layer edits without changing the baseline", () => {
    const expected = expectedPhotoshopEdit(model, edit.changes);
    expect(expected.layers[1]).toMatchObject({
      path: ["Campaign", "Title"],
      text: {
        contents: 'New "title"',
        size: 36,
        color: "51D6B5",
        position: [112, 184],
      },
    });
    expect(model.layers[1].text?.contents).toBe("Old title");
  });
  it.each(["missing", "ambiguous", "locked", "nontext"])("refuses %s target layers", (kind) => {
    const m = structuredClone(model);
    if (kind === "missing") m.layers.pop();
    if (kind === "ambiguous") m.layers.push(structuredClone(m.layers[1]));
    if (kind === "locked") m.layers[1].locked = true;
    if (kind === "nontext") {
      m.layers[1].kind = "raster";
      delete m.layers[1].text;
    }
    const changes =
      kind === "missing"
        ? [
            {
              op: "set_opacity" as const,
              layerPath: ["Background"],
              opacity: 50,
            },
          ]
        : [edit.changes[0]];
    expect(() => expectedPhotoshopEdit(m, changes)).toThrow();
  });
  it("refuses ambiguous renames and group translation", () => {
    expect(() =>
      expectedPhotoshopEdit(model, [
        { op: "rename_layer", layerPath: ["Group"], name: "Background" },
      ]),
    ).toThrow();
    expect(() =>
      expectedPhotoshopEdit(model, [{ op: "translate_layer", layerPath: ["Group"], x: 1, y: 2 }]),
    ).toThrow();
  });
  it("verifies source preservation, saved edits, unrelated layers and PNG dimensions", () => {
    const source = readback(),
      output = readback(expectedPhotoshopEdit(model, edit.changes));
    expect(photoshopEditUnmet(edit, source, output)).toEqual([]);
    expect(
      photoshopEditUnmet(
        edit,
        { ...source, persisted: { ...source.persisted, sha256: "changed" } },
        output,
      ),
    ).toContain("Source PSD changed since planning");
    output.model.layers[2].visible = false;
    expect(photoshopEditUnmet(edit, source, output)).toContain(
      "Requested layer edits or preserved layer structure differ",
    );
    expect(
      photoshopEditUnmet(edit, source, {
        ...output,
        persisted: { ...output.persisted, export: undefined },
      }),
    ).toContain("PNG export is missing or has incorrect dimensions");
  });
  it("allows only PSD opacity quantization, not incorrect changes", () => {
    const source = readback(),
      output = readback(expectedPhotoshopEdit(model, edit.changes));
    output.model.layers[2].opacity = (178 / 255) * 100;
    expect(photoshopEditUnmet(edit, source, output)).toEqual([]);
    output.model.layers[2].opacity = 72;
    expect(photoshopEditUnmet(edit, source, output)).toContain(
      "Requested layer edits or preserved layer structure differ",
    );
  });
  it("refuses an open unsaved source without opening or changing it", () => {
    const source = { fullName: { fsName: edit.sourcePath }, saved: false };
    const app = {
      documents: [source],
      activeDocument: source,
      displayDialogs: "original",
      preferences: { rulerUnits: "original" },
      open: vi.fn(),
    };
    const apple = photoshopReadSnapshotScript(edit.sourcePath, "/tmp/private.psd");
    const js = JSON.parse(apple.slice(apple.indexOf("do javascript ") + 14));
    const run = new Function("app", "DialogModes", "Units", "SaveOptions", "File", js);
    expect(() => run(app, { NO: "no" }, { PIXELS: "pixels" }, {}, function () {})).toThrow(
      /SOURCE_UNSAVED/,
    );
    expect(app.open).not.toHaveBeenCalled();
    expect(app.preferences.rulerUnits).toBe("original");
  });
  it("admits the real nested edit schema without changing it and still rejects credentials and unbounded inputs", () => {
    const route = createPhotoshopEditAdapter().route;
    expect(JSON.parse(applicationJson(route, true))).toEqual(route);
    expect(JSON.parse(applicationJson(edit, true))).toEqual(edit);
    expect(() =>
      applicationJson({ input: { changes: [{ nested: { password: "hidden" } }] } }, true),
    ).toThrow(/connection handles/);
    expect(() => applicationJson({ text: "x".repeat(20000) }, true)).toThrow(/bounded/);
    const deep = Array.from({ length: 20 }).reduce((value) => ({ child: value }), {});
    expect(() => applicationJson(deep, true)).toThrow(/bounded/);
  });
  it("recognizes reloaded Photoshop enum values and keeps editable text metadata", () => {
    const unit = (value: number) => ({ as: () => value });
    const layer = {
      name: "Title",
      typename: "ArtLayer",
      kind: { toString: () => "LayerKind.TEXT" },
      visible: true,
      opacity: 100,
      allLocked: false,
      bounds: [unit(10), unit(20), unit(200), unit(80)],
      textItem: {
        contents: "Saved text",
        font: "ArialMT",
        size: unit(48),
        color: { rgb: { hexValue: "ffffff" } },
        position: [unit(10), unit(80)],
      },
    };
    const doc = {
      artLayers: [layer],
      layerSets: [],
      width: unit(1200),
      height: unit(630),
      resolution: 72,
      mode: "DocumentMode.RGB",
      close: vi.fn(),
    };
    const app = {
      documents: [],
      displayDialogs: "original",
      preferences: { rulerUnits: "original" },
      open: vi.fn((_file, format) => {
        if (format !== "psd") throw new Error("Explicit PSD format required");
        return doc;
      }),
    };
    const apple = photoshopReadSnapshotScript(edit.sourcePath, "/tmp/private.psd");
    const js = JSON.parse(apple.slice(apple.indexOf("do javascript ") + 14));
    const run = new Function(
      "app",
      "LayerKind",
      "DialogModes",
      "Units",
      "SaveOptions",
      "File",
      "OpenDocumentType",
      "return " + js,
    );
    const result = JSON.parse(
      run(
        app,
        { TEXT: "LayerKind.TEXT", NORMAL: "LayerKind.NORMAL" },
        { NO: "no" },
        { PIXELS: "pixels" },
        { DONOTSAVECHANGES: "discard" },
        function () {},
        { PHOTOSHOP: "psd" },
      ),
    );
    expect(result.model.layers[0]).toMatchObject({
      kind: "text",
      text: { contents: "Saved text", size: 48, color: "FFFFFF" },
    });
    expect(doc.close).toHaveBeenCalledWith("discard");
  });
  it("reconciles read-only preparation without replaying an edit, and confirms pre-dispatch cancellation", async () => {
    const adapter = createPhotoshopEditAdapter(),
      call = vi.fn(async () => readback());
    const context = {
      tools: { call },
      operation: {
        request: { input: edit },
        pendingAction: "prepare",
        cancellation: "none",
      },
    } as unknown as ApplicationAdapterContext;
    expect((await adapter.observe!(context)).status).toBe("prepared");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["local_photoshop_read"]);
    context.operation.cancellation = "requested";
    expect((await adapter.observe!(context)).status).toBe("cancelled");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("binds source and both outputs to the local background route", () => {
    const catalog = new ApplicationAdapterCatalog();
    catalog.register(createPhotoshopEditAdapter());
    const request = ApplicationOperationRequestSchema.parse({
      idempotencyKey: "edit",
      taskId: "t",
      sessionId: "s",
      workspaceId: "w",
      routeId: "local.photoshop.edit.v1",
      capability: "photoshop.document.edit",
      objective: "Revise PSD",
      input: edit,
      resources: photoshopEditResources(edit),
      constraints: { backgroundRequired: true },
    });
    expect(catalog.resolve(request).route.replay).toBe("never");
    expect(() => catalog.resolve({ ...request, resources: request.resources.slice(1) })).toThrow(
      /source/,
    );
  });
  it("uses fresh readback to reconcile the original edit and detect tampering", async () => {
    const adapter = createPhotoshopEditAdapter(),
      source = readback(),
      output = {
        ...readback(expectedPhotoshopEdit(model, edit.changes), "output"),
        path: edit.path,
      };
    const call = vi.fn(async (name: string, args: Record<string, unknown>) =>
      name === "local_photoshop_edit"
        ? { path: edit.path }
        : args.path === edit.sourcePath
          ? source
          : output,
    );
    const context = {
      tools: { call },
      operation: { request: { input: edit }, result: { data: output } },
    } as unknown as ApplicationAdapterContext;
    expect((await adapter.verify(context)).status).toBe("verified");
    await adapter.observe!(context);
    expect(call.mock.calls.every((c) => c[0] === "local_photoshop_read")).toBe(true);
    context.operation.result.data = {
      ...output,
      persisted: { ...output.persisted, sha256: "old" },
    };
    expect((await adapter.verify(context)).status).toBe("contradicted");
  });
  it("uses private snapshots, restores app state and never opens the original to mutate it", () => {
    const script = photoshopEditSnapshotScript(edit, "/tmp/private/snapshot.psd");
    for (const command of [
      script,
      photoshopReadSnapshotScript(edit.sourcePath, "/tmp/private/snapshot.psd"),
    ]) {
      expect(command).toContain("OpenDocumentType.PHOTOSHOP");
      // Photoshop ExtendScript parses unparenthesized chained ternaries differently.
      const js = JSON.parse(command.slice(command.indexOf("do javascript ") + 14));
      expect(js).toContain('else if(isText(l))r.kind="text"');
      expect(command).not.toContain("kind:group?");
    }
    expect(script).not.toMatch(/\bactivate\b/);
    expect(script).toContain("SOURCE_UNSAVED");
    expect(script).toContain("DONOTSAVECHANGES");
    expect(
      photoshopReadSnapshotScript('/tmp/quo"te.psd', "/tmp/private/snapshot.psd"),
    ).not.toContain("saveAs");
  });
  it("compiles fixed JavaScript and normalizes multiline Photoshop text", () => {
    for (const apple of [
      photoshopReadSnapshotScript(edit.sourcePath, "/tmp/private.psd"),
      photoshopEditSnapshotScript(edit, "/tmp/private.psd"),
    ]) {
      const js = JSON.parse(apple.slice(apple.indexOf("do javascript ") + 14));
      expect(() => new Function(js)).not.toThrow();
    }
    expect(
      expectedPhotoshopEdit(model, [
        { op: "set_text", layerPath: ["Group", "Title"], contents: "One\nTwo" },
      ]).layers[1].text?.contents,
    ).toBe("One\rTwo");
  });
  it("reads via a disposable PSD copy without modifying original bytes", async () => {
    const f = await fixture();
    try {
      const result = await f.tools.read({
        app: "photoshop",
        path: f.input.sourcePath,
      });
      expect(result.persisted.sha256).toBe(f.input.sourceSha256);
      expect(await fs.readFile(f.input.sourcePath)).toEqual(f.bytes);
      expect((await fs.readdir(f.root)).sort()).toEqual(["source.psd"]);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
  it("rejects changed source and output overwrites before application dispatch", async () => {
    const f = await fixture();
    try {
      await expect(f.tools.edit({ ...f.input, sourceSha256: "b".repeat(64) })).rejects.toThrow(
        /changed since planning/,
      );
      await fs.writeFile(f.input.path, "existing");
      await expect(f.tools.edit(f.input)).rejects.toThrow(/fresh output/);
      expect(f.script).not.toHaveBeenCalled();
      expect(f.approval).not.toHaveBeenCalled();
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
  it("rechecks source versions and write permissions after approval", async () => {
    const f = await fixture();
    try {
      f.approval.mockImplementationOnce(async () => {
        const changed = Buffer.from(f.bytes);
        changed[10] = 1;
        await fs.writeFile(f.input.sourcePath, changed);
        return true;
      });
      await expect(f.tools.edit(f.input)).rejects.toThrow(/changed since planning/);
      expect(f.script.mock.calls.some((c) => String(c[0]).includes("var changes="))).toBe(false);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
  it("keeps edit blocked in plan mode, reads exclusive and read-only", () => {
    expect(evaluateToolPolicy("local_photoshop_edit", { executionMode: "plan" }).decision).toBe(
      "deny",
    );
    expect(evaluateToolPolicy("local_photoshop_read", { executionMode: "plan" }).decision).toBe(
      "allow",
    );
    expect(getDefaultRuntimeToolMetadata("local_photoshop_read")).toMatchObject({
      readOnly: true,
      concurrencyClass: "exclusive",
    });
    expect(
      LOCAL_PHOTOSHOP_TOOLS.find((t) => t.name === "local_photoshop_edit")?.input_schema,
    ).toBeDefined();
  });
  it("includes source read authority and both output writes in permission evaluation", () => {
    const workspace = {
      id: "w",
      path: "/tmp/workspace",
      permissions: {
        read: true,
        write: true,
        delete: false,
        shell: false,
        network: false,
        accessProfileId: "ask_for_approval",
        accessProfileScoped: true,
        accessFilesystemScoped: true,
        accessWorkspaceRoots: ["."],
        accessSandboxMode: "workspace-write",
        accessApprovalPolicy: "on-request",
        accessNetworkMode: "disabled",
      },
    } as Parameters<typeof PermissionEngine.evaluate>[0]["workspace"];
    const request: Parameters<typeof PermissionEngine.evaluate>[0] = {
      workspace,
      toolName: "local_photoshop_edit",
      toolInput: {
        ...edit,
        sourcePath: "/outside/source.psd",
        path: "/tmp/workspace/new.psd",
        exportPath: "/tmp/workspace/new.png",
      },
      approvalType: "workspace_write",
      mode: "default",
      rules: [],
    };
    expect(PermissionEngine.evaluate(request).decision).not.toBe("allow");
  });
});
