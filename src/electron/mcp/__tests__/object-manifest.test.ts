import { describe, expect, it } from "vitest";
import {
  OBJECT_MANIFEST_LIMITS,
  isObjectManifestTool,
  manifestFromToolResult,
  manifestToolFor,
  validateObjectManifest,
} from "../object-manifest";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    connector: "crm",
    objects: [
      {
        type: "Account",
        label: "Account",
        entityType: "organization",
        keyField: "Id",
        titleField: "Name",
        urlTemplate: "https://crm.example.com/r/Account/{id}",
        fields: [
          { name: "Id", type: "id" },
          { name: "Name", type: "string", label: "Account name" },
        ],
      },
      {
        type: "Deal",
        label: "Deal",
        entityType: "deal",
        keyField: "Id",
        fields: [
          { name: "Id", type: "id" },
          { name: "Stage", type: "enum", enum: ["Open", "Won", "Lost"] },
          { name: "AccountId", type: "reference" },
          { name: "OwnerEmail", type: "email", pii: true },
        ],
        statusField: { name: "Stage", values: ["Open", "Won", "Lost"], closed: ["Won", "Lost"] },
        relations: [{ field: "AccountId", targetType: "Account", edgeType: "belongs_to" }],
      },
    ],
    tools: [
      {
        name: "crm.get_record",
        effect: "read",
        risk: "read",
        objectArg: "object",
        recordIdArg: "id",
        resultPath: "data",
      },
      {
        name: "crm.update_record",
        effect: "update",
        risk: "external_write",
        objects: ["Deal"],
        objectArg: "object",
        recordIdArg: "id",
        preview: true,
        receipt: true,
      },
    ],
    ...overrides,
  };
}

const TOOLS = [
  {
    name: "crm.get_record",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object" as const, properties: { object: {}, id: {} } },
  },
  {
    name: "crm.update_record",
    _meta: { "cowork.preview": true },
    inputSchema: { type: "object" as const, properties: { object: {}, id: {}, fields: {} } },
  },
] as Any[];
const TOOL_NAMES = TOOLS.map((tool) => tool.name);

