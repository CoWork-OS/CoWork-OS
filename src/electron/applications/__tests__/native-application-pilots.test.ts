import { describe, it, expect, vi } from "vitest";
import {
  createNativePilotAdapter,
  nativePilotResources,
  nativePilotUnmet,
} from "../native-application-pilots";
import {
  NativeCreateSchema,
  nativeInspectScript,
  parseNativeInspection,
  photoshopCreateScript,
  excelCreateScript,
} from "../native-application-scripts";
import {
  ApplicationAdapterCatalog,
  type ApplicationAdapterContext,
} from "../ApplicationAdapterCatalog";
import { ApplicationOperationRequestSchema } from "../../../shared/application-execution";
import { NativeApplicationTools } from "../../agent/tools/native-application-tools";
import { evaluateToolPolicy } from "../../agent/tool-policy-engine";
import { PermissionEngine } from "../../agent/runtime/PermissionEngine";
import { getDefaultRuntimeToolMetadata } from "../../agent/tools/runtime-tool-definition";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { isNativeDesktopAvailable, requireNativeDesktopSession } from "../native-desktop-session";
import { readSavedNumericFormulaCaches } from "../native-application-artifacts";
vi.mock("../native-desktop-session", async (original) => ({
  ...(await original<object>()),
  requireNativeDesktopSession: vi.fn(async () => {}),
}));

type NativeToolHooks = {
  script: NativeApplicationTools["script"];
  compileNative: NativeApplicationTools["compileNative"];
  launchPhotoshop: NativeApplicationTools["launchPhotoshop"];
  requireRunning: NativeApplicationTools["requireRunning"];
};

const excel = {
  app: "excel" as const,
  path: "/tmp/Operating plan.xlsx",
  title: "A plan",
  months: ["Jan", "Feb", "Mar"] as [string, string, string],
  units: [0, 2, 3] as [number, number, number],
  price: 0,
  unitCost: 0,
};
const photoshop = {
  app: "photoshop" as const,
  path: "/tmp/banner.psd",
  exportPath: "/tmp/banner.png",
  title: 'An "editable" design',
  subtitle: "Your tools in one place",
  width: 1200,
  height: 630,
  background: "132235",
  accent: "51D6B5",
};

