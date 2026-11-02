/**
 * Connector object manifests (business context layer, Phase A1).
 *
 * A connector can list a tool with `_meta: { "cowork.objectManifest": true }`, conventionally
 * `<connector>.describe_objects`. CoWork calls it itself, never shows it to the model, and gets
 * back which business objects the connector holds (fields, status values, relations) and which
 * of its tools read or write each one, with the risk of each write. Later layers bind graph
 * entities to these records and give workflows a risk per action instead of a blanket
 * `external_write`.
 *
 * Field names (fields, `titleField`, `statusField.name`, `relations[].field`) are dot paths into
 * a record's fields, which sit under `fieldsPath` when it is set (HubSpot `properties`, Jira
 * `fields`) and at the record's top level otherwise. `keyField` is always read at the top level.
 *
 * The manifest comes from the connector, local or remote, so it is untrusted input: it is
 * parsed against a bounded schema, oversized or malformed manifests are rejected whole, and
 * entries that point at tools or objects the connector does not have are dropped. A manifest
 * can only make CoWork more careful than the tool's own definition: a tool whose definition
 * says it writes (a preview, `readOnlyHint: false`, `destructiveHint: true`) is never taken as
 * a read, and a preview is only claimed for a tool that advertises one. Unknown keys are
 * ignored, so a connector can add optional ones; a change older clients must not read bumps
 * `version`.
 */
import { z } from "zod";
import { MCP_OBJECT_MANIFEST_META_KEY, type MCPCallResult, type MCPTool } from "./types";
import { supportsWritePreview } from "./write-preview";

export const OBJECT_MANIFEST_LIMITS = {
  /** Serialized size of one manifest. */
  maxBytes: 256 * 1024,
  maxObjects: 24,
  maxFieldsPerObject: 120,
  maxEnumValues: 64,
  maxRelationsPerObject: 16,
  maxTools: 64,
} as const;

const OBJECT_TYPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_.$:-]{0,119}$/;
const SLUG = /^[a-z][a-z0-9_-]{0,39}$/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESULT_PATH = /^[A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,5}$/;
const MAX_URL_TEMPLATE = 512;

const label = z.string().trim().min(1).max(120);
const enumValues = z
  .array(z.string().trim().min(1).max(120))
  .max(OBJECT_MANIFEST_LIMITS.maxEnumValues);

export const OBJECT_FIELD_TYPES = [
  "id",
  "string",
  "text",
  "number",
  "currency",
  "percent",
  "boolean",
  "date",
  "datetime",
  "enum",
  "reference",
  "email",
  "phone",
  "url",
  "json",
] as const;

const FieldSchema = z.object({
  name: z.string().regex(FIELD_NAME),
  // A type CoWork does not know reads as a string rather than failing the manifest.
  type: z.enum(OBJECT_FIELD_TYPES).catch("string"),
  label: label.optional(),
  enum: enumValues.optional(),
  /** Personal data: kept out of the knowledge graph unless an admin allows it. */
  pii: z.boolean().optional(),
});

const RelationSchema = z.object({
  field: z.string().regex(FIELD_NAME),
  targetType: z.string().regex(OBJECT_TYPE),
  edgeType: z.string().regex(SLUG),
});

const ObjectSchema = z.object({
  type: z.string().regex(OBJECT_TYPE),
  label,
  /** Suggested knowledge-graph entity type (account, contact, deal, ticket, issue, …). */
  entityType: z.string().regex(SLUG).optional(),
  keyField: z.string().regex(FIELD_NAME),
  titleField: z.string().regex(FIELD_NAME).optional(),
  /** Where the record's fields sit inside a record, e.g. `properties` for HubSpot. */
  fieldsPath: z.string().regex(RESULT_PATH).optional(),
  /** `https://…/{id}`: the record's page, `{id}` replaced by the key field's value. */
  urlTemplate: z.string().optional(),
  fields: z.array(FieldSchema).min(1).max(OBJECT_MANIFEST_LIMITS.maxFieldsPerObject),
  statusField: z
    .object({
      name: z.string().regex(FIELD_NAME),
      /** In workflow order. */
      values: enumValues.min(1),
      /** Values that end the record's lifecycle (won, closed, done). */
      closed: enumValues.optional(),
    })
    .optional(),
  relations: z.array(RelationSchema).max(OBJECT_MANIFEST_LIMITS.maxRelationsPerObject).optional(),
});

const ToolSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    effect: z.enum(["read", "create", "update", "delete"]),
    risk: z.enum(["read", "external_write", "data_export"]),
    /** Object types the tool acts on; omitted means every object in the manifest. */
    objects: z
      .array(z.string().regex(OBJECT_TYPE))
      .max(OBJECT_MANIFEST_LIMITS.maxObjects)
      .optional(),
    /** Argument that names the object type, for a tool that works on several. */
    objectArg: z.string().regex(ARG_NAME).optional(),
    /** Argument that carries the record's key. */
    recordIdArg: z.string().regex(ARG_NAME).optional(),
    /** Where the record (or list of records) sits in the tool's JSON result, for reads. */
    resultPath: z.string().regex(RESULT_PATH).optional(),
    preview: z.boolean().optional(),
    receipt: z.boolean().optional(),
  })
  .refine((tool) => (tool.effect === "read") === (tool.risk !== "external_write"), {
    message: "A read must not be an external_write, and a write must be one",
  });

const ManifestSchema = z.object({
  version: z.literal(1),
  connector: z.string().regex(SLUG),
  objects: z.array(ObjectSchema).min(1).max(OBJECT_MANIFEST_LIMITS.maxObjects),
  tools: z.array(ToolSchema).max(OBJECT_MANIFEST_LIMITS.maxTools),
});

export type ConnectorObjectField = z.infer<typeof FieldSchema>;
export type ConnectorObjectDefinition = z.infer<typeof ObjectSchema>;
export type ConnectorObjectTool = z.infer<typeof ToolSchema>;
export type ConnectorObjectManifest = z.infer<typeof ManifestSchema>;

/** A tool as the server lists it; the more of its definition is given, the more is checked. */
export type ObjectManifestServerTool = Pick<MCPTool, "name"> &
  Partial<Pick<MCPTool, "_meta" | "annotations" | "inputSchema">>;

export type ObjectManifestValidation =
  | { ok: true; manifest: ConnectorObjectManifest; warnings: string[] }
  | { ok: false; error: string };

/** Whether a tool is the connector's object manifest rather than a tool for the model. */
export function isObjectManifestTool(tool: Pick<MCPTool, "_meta"> | undefined): boolean {
  return tool?._meta?.[MCP_OBJECT_MANIFEST_META_KEY] === true;
}

function urlTemplateProblem(template: string): string | undefined {
  if (template.length > MAX_URL_TEMPLATE) return `is longer than ${MAX_URL_TEMPLATE} characters`;
  if (!template.startsWith("https://")) return "must start with https://";
  const placeholders = template.match(/\{[^}]*\}/g) ?? [];
  if (placeholders.length !== 1 || placeholders[0] !== "{id}") return "must hold one {id}";
  const marker = "cowork-record-id";
  let url: URL;
  try {
    url = new URL(template.replace("{id}", marker));
  } catch {
    return "is not a URL";
  }
  // The record id may pick the page, never the site.
  if (url.origin.includes(marker) || url.username || url.password) {
    return "must keep {id} in the path or query";
  }
  return undefined;
}

/** Why a manifest entry's claims do not fit the tool's own definition, if they do not. */
function toolClaimProblems(
  entry: ConnectorObjectTool,
  tool: ObjectManifestServerTool,
): { drop?: string; strip: Array<"preview" | "objectArg" | "recordIdArg"> } {
  const writes =
    supportsWritePreview(tool) ||
    tool.annotations?.readOnlyHint === false ||
    tool.annotations?.destructiveHint === true;
  if (entry.effect === "read" && writes)
    return { drop: "is declared a read but writes", strip: [] };
  const strip: Array<"preview" | "objectArg" | "recordIdArg"> = [];
  if (entry.preview && !supportsWritePreview(tool)) strip.push("preview");
  const properties = tool.inputSchema?.properties;
  if (properties) {
    for (const key of ["objectArg", "recordIdArg"] as const) {
      const arg = entry[key];
      if (arg !== undefined && !Object.hasOwn(properties, arg)) strip.push(key);
    }
  }
  return { strip };
}

/**
 * Parse a manifest. `serverTools` are the tools the connector listed: entries for any other
 * tool (or the manifest tool itself) are dropped, a read claimed for a tool that says it
 * writes is dropped, and a preview or argument the tool does not have is removed from its
 * entry. Relations and tool scopes naming undeclared objects, duplicate object types and
 * fields, and url templates that are not `https://…{id}…` are dropped too.
 */
