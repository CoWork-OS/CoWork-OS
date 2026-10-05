/**
 * Line text for `repo:<path>#L<n>` refs ("memory used" attribution, design §6.1). Main side
 * of the `memoryRepo:readLines` IPC: refs come from the renderer, so each is parsed and
 * path-checked (`parseMemoryRepoRef`), the count is capped, and the text is redacted like the
 * prompt block. It is plain text for display (React escapes it), not tag-escaped.
 */
import { redactSensitiveMarkdownContent } from "../markdown-index-sql";
import { MemoryRepoService } from "./MemoryRepoService";
import { parseMemoryRepoRef, type MemoryRepoAuthor } from "./memory-repo-format";
import { MEMORY_REPO_READ_LINES_MAX, type MemoryRepoLine } from "../../../shared/memory-repo-types";

export type { MemoryRepoLine };

export async function readMemoryRepoLines(
  refs: unknown,
  getService: () => MemoryRepoService | null = () => MemoryRepoService.get(),
): Promise<MemoryRepoLine[]> {
  if (!Array.isArray(refs)) return [];
  const service = getService();
  if (!service || !service.isReady()) return [];
  const unique = [
    ...new Set(refs.filter((ref): ref is string => typeof ref === "string" && ref.length <= 600)),
  ].slice(0, MEMORY_REPO_READ_LINES_MAX);
  const out: MemoryRepoLine[] = [];
  for (const ref of unique) {
    const parsed = parseMemoryRepoRef(ref);
    if (!parsed) continue;
    let text = "";
    let by: MemoryRepoAuthor | null = null;
    try {
      const entry = await service.entryAt(parsed.path, parsed.line);
      if (entry) {
        text = redactSensitiveMarkdownContent(entry.text)
          .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        by = entry.by;
      }
    } catch {
      text = "";
    }
    out.push({ ref, text, path: parsed.path, by });
  }
  return out;
}
