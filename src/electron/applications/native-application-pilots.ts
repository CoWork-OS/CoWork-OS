import { z } from "zod";
import { createPhotoshopEditAdapter } from "./photoshop-edit-adapter";
import type {
  ApplicationResource,
  ApplicationResult,
  ApplicationRoute,
} from "../../shared/application-execution";
import {
  ApplicationRouteSchema,
  ApplicationResultSchema,
} from "../../shared/application-execution";
import type {
  ApplicationAdapter,
  ApplicationAdapterCatalog,
  ApplicationAdapterContext,
} from "./ApplicationAdapterCatalog";
import { NativeCreateSchema, type NativeCreateInput } from "./native-application-scripts";

const inputSchema = (app: "excel" | "photoshop") =>
  z.toJSONSchema(app === "excel" ? NativeCreateSchema.options[0] : NativeCreateSchema.options[1]);
export interface NativePilotState extends Record<string, unknown> {
  persisted?: {
    sha256?: string;
    title?: unknown;
    rows?: unknown[][];
    width?: number;
    height?: number;
    export?: { sha256?: string; width?: number; height?: number } | null;
  };
}
export function nativePilotResources(input: NativeCreateInput): ApplicationResource[] {
  return [input.path, ...(input.app === "photoshop" ? [input.exportPath] : [])].map((file) => ({
    kind: "file",
    system: "local",
    identity: file,
    locator: file,
  }));
}

/** Semantic checks cover persisted formulas/caches as well as the live application's model. */
export function nativePilotUnmet(input: NativeCreateInput, state: NativePilotState): string[] {
  const unmet: string[] = [];
  const persisted = state.persisted;
  if (state.path !== input.path || state.saved !== true || !persisted?.sha256)
    unmet.push("Exact native document must be saved and readable");
  if (input.app === "excel") {
    const close = (a: unknown, b: number) =>
      typeof a === "number" &&
      Number.isFinite(a) &&
      Math.abs(a - b) <= Math.max(1e-7, Math.abs(b) * 1e-10);
    const formulaMatches = (cell: unknown, formula: string, expected: number) => {
      if (!cell || typeof cell !== "object" || Array.isArray(cell)) return false;
      const value = cell as Record<string, unknown>;
      return value.formula === formula && close(value.result, expected);
    };
    const units = input.units.reduce((a, b) => a + b, 0);
    const revenue = units * input.price,
      cost = units * input.unitCost,
      profit = revenue - cost;
    if (state.title !== input.title || persisted?.title !== input.title)
      unmet.push("Workbook title differs from request");
    for (const [key, expected] of Object.entries({
      revenue,
      cost,
      profit,
      margin: revenue ? profit / revenue : 0,
    }))
      if (!close(state[key], expected)) unmet.push(`Native ${key} is incorrect`);
    if (state.revenueFormula !== "=B5*C5" || state.profitFormula !== "=SUM(G5:G7)")
      unmet.push("Native formulas are missing");
    const rows = persisted?.rows;
    if (!Array.isArray(rows) || rows.length !== 6) unmet.push("Saved worksheet rows are missing");
    else {
      for (let i = 0; i < 3; i++) {
        const row = rows[i + 1],
          n = i + 5;
        if (
          row?.[0] !== input.months[i] ||
          row?.[1] !== input.units[i] ||
          row?.[2] !== input.price ||
          row?.[4] !== input.unitCost
        )
          unmet.push(`Saved inputs for ${input.months[i]} differ`);
        const expected: Record<number, [string, number]> = {
          3: [`B${n}*C${n}`, input.units[i] * input.price],
          5: [`B${n}*E${n}`, input.units[i] * input.unitCost],
          6: [`D${n}-F${n}`, input.units[i] * (input.price - input.unitCost)],
          7: [
            `IFERROR(G${n}/D${n},0)`,
            input.price ? (input.price - input.unitCost) / input.price : 0,
          ],
        };
        for (const [col, [formula, value]] of Object.entries(expected)) {
          const cell = row?.[Number(col)];
          if (!formulaMatches(cell, formula, value))
            unmet.push(`Saved formula/cache ${String.fromCharCode(65 + Number(col))}${n} differs`);
        }
      }
      for (const [col, formula, value] of [
        [1, "SUM(B5:B7)", units],
        [3, "SUM(D5:D7)", revenue],
        [5, "SUM(F5:F7)", cost],
        [6, "SUM(G5:G7)", profit],
        [7, "IFERROR(G9/D9,0)", revenue ? profit / revenue : 0],
      ] as const) {
        const cell = rows[5]?.[col];
        if (!formulaMatches(cell, formula, value))
          unmet.push(`Saved total formula/cache ${String.fromCharCode(65 + col)}9 differs`);
      }
    }
  } else {
    if (
      state.width !== input.width ||
      state.height !== input.height ||
      persisted?.width !== input.width ||
      persisted?.height !== input.height
    )
      unmet.push("PSD dimensions differ");
    if (
      JSON.stringify(state.layers) !==
      JSON.stringify(["Brand", "Subtitle", "Title", "Accent", "Background"])
    )
      unmet.push("Editable layer structure differs");
    if (JSON.stringify(state.text) !== JSON.stringify(["COWORK OS", input.subtitle, input.title]))
      unmet.push("Editable text differs");
    if (
      !persisted?.export ||
      persisted.export.width !== input.width ||
      persisted.export.height !== input.height
    )
      unmet.push("PNG export is missing or has incorrect dimensions");
  }
  return unmet;
}

