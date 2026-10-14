import { ApplicationNotDispatchedError } from "./ApplicationAdapterCatalog";
import { z } from "zod";
import {
  ApplicationRouteSchema,
  ApplicationResultSchema,
} from "../../shared/application-execution";
import type { ApplicationResource } from "../../shared/application-execution";
import type { ApplicationAdapter, ApplicationAdapterContext } from "./ApplicationAdapterCatalog";
import {
  PhotoshopEditSchema,
  expectedPhotoshopEdit,
  photoshopEditUnmet,
  type PhotoshopEditInput,
} from "./photoshop-document-edit";
import type { NativeApplicationTools } from "../agent/tools/native-application-tools";

type Readback = Awaited<ReturnType<NativeApplicationTools["read"]>>;
export function photoshopEditResources(input: PhotoshopEditInput): ApplicationResource[] {
  return [input.sourcePath, input.path, input.exportPath].map((identity) => ({
    kind: "file",
    system: "local",
    identity,
    locator: identity,
  }));
}
export function createPhotoshopEditAdapter(): ApplicationAdapter {
  const route = ApplicationRouteSchema.parse({
    id: "local.photoshop.edit.v1",
    adapterId: "local-photoshop-edit",
    adapterVersion: "1",
    capability: "photoshop.document.edit",
    protocol: "native",
    control: "script",
    environment: {
      id: "macos-local-photoshop",
      kind: "desktop",
      locality: "local",
      background: true,
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
    description:
      "Edit named/nested layers of an existing PSD: text, text size/color, visibility, opacity, rename and leaf translation. Read source with local_photoshop_read to obtain layer paths and sourceSha256. Saves fresh revised PSD/PNG, preserves source and rejects unsaved documents. Local background scripting; unlocked Mac required, no VM or shell.",
    inputSchema: z.toJSONSchema(PhotoshopEditSchema),
  });
  const read = async (
    context: ApplicationAdapterContext,
    path: string,
    exportPath?: string,
  ): Promise<Readback> =>
    context.tools.call(
      "local_photoshop_read",
      { app: "photoshop", path, ...(exportPath ? { exportPath } : {}) },
      context,
    ) as Promise<Readback>;
  const collect = async (context: ApplicationAdapterContext) => {
    const input = PhotoshopEditSchema.parse(context.operation.request.input);
    const source = await read(context, input.sourcePath);
    const output = await read(context, input.path, input.exportPath);
    const unmet = photoshopEditUnmet(input, source, output);
    return {
      input,
      source,
      output,
      unmet,
      result: ApplicationResultSchema.parse({
        kind: "artifact",
        summary: "Revised editable Photoshop document and PNG; source preserved",
        resources: photoshopEditResources(input).slice(1),
        data: {
          ...output,
          source: { path: input.sourcePath, sha256: source.persisted.sha256 },
        },
        unmetCriteria: unmet,
      }),
    };
  };
  return {
    route,
    validateInput(raw, resources) {
      const input = PhotoshopEditSchema.parse(raw),
        expected = photoshopEditResources(input);
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
        throw new Error(
          "Photoshop edit resources must match the exact source and both output paths",
        );
    },
    async readiness() {
      return { ready: true };
    },
    async prepare(context) {
      const input = PhotoshopEditSchema.parse(context.operation.request.input),
        source = await read(context, input.sourcePath);
      if (source.persisted.sha256 !== input.sourceSha256)
        throw new ApplicationNotDispatchedError("Source PSD changed since planning");
      try {
        expectedPhotoshopEdit(source.model, input.changes);
      } catch (error) {
        throw new ApplicationNotDispatchedError(
          error instanceof Error ? error.message : "Invalid Photoshop edit",
        );
      }
      return {
        kind: "summary",
        summary: `Apply ${input.changes.length} layer changes to a snapshot of ${input.sourcePath}; preserve the source and save a revised PSD and PNG.\n${JSON.stringify(input.changes, null, 2)}`,
        references: photoshopEditResources(input).map((r) => r.identity),
        expiresAt: Date.now() + 15 * 60_000,
        payload: input,
      };
    },
    async execute(context) {
      await context.tools.call("local_photoshop_edit", context.operation.request.input, context);
      return { status: "completed", result: (await collect(context)).result };
    },
    async observe(context) {
      if (context.operation.pendingAction === "prepare") {
        if (["requested", "unsupported"].includes(context.operation.cancellation))
          return {
            status: "cancelled",
            summary: "Read-only preparation cancelled before Photoshop edit dispatch",
          };
        const input = PhotoshopEditSchema.parse(context.operation.request.input);
        const source = await read(context, input.sourcePath);
        if (source.persisted.sha256 !== input.sourceSha256)
          throw new ApplicationNotDispatchedError("Source PSD changed since planning");
        expectedPhotoshopEdit(source.model, input.changes);
        return {
          status: "prepared",
          prepared: {
            kind: "summary",
            summary: `Apply ${input.changes.length} layer changes; preserve source and save fresh revised PSD/PNG.`,
            references: photoshopEditResources(input).map((r) => r.identity),
            expiresAt: Date.now() + 15 * 60_000,
            payload: input,
          },
        };
      }
      return { status: "completed", result: (await collect(context)).result };
    },
    async verify(context) {
      const { input, output, unmet, result } = await collect(context);
      const prior = context.operation.result?.data as Readback | undefined;
      if (
        prior?.persisted.sha256 !== output.persisted.sha256 ||
        prior?.persisted.export?.sha256 !== output.persisted.export?.sha256
      )
        unmet.push("Revised artifacts changed since execution/readback");
      return {
        status: unmet.length ? "contradicted" : "verified",
        result,
        checkedAt: Date.now(),
        summary: unmet.length
          ? unmet.join("; ")
          : "Saved PSD layer edits and PNG verified; source SHA-256 unchanged",
        evidence: [
          {
            source: input.sourcePath,
            claim: `Source preserved: SHA-256 ${input.sourceSha256}`,
          },
          {
            source: input.path,
            claim: `Reopened saved PSD layer model matches edits: SHA-256 ${output.persisted.sha256}`,
          },
          {
            source: input.exportPath,
            claim: `PNG ${output.model.width}x${output.model.height}: SHA-256 ${output.persisted.export?.sha256}`,
          },
        ],
      };
    },
  };
}
