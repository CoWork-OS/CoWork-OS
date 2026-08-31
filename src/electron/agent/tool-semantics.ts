export type ToolArtifactKind = "none" | "document" | "spreadsheet" | "presentation" | "file";

export interface ToolSemantics {
  canonicalName: string;
  aliases: string[];
  mutatesFile: boolean;
  artifactKind: ToolArtifactKind;
  dedupeClass: string;
  requiredInputSchemaKey: string | null;
}

const TOOL_NAMESPACE_PREFIXES = new Set(["functions", "tool", "tools"]);

const TOOL_SEMANTICS_TABLE: ToolSemantics[] = [
  {
    canonicalName: "create_document",
    aliases: ["create_document", "generate_document"],
    mutatesFile: true,
    artifactKind: "document",
    dedupeClass: "document_write",
    requiredInputSchemaKey: "content",
  },
  {
    canonicalName: "create_spreadsheet",
    aliases: ["create_spreadsheet", "generate_spreadsheet"],
    mutatesFile: true,
    artifactKind: "spreadsheet",
    dedupeClass: "spreadsheet_write",
    requiredInputSchemaKey: "sheets",
  },
  {
    canonicalName: "create_presentation",
    aliases: ["create_presentation", "generate_presentation"],
    mutatesFile: true,
    artifactKind: "presentation",
    dedupeClass: "presentation_write",
    requiredInputSchemaKey: "slides",
  },
  {
    canonicalName: "write_file",
    aliases: ["write_file"],
    mutatesFile: true,
    artifactKind: "file",
    dedupeClass: "file_write",
    requiredInputSchemaKey: "content",
  },
  {
    canonicalName: "copy_file",
    aliases: ["copy_file"],
    mutatesFile: true,
    artifactKind: "file",
    dedupeClass: "file_copy",
    requiredInputSchemaKey: "destPath",
  },
  {
    canonicalName: "rename_file",
    aliases: ["rename_file"],
    mutatesFile: true,
    artifactKind: "file",
    dedupeClass: "file_rename",
    requiredInputSchemaKey: "newPath",
  },
  {
    canonicalName: "delete_file",
    aliases: ["delete_file"],
    mutatesFile: true,
    artifactKind: "file",
    dedupeClass: "file_delete",
    requiredInputSchemaKey: "path",
  },
  {
    canonicalName: "edit_file",
    aliases: ["edit_file"],
    mutatesFile: true,
    artifactKind: "file",
    dedupeClass: "file_edit",
    requiredInputSchemaKey: "new_string",
  },
  {
    canonicalName: "edit_document",
    aliases: ["edit_document"],
    mutatesFile: true,
    artifactKind: "document",
    dedupeClass: "document_edit",
    requiredInputSchemaKey: "sourcePath",
  },
  {
    canonicalName: "edit_pdf_region",
    aliases: ["edit_pdf_region"],
    mutatesFile: true,
    artifactKind: "document",
    dedupeClass: "document_edit",
    requiredInputSchemaKey: "sourcePath",
  },
  {
    canonicalName: "create_directory",
    aliases: ["create_directory"],
    mutatesFile: true,
    artifactKind: "file",
    dedupeClass: "directory_create",
    requiredInputSchemaKey: "path",
  },
  {
    canonicalName: "generate_video",
    aliases: ["generate_video"],
    mutatesFile: true,
    artifactKind: "file",
    dedupeClass: "video_generation",
    requiredInputSchemaKey: "prompt",
  },
  {
    canonicalName: "get_video_generation_job",
    aliases: ["get_video_generation_job"],
    mutatesFile: true,
    artifactKind: "file",
    dedupeClass: "video_job_poll",
    requiredInputSchemaKey: "jobId",
  },
];

const ALIAS_TO_SEMANTICS = new Map<string, ToolSemantics>();
const CANONICAL_TO_SEMANTICS = new Map<string, ToolSemantics>();

for (const semantics of TOOL_SEMANTICS_TABLE) {
  CANONICAL_TO_SEMANTICS.set(semantics.canonicalName, semantics);
  for (const alias of semantics.aliases) {
    ALIAS_TO_SEMANTICS.set(alias, semantics);
  }
}

export function stripToolNamespace(toolName: string): string {
  const raw = String(toolName || "").trim();
  if (!raw) return raw;
  if (!raw.includes(".")) return raw;

  const [prefix, ...rest] = raw.split(".");
  if (rest.length === 0) return raw;
  if (!TOOL_NAMESPACE_PREFIXES.has(prefix)) return raw;
  return rest.join(".");
}

export function normalizeToolName(toolName: string): {
  original: string;
  stripped: string;
  canonicalName: string;
  modified: boolean;
  aliasMatched: boolean;
} {
  const original = String(toolName || "").trim();
  const stripped = stripToolNamespace(original);
  const semantics = ALIAS_TO_SEMANTICS.get(stripped);
  const canonicalName = semantics ? semantics.canonicalName : stripped;
  return {
    original,
    stripped,
    canonicalName,
    modified: canonicalName !== original,
    aliasMatched: Boolean(semantics),
  };
}

export function getToolSemantics(toolName: string): ToolSemantics | null {
  const normalized = normalizeToolName(toolName);
  return ALIAS_TO_SEMANTICS.get(normalized.canonicalName) || null;
}

export function canonicalizeToolName(toolName: string): string {
  return normalizeToolName(toolName).canonicalName;
}

export function isFileMutationToolName(toolName: string): boolean {
  const semantics = getToolSemantics(toolName);
  return semantics?.mutatesFile === true;
}

export function isArtifactGenerationToolName(toolName: string): boolean {
  const semantics = getToolSemantics(toolName);
  if (!semantics) return false;
  return (
    semantics.artifactKind === "document" ||
    semantics.artifactKind === "spreadsheet" ||
    semantics.artifactKind === "presentation"
  );
}

export function getToolDedupeClass(toolName: string): string {
  const semantics = getToolSemantics(toolName);
  return semantics?.dedupeClass || canonicalizeToolName(toolName);
}

export function getAllToolSemantics(): ToolSemantics[] {
  return [...TOOL_SEMANTICS_TABLE];
}

export function getAliasesForCanonicalTool(canonicalName: string): string[] {
  const semantics = CANONICAL_TO_SEMANTICS.get(canonicalName);
  return semantics ? [...semantics.aliases] : [];
}

export function hasSemanticsAlias(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return ALIAS_TO_SEMANTICS.has(normalized.stripped);
}