export function createNativePilotAdapter(
  app: "excel" | "photoshop",
  background = false,
): ApplicationAdapter {
  if (background && app !== "photoshop")
    throw new Error("Background scripting is qualified only for Photoshop");
  const createTool = background ? "local_photoshop_create" : "native_application_create";
  const inspectTool = background ? "local_photoshop_inspect" : "native_application_inspect";
  const route: ApplicationRoute = ApplicationRouteSchema.parse({
    id: background ? "local.photoshop.v1" : `native.${app}.v1`,
    adapterId: `native-${app}`,
    adapterVersion: "1",
    capability: app === "excel" ? "excel.operating-plan.create" : "photoshop.banner.create",
    protocol: "native",
    control: "script",
    // This is a shared desktop process, not an isolated headless application server.
    environment: {
      id: background ? "macos-local-photoshop" : "macos-user-desktop",
      kind: "desktop",
      locality: "local",
      background,
      isolated: false,
    },
    resourceKinds: ["file"],
    effect: "write",
    preparationEffect: "read",
    replay: "never",
    qualified: false,
    callTimeoutMs: 90_000,
    supports: {
      prepare: true,
      observe: true,
      cancel: false,
      verify: true,
      conditionalWrite: false,
      remoteFencing: false,
    },
    description: background
      ? "Local background Photoshop scripting: auto-launch without activation, fresh PSD/PNG outputs, no pointer or keyboard input, original-output reconciliation. Requires an unlocked Mac and Photoshop installed; no VM or network dependency."
      : `Experimental bounded ${app} pilot: new local documents only. Requires an unlocked macOS session and running app. No replay or in-app cancellation; exact-file readback verifies native fidelity.`,
    inputSchema: inputSchema(app),
  });
  const inspect = async (context: ApplicationAdapterContext) => {
    const input = NativeCreateSchema.parse(context.operation.request.input);
    return (await context.tools.call(
      inspectTool,
      {
        app,
        action: "document",
        path: input.path,
        ...(input.app === "photoshop" ? { exportPath: input.exportPath } : {}),
      },
      context,
    )) as NativePilotState;
  };
  const result = (
    context: ApplicationAdapterContext,
    state: NativePilotState,
  ): ApplicationResult => {
    const input = NativeCreateSchema.parse(context.operation.request.input);
    return ApplicationResultSchema.parse({
      kind: "artifact",
      summary:
        input.app === "excel"
          ? "Native Excel operating plan with calculated formulas"
          : "Editable Photoshop banner and PNG export",
      resources: nativePilotResources(input),
      data: state,
      unmetCriteria: nativePilotUnmet(input, state),
    });
  };
  return {
    route,
    validateInput(raw, resources) {
      const input = NativeCreateSchema.parse(raw);
      if (input.app !== app) throw new Error("Application input/route mismatch");
      const expected = nativePilotResources(input);
      if (
        resources.length !== expected.length ||
        expected.some(
          (ref) =>
            !resources.some(
              (r) =>
                r.kind === "file" &&
                r.system === "local" &&
                r.identity === ref.identity &&
                (!r.locator || r.locator === ref.locator) &&
                !r.accountId &&
                !r.tenantId,
            ),
        )
      )
        throw new Error("Native pilot resource references must match every exact output path");
    },
    async readiness(context) {
      if (context.phase === "prepare" || (background && context.phase === "execute"))
        return { ready: true };
      await context.tools.call(inspectTool, { app, action: "readiness" }, context);
      return { ready: true };
    },
    async prepare(context) {
      const input = NativeCreateSchema.parse(context.operation.request.input);
      return {
        kind: "summary",
        summary:
          app === "excel"
            ? `Create ${input.title} with three months, editable inputs and native revenue/cost/profit/margin formulas.`
            : `Create ${input.title} as five editable layers and export a PNG.`,
        references: nativePilotResources(input).map((r) => r.identity),
        expiresAt: Date.now() + 15 * 60_000,
        payload: input,
      };
    },
    async execute(context) {
      await context.tools.call(createTool, context.operation.request.input, context);
      const state = await inspect(context);
      return { status: "completed", result: result(context, state) };
    },
    async observe(context) {
      const state = await inspect(context);
      // Positive exact-target readback only. Absence can never authorize resubmission.
      return { status: "completed", result: result(context, state) };
    },
    async verify(context) {
      const state = await inspect(context);
      const input = NativeCreateSchema.parse(context.operation.request.input);
      const unmet = nativePilotUnmet(input, state);
      const prior = context.operation.result?.data as NativePilotState | undefined;
      if (prior?.persisted?.sha256 !== state.persisted?.sha256)
        unmet.push("Native artifact changed since execution/readback");
      if (
        app === "photoshop" &&
        prior?.persisted?.export?.sha256 !== state.persisted?.export?.sha256
      )
        unmet.push("Export changed since execution/readback");
      return {
        status: unmet.length ? "contradicted" : "verified",
        result: result(context, state),
        summary: unmet.length
          ? unmet.join("; ")
          : `${app} model and persisted output match the requested native workflow`,
        checkedAt: Date.now(),
        evidence: [
          {
            source: input.path,
            claim: `Fresh exact-document readback and saved SHA-256 ${state.persisted?.sha256}`,
          },
          ...(input.app === "photoshop" && state.persisted?.export
            ? [
                {
                  source: input.exportPath,
                  claim: `PNG ${input.width}x${input.height}; SHA-256 ${state.persisted.export.sha256}`,
                },
              ]
            : []),
        ],
      };
    },
  };
}
export function registerNativeApplicationPilots(catalog: ApplicationAdapterCatalog): void {
  if (process.platform !== "darwin") return;
  for (const app of ["excel", "photoshop"] as const)
    catalog.register(createNativePilotAdapter(app));
  catalog.register(createNativePilotAdapter("photoshop", true));
  catalog.register(createPhotoshopEditAdapter());
}