export function validateObjectManifest(
  raw: unknown,
  serverTools?: ReadonlyArray<ObjectManifestServerTool>,
): ObjectManifestValidation {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
  } catch {
    return { ok: false, error: "Manifest is not serializable" };
  }
  if (size > OBJECT_MANIFEST_LIMITS.maxBytes) {
    return {
      ok: false,
      error: `Manifest is ${size} bytes; the limit is ${OBJECT_MANIFEST_LIMITS.maxBytes}`,
    };
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `Invalid manifest at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "malformed"}`,
    };
  }

  const warnings: string[] = [];
  const manifest = parsed.data;
  const objects: ConnectorObjectDefinition[] = [];
  const types = new Set<string>();
  for (const object of manifest.objects) {
    if (types.has(object.type)) {
      warnings.push(`Duplicate object ${object.type} dropped`);
      continue;
    }
    types.add(object.type);
    const names = new Set<string>();
    const fields = object.fields.filter((field) => {
      if (names.has(field.name)) return false;
      names.add(field.name);
      return true;
    });
    const next: ConnectorObjectDefinition = { ...object, fields };
    if (next.urlTemplate !== undefined) {
      const problem = urlTemplateProblem(next.urlTemplate);
      if (problem) {
        warnings.push(`${object.type}: url template ${problem}; dropped`);
        delete next.urlTemplate;
      }
    }
    if (next.statusField && !names.has(next.statusField.name)) {
      warnings.push(
        `${object.type}: status field ${next.statusField.name} is not a field; dropped`,
      );
      delete next.statusField;
    }
    objects.push(next);
  }
  for (const object of objects) {
    if (!object.relations) continue;
    object.relations = object.relations.filter((relation) => {
      if (types.has(relation.targetType)) return true;
      warnings.push(
        `${object.type}.${relation.field}: relation to undeclared ${relation.targetType} dropped`,
      );
      return false;
    });
  }

  const known = serverTools
    ? new Map(
        serverTools.filter((tool) => !isObjectManifestTool(tool)).map((tool) => [tool.name, tool]),
      )
    : undefined;
  const toolNames = new Set<string>();
  const tools: ConnectorObjectTool[] = [];
  for (const tool of manifest.tools) {
    const definition = known?.get(tool.name);
    if (known && !definition) {
      warnings.push(`Tool ${tool.name} is not offered by the connector; dropped`);
      continue;
    }
    if (definition) {
      const { drop, strip } = toolClaimProblems(tool, definition);
      if (drop) {
        warnings.push(`Tool ${tool.name} ${drop}; dropped`);
        continue;
      }
      for (const key of strip) {
        warnings.push(
          `Tool ${tool.name}: ${key} ${String(tool[key])} does not fit the tool; dropped`,
        );
        delete tool[key];
      }
    }
    if (toolNames.has(tool.name)) {
      warnings.push(`Duplicate tool ${tool.name} dropped`);
      continue;
    }
    if (tool.objects) {
      const scoped = tool.objects.filter((type) => types.has(type));
      if (scoped.length === 0) {
        warnings.push(`Tool ${tool.name} names no declared object; dropped`);
        continue;
      }
      tool.objects = scoped;
    }
    toolNames.add(tool.name);
    tools.push(tool);
  }

  return { ok: true, manifest: { ...manifest, objects, tools }, warnings };
}

/**
 * The manifest in a `describe_objects` result: `structuredContent`, or the JSON of the first
 * text block. Text longer than the manifest limit is not parsed.
 */
export function manifestFromToolResult(result: MCPCallResult | undefined): unknown {
  if (!result || result.isError) return undefined;
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) return structured;
  const block = result.content?.find((entry) => entry.type === "text");
  const text = block && "text" in block ? block.text : undefined;
  if (typeof text !== "string" || text.length > OBJECT_MANIFEST_LIMITS.maxBytes) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The manifest entry for a tool the connector lists, matched by the server's own name. */
export function manifestToolFor(
  manifest: ConnectorObjectManifest,
  tool: Pick<MCPTool, "name" | "serverToolName">,
): ConnectorObjectTool | undefined {
  const name = tool.serverToolName ?? tool.name;
  return manifest.tools.find((entry) => entry.name === name);
}