describe("validateObjectManifest", () => {
  it("accepts a well-formed manifest unchanged", () => {
    const result = validateObjectManifest(manifest(), TOOLS);
    expect(result).toEqual({ ok: true, manifest: manifest(), warnings: [] });
  });

  it("rejects malformed manifests whole", () => {
    const cases: unknown[] = [
      undefined,
      "manifest",
      { ...manifest(), version: 2 },
      { ...manifest(), connector: "Not A Slug" },
      { ...manifest(), objects: [] },
      manifest({
        tools: [{ name: "crm.update_record", effect: "update", risk: "read" }],
      }),
      manifest({
        tools: [{ name: "crm.get_record", effect: "read", risk: "external_write" }],
      }),
      manifest({
        objects: [{ type: "Account", label: "Account", keyField: "Id", fields: [] }],
      }),
      manifest({
        objects: [{ type: "1Account", label: "Account", keyField: "Id", fields: [{ name: "Id" }] }],
      }),
    ];
    for (const raw of cases) {
      expect(validateObjectManifest(raw, TOOLS).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it("rejects manifests over the bounds", () => {
    const fields = Array.from(
      { length: OBJECT_MANIFEST_LIMITS.maxFieldsPerObject + 1 },
      (_, i) => ({
        name: `F${i}`,
        type: "string",
      }),
    );
    const objects = Array.from({ length: OBJECT_MANIFEST_LIMITS.maxObjects + 1 }, (_, i) => ({
      type: `Object${i}`,
      label: `Object ${i}`,
      keyField: "Id",
      fields: [{ name: "Id", type: "id" }],
    }));
    const values = Array.from(
      { length: OBJECT_MANIFEST_LIMITS.maxEnumValues + 1 },
      (_, i) => `v${i}`,
    );
    const tools = Array.from({ length: OBJECT_MANIFEST_LIMITS.maxTools + 1 }, (_, i) => ({
      name: `crm.read_${i}`,
      effect: "read",
      risk: "read",
    }));
    const oversized = [
      manifest({ objects: [{ type: "A", label: "A", keyField: "Id", fields }] }),
      manifest({ objects }),
      manifest({
        objects: [
          {
            type: "A",
            label: "A",
            keyField: "Id",
            fields: [{ name: "S", type: "enum", enum: values }],
          },
        ],
      }),
      manifest({ tools }),
    ];
    for (const raw of oversized) expect(validateObjectManifest(raw).ok).toBe(false);

    const huge = manifest();
    (huge.objects[0] as { fields: unknown[] }).fields = [
      { name: "Id", type: "id", label: "x".repeat(100) },
      ...Array.from({ length: 119 }, (_, i) => ({
        name: `F${i}`,
        type: "string",
        label: "y".repeat(120),
      })),
    ];
    const many = manifest({
      objects: Array.from({ length: 24 }, (_, i) => ({ ...huge.objects[0], type: `T${i}` })),
    });
    const result = validateObjectManifest(many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/bytes; the limit is/);
  });

  it("reads an unknown field type as a string", () => {
    const raw = manifest();
    (raw.objects[0] as { fields: unknown[] }).fields.push({ name: "Geo", type: "geolocation" });
    const result = validateObjectManifest(raw, TOOLS);
    expect(result.ok && result.manifest.objects[0].fields.at(-1)).toEqual({
      name: "Geo",
      type: "string",
    });
  });

  it("drops entries that point at tools or objects the connector does not have", () => {
    const raw = manifest({
      tools: [
        ...manifest().tools,
        { name: "crm.delete_record", effect: "delete", risk: "external_write" },
        { name: "crm.get_record", effect: "read", risk: "read" },
        { name: "crm.update_record", effect: "update", risk: "external_write", objects: ["Lead"] },
      ],
    });
    (raw.objects[1] as { relations: unknown[] }).relations.push({
      field: "LeadId",
      targetType: "Lead",
      edgeType: "related_to",
    });
    const result = validateObjectManifest(raw, TOOLS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(result.manifest.objects[1].relations).toEqual([
      { field: "AccountId", targetType: "Account", edgeType: "belongs_to" },
    ]);
    expect(result.warnings).toEqual([
      "Deal.LeadId: relation to undeclared Lead dropped",
      "Tool crm.delete_record is not offered by the connector; dropped",
      "Duplicate tool crm.get_record dropped",
      "Duplicate tool crm.update_record dropped",
    ]);
  });

  it("narrows a tool's object scope to declared objects", () => {
    const raw = manifest({
      tools: [{ name: "crm.get_record", effect: "read", risk: "read", objects: ["Deal", "Lead"] }],
    });
    const result = validateObjectManifest(raw, TOOLS);
    expect(result.ok && result.manifest.tools[0].objects).toEqual(["Deal"]);
  });

  it("drops url templates that are not https with exactly one {id}", () => {
    for (const urlTemplate of [
      "http://crm.example.com/{id}",
      "https://crm.example.com/{id}/{id}",
      "https://crm.example.com/{org}/{id}",
      "https://crm.example.com/static",
      "javascript:alert(1)//{id}",
      "https://{id}.crm.example.com/r",
      "https://crm.{id}/r",
      "https://{id}@crm.example.com/r",
      `https://crm.example.com/${"a".repeat(512)}/{id}`,
    ]) {
      const raw = manifest();
      (raw.objects[0] as { urlTemplate: string }).urlTemplate = urlTemplate;
      const result = validateObjectManifest(raw, TOOLS);
      expect(result.ok, urlTemplate).toBe(true);
      if (!result.ok) continue;
      expect(result.manifest.objects[0].urlTemplate, urlTemplate).toBeUndefined();
      expect(result.warnings[0]).toMatch(/^Account: url template/);
    }
  });

  it("drops duplicate objects and fields and a status field that is not a field", () => {
    const raw = manifest();
    raw.objects.push({ ...raw.objects[0] });
    (raw.objects[0] as { fields: unknown[] }).fields.push({ name: "Name", type: "text" });
    (raw.objects[1] as { statusField: unknown }).statusField = { name: "Phase", values: ["A"] };
    const result = validateObjectManifest(raw, TOOLS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.objects).toHaveLength(2);
    expect(result.manifest.objects[0].fields.map((field) => field.name)).toEqual(["Id", "Name"]);
    expect(result.manifest.objects[1].statusField).toBeUndefined();
  });
});

describe("tool claims against the tool's own definition", () => {
  it("ignores keys it does not know, so connectors can add optional ones", () => {
    const raw = { ...manifest(), extra: true };
    (raw.objects[0] as Record<string, unknown>).description = "Companies";
    (raw.objects[0].fields[0] as Record<string, unknown>).custom = true;
    (raw.tools[0] as Record<string, unknown>).cost = "low";
    expect(validateObjectManifest(raw, TOOLS)).toEqual({
      ok: true,
      manifest: manifest(),
      warnings: [],
    });
  });

  it("never takes a tool that says it writes as a read", () => {
    const tools = [
      { name: "crm.preview_write", _meta: { "cowork.preview": true } },
      { name: "crm.not_read_only", annotations: { readOnlyHint: false } },
      { name: "crm.destructive", annotations: { destructiveHint: true } },
      { name: "crm.plain" },
    ] as Any[];
    const raw = manifest({
      tools: tools.map((tool) => ({ name: tool.name, effect: "read", risk: "read" })),
    });
    const result = validateObjectManifest(raw, tools);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.tools.map((tool) => tool.name)).toEqual(["crm.plain"]);
    expect(result.warnings).toEqual([
      "Tool crm.preview_write is declared a read but writes; dropped",
      "Tool crm.not_read_only is declared a read but writes; dropped",
      "Tool crm.destructive is declared a read but writes; dropped",
    ]);
  });

  it("removes a preview or argument the tool does not have", () => {
    const tools = [
      { name: "crm.get_record", inputSchema: { type: "object", properties: { id: {} } } },
      { name: "crm.update_record", inputSchema: { type: "object", properties: { id: {} } } },
    ] as Any[];
    const result = validateObjectManifest(manifest(), tools);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.tools).toEqual([
      {
        name: "crm.get_record",
        effect: "read",
        risk: "read",
        recordIdArg: "id",
        resultPath: "data",
      },
      {
        name: "crm.update_record",
        effect: "update",
        risk: "external_write",
        objects: ["Deal"],
        recordIdArg: "id",
        receipt: true,
      },
    ]);
    expect(result.warnings).toEqual([
      "Tool crm.get_record: objectArg object does not fit the tool; dropped",
      "Tool crm.update_record: preview true does not fit the tool; dropped",
      "Tool crm.update_record: objectArg object does not fit the tool; dropped",
    ]);
  });

  it("does not take an entry for the manifest tool itself", () => {
    const tools = [
      ...TOOLS,
      { name: "crm.describe_objects", _meta: { "cowork.objectManifest": true } },
    ];
    const raw = manifest({
      tools: [...manifest().tools, { name: "crm.describe_objects", effect: "read", risk: "read" }],
    });
    const result = validateObjectManifest(raw, tools);
    expect(result.ok && result.manifest.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });
});

describe("manifest helpers", () => {
  it("recognizes the manifest tool by its _meta flag only", () => {
    expect(isObjectManifestTool({ _meta: { "cowork.objectManifest": true } })).toBe(true);
    expect(isObjectManifestTool({ _meta: { "cowork.objectManifest": "true" } })).toBe(false);
    expect(isObjectManifestTool({})).toBe(false);
    expect(isObjectManifestTool(undefined)).toBe(false);
  });

  it("reads the manifest from structured content or the text block", () => {
    const value = manifest();
    expect(manifestFromToolResult({ content: [], structuredContent: value })).toEqual(value);
    expect(
      manifestFromToolResult({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    ).toEqual(value);
    expect(
      manifestFromToolResult({ content: [{ type: "text", text: "{" }], isError: false }),
    ).toBeUndefined();
    expect(
      manifestFromToolResult({ content: [], structuredContent: value, isError: true }),
    ).toBeUndefined();
    expect(
      manifestFromToolResult({
        content: [{ type: "text", text: " ".repeat(OBJECT_MANIFEST_LIMITS.maxBytes + 1) }],
      }),
    ).toBeUndefined();
  });

  it("matches a namespaced tool by the server's own name", () => {
    const result = validateObjectManifest(manifest(), TOOLS);
    if (!result.ok) throw new Error(result.error);
    expect(
      manifestToolFor(result.manifest, {
        name: "crm_2__crm.update_record",
        serverToolName: "crm.update_record",
      })?.effect,
    ).toBe("update");
    expect(manifestToolFor(result.manifest, { name: "crm.search" })).toBeUndefined();
  });
});