describe("Native application qualification", () => {
  it("keeps self-closing blank cells from swallowing saved formula caches", () => {
    const caches = readSavedNumericFormulaCaches(
      '<row><c r="C9" s="4"/><c r="D9" s="4"><f>SUM(D5:D7)</f><v>22500</v></c><c r="E9"/><c r="F9"><f>SUM(F5:F7)</f><v>0</v></c><c r="G9"><f>SUM(G5:G7)</f></c><c r="H9" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>',
    );
    expect([...caches]).toEqual([
      ["D9", 22500],
      ["F9", 0],
    ]);
  });
  it("requires an unlocked console session and refuses writes before app calls", async () => {
    expect(isNativeDesktopAvailable('{"onConsole":true,"locked":false}')).toBe(true);
    expect(isNativeDesktopAvailable('{"onConsole":true,"locked":true}')).toBe(false);
    expect(isNativeDesktopAvailable('{"onConsole":false,"locked":false}')).toBe(false);
    expect(isNativeDesktopAvailable('{"onConsole":true}')).toBe(false);
    expect(isNativeDesktopAvailable('{"onConsole":1,"locked":0}')).toBe(false);
    expect(isNativeDesktopAvailable("unrecognized state")).toBe(false);
    const tools = new NativeApplicationTools(
      { authorizeApplicationPath: vi.fn(async (p: string) => p) } as never,
      {} as never,
      "task",
    );
    const script = vi.spyOn(tools as unknown as NativeToolHooks, "script");
    vi.mocked(requireNativeDesktopSession).mockRejectedValueOnce(new Error("Desktop locked"));
    await expect(tools.create(excel)).rejects.toThrow(/Desktop locked/);
    expect(script).not.toHaveBeenCalled();
  });
  it("pins every exact resource and rejects invented background capability", () => {
    const catalog = new ApplicationAdapterCatalog();
    catalog.register(createNativePilotAdapter("excel"));
    const request = ApplicationOperationRequestSchema.parse({
      idempotencyKey: "one",
      taskId: "task",
      sessionId: "session",
      workspaceId: "workspace",
      capability: "excel.operating-plan.create",
      objective: "Create plan",
      input: excel,
      resources: nativePilotResources(excel),
    });
    expect(catalog.resolve(request).route.environment.background).toBe(false);
    expect(() =>
      catalog.resolve({
        ...request,
        resources: [{ kind: "file", system: "local", identity: "/tmp/unrelated.xlsx" }],
      }),
    ).toThrow(/exact output/);
    expect(() =>
      catalog.resolve({
        ...request,
        constraints: { ...request.constraints, backgroundRequired: true },
      }),
    ).toThrow(/No eligible/);
    expect(() =>
      NativeCreateSchema.parse({
        ...excel,
        path: "/tmp/alias/../Operating plan.xlsx",
      }),
    ).toThrow();
    expect(() =>
      NativeCreateSchema.parse({
        ...excel,
        arbitraryScript: "save someone else's workbook",
      }),
    ).toThrow();
    expect(() =>
      NativeCreateSchema.parse({
        ...excel,
        months: ['=HYPERLINK("https://example.com")', "Feb", "Mar"],
      }),
    ).toThrow(/formulas/);
  });
  it("generates data-bound native commands and read-only inspectors", () => {
    const create = photoshopCreateScript(photoshop);
    expect(create).toContain("Output already exists");
    expect(create).toContain("finally");
    expect(create).not.toMatch(/\bactivate\b/);
    expect(excelCreateScript(excel)).toContain("calculate ws");
    // Excel workbook references are name-based and become stale after Save As renames Book1.
    expect(excelCreateScript(excel)).not.toContain("return full name of wb");
    for (const app of ["excel", "photoshop"] as const) {
      const read = nativeInspectScript(app, app === "excel" ? excel.path : photoshop.path);
      expect(read).not.toMatch(
        /saveAs|\bactivate\b|\bopen\b.*File\(|\bcalculate\b|documents\.add|make new workbook/,
      );
    }
    expect(
      parseNativeInspection(
        "excel",
        "16.100\n/tmp/plan.xlsx\ntrue\nPlan\n=B5*C5\n=SUM(G5:G7)\n0.0\n0.0\n0.0\n0.0",
      ).revenue,
    ).toBe(0);
    expect(() => parseNativeInspection("excel", "bad")).toThrow(/Unexpected/);
  });
  it("keeps application writes blocked in plan mode and inspection read-only", () => {
    expect(
      evaluateToolPolicy("native_application_create", { executionMode: "plan" }).decision,
    ).toBe("deny");
    expect(
      evaluateToolPolicy("native_application_inspect", {
        executionMode: "plan",
      }).decision,
    ).toBe("allow");
    expect(getDefaultRuntimeToolMetadata("native_application_inspect").readOnly).toBe(true);
    expect(getDefaultRuntimeToolMetadata("native_application_create").readOnly).toBe(false);
  });
  it("checks both application outputs against the named workspace boundary", () => {
    const workspace = {
      id: "workspace",
      name: "Outputs",
      path: "/tmp/workspace",
      createdAt: 0,
      permissions: {
        read: true,
        write: true,
        delete: false,
        shell: true,
        network: false,
        accessProfileId: "ask_for_approval",
        accessProfileScoped: true,
        accessFilesystemScoped: true,
        accessWorkspaceRoots: ["."],
        accessSandboxMode: "workspace-write" as const,
        accessApprovalPolicy: "on-request" as const,
        accessNetworkMode: "disabled" as const,
      },
    };
    const request = {
      workspace,
      toolName: "native_application_create",
      approvalType: "workspace_write" as const,
      mode: "default" as const,
      rules: [],
      toolInput: {
        ...photoshop,
        path: "/tmp/workspace/banner.psd",
        exportPath: "/outside/banner.png",
      },
    };
    expect(PermissionEngine.evaluate(request).decision).not.toBe("allow");
    expect(
      PermissionEngine.evaluate({
        ...request,
        toolInput: {
          ...request.toolInput,
          exportPath: "/tmp/workspace/banner.png",
        },
        mode: "bypass_permissions",
      }).decision,
    ).toBe("allow");
    expect(PermissionEngine.evaluate({ ...request, toolName: "run_applescript" }).decision).toBe(
      "deny",
    );
  });
  it("rechecks write authority after approval and respects cancellation before dispatch", async () => {
    const authorize = vi
      .fn(async (p: string) => p)
      .mockRejectedValueOnce(new Error("Outside workspace"));
    const approval = vi.fn(async () => true);
    const tools = new NativeApplicationTools(
      { authorizeApplicationPath: authorize } as never,
      { requestApproval: approval } as never,
      "task",
    );
    const script = vi
      .spyOn(tools as unknown as NativeToolHooks, "script")
      .mockResolvedValue("16.100");
    vi.spyOn(tools as unknown as NativeToolHooks, "compileNative").mockResolvedValue(undefined);
    await expect(tools.create(excel)).rejects.toThrow(/Outside workspace/);
    expect(script).not.toHaveBeenCalled();
    authorize.mockImplementation(async (p: string) => p);
    const controller = new AbortController();
    approval.mockImplementationOnce(async () => {
      controller.abort();
      return true;
    });
    await expect(tools.create(excel, controller.signal)).rejects.toThrow(
      /cancelled before dispatch/,
    );
    expect(script).toHaveBeenCalledTimes(1); // Readiness only.
  });
  it("detects partial export and changed editable content", () => {
    const state = {
      path: photoshop.path,
      saved: true,
      width: 1200,
      height: 630,
      layers: ["Brand", "Subtitle", "Title", "Accent", "Background"],
      text: ["COWORK OS", photoshop.subtitle, photoshop.title],
      persisted: {
        sha256: "a",
        width: 1200,
        height: 630,
        export: { width: 1200, height: 630 },
      },
    };
    expect(nativePilotUnmet(photoshop, state)).toEqual([]);
    expect(
      nativePilotUnmet(photoshop, {
        ...state,
        persisted: { ...state.persisted, export: null },
      }),
    ).toContain("PNG export is missing or has incorrect dimensions");
    expect(nativePilotUnmet(photoshop, { ...state, text: ["flattened"] })).toContain(
      "Editable text differs",
    );
  });
  it("refuses existing output before app dispatch, preserving file authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-authority-"));
    try {
      const file = path.join(root, "existing.xlsx");
      await fs.writeFile(file, "original");
      const authorize = vi.fn(async (p: string) => p);
      const approval = vi.fn(async () => true);
      const tools = new NativeApplicationTools(
        { authorizeApplicationPath: authorize } as never,
        { requestApproval: approval } as never,
        "task",
      );
      const script = vi.spyOn(tools as unknown as NativeToolHooks, "script");
      await expect(tools.create({ ...excel, path: file })).rejects.toThrow(/fresh output/);
      expect(authorize).toHaveBeenCalledWith(file, "write");
      expect(approval).not.toHaveBeenCalled();
      expect(script).not.toHaveBeenCalled();
      expect(await fs.readFile(file, "utf8")).toBe("original");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("reads the exact saved XLSX independently and rejects false cached calculations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-readback-"));
    try {
      const file = path.join(root, "zero.xlsx");
      const input = { ...excel, path: file };
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Operating plan");
      ws.getCell("A1").value = input.title;
      for (let i = 0; i < 3; i++) {
        const n = i + 5;
        ws.getCell(`A${n}`).value = input.months[i];
        ws.getCell(`B${n}`).value = input.units[i];
        ws.getCell(`C${n}`).value = 0;
        ws.getCell(`E${n}`).value = 0;
        for (const [col, formula] of Object.entries({
          D: `B${n}*C${n}`,
          F: `B${n}*E${n}`,
          G: `D${n}-F${n}`,
          H: `IFERROR(G${n}/D${n},0)`,
        }))
          ws.getCell(`${col}${n}`).value = { formula, result: 0 };
      }
      for (const [col, formula, result] of [
        ["B", "SUM(B5:B7)", 5],
        ["D", "SUM(D5:D7)", 0],
        ["F", "SUM(F5:F7)", 0],
        ["G", "SUM(G5:G7)", 0],
        ["H", "IFERROR(G9/D9,0)", 0],
      ] as const)
        ws.getCell(`${col}9`).value = { formula, result };
      await wb.xlsx.writeFile(file);
      const authorize = vi.fn(async (p: string) => p);
      const tools = new NativeApplicationTools(
        { authorizeApplicationPath: authorize } as never,
        {} as never,
        "task",
      );
      vi.spyOn(tools as unknown as NativeToolHooks, "script")
        .mockResolvedValueOnce("16.100")
        .mockResolvedValueOnce(
          `16.100\n${file}\ntrue\n${input.title}\n=B5*C5\n=SUM(G5:G7)\n0.0\n0.0\n0.0\n0.0`,
        );
      const state = await tools.inspect({
        app: "excel",
        action: "document",
        path: file,
      });
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(nativePilotUnmet(input, state)).toEqual([]);
      const mutated = structuredClone(state);
      const persisted = mutated.persisted as { rows: Array<Array<unknown>> };
      const formulaCell = persisted.rows[1][3] as { formula: string; result: number };
      formulaCell.result = 42;
      expect(nativePilotUnmet(input, mutated)).toContain("Saved formula/cache D5 differs");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("VM-free local Photoshop route", () => {
  it("resolves required background execution to a local nonisolated route", () => {
    const catalog = new ApplicationAdapterCatalog();
    catalog.register(createNativePilotAdapter("photoshop", true));
    const request = ApplicationOperationRequestSchema.parse({
      idempotencyKey: "local-background",
      taskId: "task",
      sessionId: "session",
      workspaceId: "workspace",
      capability: "photoshop.banner.create",
      routeId: "local.photoshop.v1",
      objective: "Create banner",
      input: photoshop,
      resources: nativePilotResources(photoshop),
      constraints: { backgroundRequired: true },
    });
    expect(catalog.resolve(request).route.environment).toMatchObject({
      locality: "local",
      background: true,
      isolated: false,
    });
  });
  it("rejects unsupported apps rather than inventing universal background support", () => {
    expect(() => createNativePilotAdapter("excel", true)).toThrow(/only for Photoshop/);
  });
  it("dispatches the bounded local tool without a worker transport", async () => {
    const adapter = createNativePilotAdapter("photoshop", true);
    const call = vi.fn(async (name: string) =>
      name.endsWith("inspect") ? {} : { path: photoshop.path },
    );
    const context = {
      phase: "execute",
      tools: { call },
      operation: { request: { input: photoshop } },
    } as unknown as ApplicationAdapterContext;
    await adapter.readiness(context);
    await adapter.execute(context);
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      "local_photoshop_create",
      "local_photoshop_inspect",
    ]);
  });
  it("does not launch Photoshop from the read-only inspector", async () => {
    vi.mocked(requireNativeDesktopSession).mockResolvedValue(undefined);
    const tools = new NativeApplicationTools({} as never, {} as never, "task", true);
    vi.spyOn(tools as unknown as NativeToolHooks, "script").mockResolvedValue("NOT_RUNNING");
    const launch = vi
      .spyOn(tools as unknown as NativeToolHooks, "launchPhotoshop")
      .mockResolvedValue(undefined);
    await expect(tools.inspect({ app: "photoshop", action: "readiness" })).rejects.toThrow(
      /Open the application/,
    );
    expect(launch).not.toHaveBeenCalled();
  });
  it("does not admit other applications through the local Photoshop tool", async () => {
    vi.mocked(requireNativeDesktopSession).mockResolvedValue(undefined);
    const tools = new NativeApplicationTools({} as never, {} as never, "task", true);
    const script = vi.spyOn(tools as unknown as NativeToolHooks, "script");
    await expect(tools.inspect({ app: "excel", action: "readiness" })).rejects.toThrow(
      /Photoshop only/,
    );
    expect(script).not.toHaveBeenCalled();
  });
  it("launches a closed Photoshop in the background before bounded creation", async () => {
    vi.mocked(requireNativeDesktopSession).mockResolvedValue(undefined);
    const tools = new NativeApplicationTools(
      { authorizeApplicationPath: vi.fn(async (p: string) => p) } as never,
      { requestApproval: vi.fn(async () => true) } as never,
      "task",
      true,
    );
    const launch = vi
      .spyOn(tools as unknown as NativeToolHooks, "launchPhotoshop")
      .mockResolvedValue(undefined);
    vi.spyOn(tools as unknown as NativeToolHooks, "compileNative").mockResolvedValue(undefined);
    vi.spyOn(tools as unknown as NativeToolHooks, "script")
      .mockResolvedValueOnce("NOT_RUNNING")
      .mockResolvedValueOnce("27.11")
      .mockResolvedValueOnce(photoshop.path);
    const result = await tools.create(photoshop);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result.path).toBe(photoshop.path);
  });
});
