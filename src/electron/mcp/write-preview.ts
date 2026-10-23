/**
 * Preview → approve → receipt for connector writes (agent-first roadmap WP13).
 *
 * A connector tool that advertises `_meta["cowork.preview"]` in `tools/list` can describe what a
 * write would do without doing it: called with `_meta["cowork.preview"]: true`, it returns
 * `structuredContent: { status: "preview", prepared }`, where `prepared` is an
 * `ApplicationPreparedChange`. CoWork shows that in the approval. After a real write, a
 * connector can return `structuredContent.receipt`, an `ApplicationVerification` (ids, a
 * read-back), which CoWork records as evidence for the task.
 */
import {
  ApplicationPreparedChangeSchema,
  ApplicationVerificationSchema,
  type ApplicationPreparedChange,
  type ApplicationVerification,
} from "../../shared/application-execution";
import { MCP_PREVIEW_META_KEY, type MCPTool } from "./types";

const MAX_PREVIEW_TEXT = 6_000;
const MAX_FIELD_VALUE = 1_000;

/** Whether a tool says it can describe a write before doing it. */
export function supportsWritePreview(tool: Pick<MCPTool, "_meta"> | undefined): boolean {
  return tool?._meta?.[MCP_PREVIEW_META_KEY] === true;
}

function structured(result: unknown): Record<string, unknown> | undefined {
  const content = (result as { structuredContent?: unknown } | null)?.structuredContent;
  return content && typeof content === "object" && !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : undefined;
}

/** The prepared change in a preview answer, when it is well formed. */
export function parseWritePreview(result: unknown): ApplicationPreparedChange | undefined {
  const content = structured(result);
  if (content?.status !== "preview" || (result as { isError?: unknown })?.isError === true) {
    return undefined;
  }
  const parsed = ApplicationPreparedChangeSchema.safeParse(content.prepared);
  return parsed.success ? parsed.data : undefined;
}

/** The receipt of a write, when the connector returned a well-formed one. */
export function parseWriteReceipt(result: unknown): ApplicationVerification | undefined {
  const content = structured(result);
  if (!content || content.receipt === undefined) return undefined;
  const parsed = ApplicationVerificationSchema.safeParse(content.receipt);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The approval text for a prepared change: its summary, then `payload.fields` as
 * `label: value` lines, then references. Text comes from the connector, so it is bounded.
 */
export function renderWritePreview(prepared: ApplicationPreparedChange): string {
  const lines = [prepared.summary.trim()];
  const fields = Array.isArray(prepared.payload?.fields) ? prepared.payload.fields : [];
  for (const field of fields.slice(0, 40)) {
    const entry = field && typeof field === "object" ? (field as Record<string, unknown>) : {};
    const label = typeof entry.label === "string" ? entry.label.trim().slice(0, 80) : "";
    if (!label) continue;
    const raw = entry.value;
    const value =
      typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : JSON.stringify(raw);
    lines.push(
      `${label}: ${value.length > MAX_FIELD_VALUE ? `${value.slice(0, MAX_FIELD_VALUE)}…` : value}`,
    );
  }
  if (prepared.references.length > 0) {
    lines.push("", "References:", ...prepared.references.slice(0, 8).map((ref) => `- ${ref}`));
  }
  const text = lines.join("\n");
  return text.length > MAX_PREVIEW_TEXT ? `${text.slice(0, MAX_PREVIEW_TEXT)}…` : text;
}
