/**
 * Reconcile the numbered citations of a final answer onto one numbering map.
 *
 * The model cites the task's source registry with [N] markers, and it may also
 * write its own numbered source list that restarts at 1. When both appear, one
 * number can name two different sources: an inline [9] taken from the registry
 * can point at entry 9 of the model's list, which is another page. This module
 * rewrites the answer so every inline marker and every source-list label uses
 * one identity per source:
 *
 * - With a non-empty registry, numbers are registry indices, which is also the
 *   numbering the sources panel and inline citation badges use.
 * - Without a registry, numbers are the answer's own source-list numbers.
 *
 * A direct Markdown link immediately before a single marker is the strongest
 * identity signal for that marker. Other markers are read against the answer's
 * own list or the registry, whichever resolves them coherently. Markers that do
 * not resolve, or that cite a source belonging to another compared entity (a
 * table row about one vendor citing a page of a vendor in another row), are
 * removed and reported. Markdown links are never rewritten.
 */

export interface AnswerCitationSource {
  index: number;
  url: string;
  title?: string;
}

export interface DroppedAnswerCitation {
  /** The original marker text, e.g. "[6, 7]". */
  marker: string;
  /** The cited number that was removed. */
  number: number;
  reason: "unknown_source" | "misattributed";
}

export interface AnswerCitationReconciliation {
  text: string;
  changed: boolean;
  /** Inline markers whose numbers were rewritten (removed markers excluded). */
  renumberedMarkers: number;
  dropped: DroppedAnswerCitation[];
  /** True when the answer's own source list was renumbered or completed. */
  bibliographyRewritten: boolean;
}

export interface ReconcileAnswerCitationsOptions {
  /**
   * Register a URL the answer cites but the registry does not contain, and
   * return its new registry index. Used only when the registry is non-empty.
   */
  registerSource?: (url: string, title: string) => number | undefined;
}

interface BibliographyEntry {
  lineIndex: number;
  number: number;
  indent: string;
  /** Entry content after its number label. */
  content: string;
  url: string;
  title: string;
}

interface Bibliography {
  headingLineIndex: number;
  firstEntryLineIndex: number;
  lastEntryLineIndex: number;
  entries: BibliographyEntry[];
}

interface EntityIndex {
  entities: Array<{ labelLower: string; tokens: string[] }>;
  hostToEntity: Map<string, number>;
}

type MemberStatus = "coherent" | "unknown" | "incoherent" | "unresolved";

interface MarkerGroup {
  lineIndex: number;
  start: number;
  end: number;
  marker: string;
  numbers: number[];
  anchor?: { url: string; title: string };
  mentioned: Set<number>;
}

interface Interpretation {
  kind: "bibliography" | "registry";
  members: Array<{ url?: string; title: string; status: MemberStatus }>;
  score: number;
}

const MARKDOWN_LINK_REGEX = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"\n]*")?\)/g;
const BARE_URL_REGEX = /https?:\/\/[^\s<>()[\]"'`]+/g;
const MARKER_REGEX = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?![(:[])/g;
const ANCHORED_LINK_BEFORE_MARKER_REGEX =
  /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"\n]*")?\)\s*$/;
const BIBLIOGRAPHY_HEADING_REGEX =
  /^\s{0,3}(?:#{1,6}\s+)?(?:\*\*|__)?\s*(?:[A-Za-z]+\s+){0,2}(?:sources?|references?|citations?|bibliography|works\s+cited)\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/i;
const ORDERED_ENTRY_REGEX = /^(\s*)(\d{1,3})[.)]\s+(.+)$/;
const BRACKET_ENTRY_REGEX = /^(\s*)(?:[-*+]\s+)?\[(\d{1,3})\]:?\s+(.+)$/;
const FENCE_REGEX = /^\s{0,3}(```|~~~)/;
const TABLE_SEPARATOR_CELL_REGEX = /^\s*:?-{2,}:?\s*$/;
const SECOND_LEVEL_PUBLIC_SUFFIX_LABELS = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

function normalizeUrl(url: string): string {
  return String(url || "")
    .trim()
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function trimBareUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

/** Approximate registrable domain, so docs.vendor.com and support.vendor.com match. */
function hostKey(url: string): string | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last = labels[labels.length - 1];
  const secondLast = labels[labels.length - 2];
  const keep = last.length === 2 && SECOND_LEVEL_PUBLIC_SUFFIX_LABELS.has(secondLast) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plainText(markdown: string): string {
  return markdown
    .replace(MARKDOWN_LINK_REGEX, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenTitle(title: string): string {
  const flat = String(title || "")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

function computeFenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_REGEX.test(line)) {
      mask.push(true);
      inFence = !inFence;
      continue;
    }
    mask.push(inFence);
  }
  return mask;
}

function inlineCodeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const regex = /(`+)[^`]*?\1/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function unescapedPipePositions(line: string): number[] {
  const positions: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|" && line[index - 1] !== "\\") positions.push(index);
  }
  return positions;
}

function isTableRow(line: string): boolean {
  return /^\s*\|/.test(line) && unescapedPipePositions(line).length >= 2;
}

function tableCells(line: string): string[] {
  const pipes = unescapedPipePositions(line);
  const cells: string[] = [];
  for (let index = 0; index + 1 < pipes.length; index += 1) {
    cells.push(line.slice(pipes[index] + 1, pipes[index + 1]));
  }
  return cells;
}

function isTableSeparatorRow(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL_REGEX.test(cell));
}

function firstUrl(content: string): { url: string; title: string } | undefined {
  MARKDOWN_LINK_REGEX.lastIndex = 0;
  const link = MARKDOWN_LINK_REGEX.exec(content);
  MARKDOWN_LINK_REGEX.lastIndex = 0;
  if (link) return { url: link[2], title: link[1] };
  BARE_URL_REGEX.lastIndex = 0;
  const bare = BARE_URL_REGEX.exec(content);
  BARE_URL_REGEX.lastIndex = 0;
  if (!bare) return undefined;
  const url = trimBareUrl(bare[0]);
  const title = content
    .replace(bare[0], "")
    .replace(/[\s—–:|-]+$/, "")
    .trim();
  return { url, title: title || url };
}

function lineUrls(line: string): string[] {
  const urls: string[] = [];
  for (const match of line.matchAll(MARKDOWN_LINK_REGEX)) urls.push(match[2]);
  const withoutLinks = line.replace(MARKDOWN_LINK_REGEX, " ");
  for (const match of withoutLinks.matchAll(BARE_URL_REGEX)) urls.push(trimBareUrl(match[0]));
  return urls;
}

/**
 * Find the answer's own numbered source list: the last source-list heading
 * followed by numbered entries. Returns "unusable" when such a list exists but
 * an entry has no URL or a number repeats, because its identities cannot be
 * established and rewriting around it could corrupt the answer.
 */
function findBibliography(lines: string[], fenceMask: boolean[]): Bibliography | "unusable" | null {
  for (let headingIndex = lines.length - 1; headingIndex >= 0; headingIndex -= 1) {
    if (fenceMask[headingIndex]) continue;
    const heading = lines[headingIndex];
    if (heading.length > 80 || !BIBLIOGRAPHY_HEADING_REGEX.test(heading)) continue;
    const entries: BibliographyEntry[] = [];
    let unusable = false;
    let lastEntryLineIndex = -1;
    for (let lineIndex = headingIndex + 1; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (fenceMask[lineIndex]) break;
      if (!line.trim()) continue;
      const match = ORDERED_ENTRY_REGEX.exec(line) || BRACKET_ENTRY_REGEX.exec(line);
      if (!match) break;
      const content = match[3];
      const source = firstUrl(content);
      const number = Number.parseInt(match[2], 10);
      if (!source || entries.some((entry) => entry.number === number)) {
        unusable = true;
        break;
      }
      entries.push({
        lineIndex,
        number,
        indent: match[1],
        content,
        url: source.url,
        title: source.title,
      });
      lastEntryLineIndex = lineIndex;
    }
    if (unusable) return "unusable";
    if (entries.length === 0) continue;
    return {
      headingLineIndex: headingIndex,
      firstEntryLineIndex: entries[0].lineIndex,
      lastEntryLineIndex,
      entries,
    };
  }
  return null;
}

/**
 * Comparison tables usually give each compared entity its own row, with direct
 * links to that entity's pages. When every linked host belongs to exactly one
 * row, a row label identifies whose sources a sentence may cite.
 */
function buildEntityIndex(lines: string[], fenceMask: boolean[]): EntityIndex | null {
  const rows: Array<{ label: string; hosts: Set<string> }> = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (fenceMask[lineIndex] || !isTableRow(line) || isTableSeparatorRow(line)) continue;
    const next = lines[lineIndex + 1];
    if (next !== undefined && isTableRow(next) && isTableSeparatorRow(next)) continue;
    const label = plainText(tableCells(line)[0] || "");
    if (!label || label.length > 60) continue;
    const hosts = new Set<string>();
    for (const url of lineUrls(line)) {
      const host = hostKey(url);
      if (host) hosts.add(host);
    }
    if (hosts.size > 0) rows.push({ label, hosts });
  }
  if (rows.length < 2) return null;
  const labels = new Set(rows.map((row) => row.label.toLowerCase()));
  if (labels.size !== rows.length) return null;
  const hostToEntity = new Map<string, number>();
  for (const [rowIndex, row] of rows.entries()) {
    for (const host of row.hosts) {
      const owner = hostToEntity.get(host);
      if (owner !== undefined && owner !== rowIndex) return null;
      hostToEntity.set(host, rowIndex);
    }
  }
  const words = rows.map((row) =>
    (row.label.match(/[A-Za-z][A-Za-z0-9+&]{2,}/g) || []).filter((word) => /^[A-Z]/.test(word)),
  );
  const entities = rows.map((row, rowIndex) => ({
    labelLower: row.label.toLowerCase(),
    tokens: words[rowIndex].filter(
      (word) =>
        !words.some(
          (other, otherIndex) =>
            otherIndex !== rowIndex &&
            other.some((candidate) => candidate.toLowerCase() === word.toLowerCase()),
        ),
    ),
  }));
  return { entities, hostToEntity };
}

function mentionedEntities(text: string, index: EntityIndex | null): Set<number> {
  const mentioned = new Set<number>();
  if (!index || !text.trim()) return mentioned;
  const lower = text.toLowerCase();
  for (const [entityIndex, entity] of index.entities.entries()) {
    if (lower.includes(entity.labelLower)) {
      mentioned.add(entityIndex);
      continue;
    }
    for (const token of entity.tokens) {
      if (new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`).test(text)) {
        mentioned.add(entityIndex);
        break;
      }
    }
  }
  return mentioned;
}

function coherence(url: string, mentioned: Set<number>, index: EntityIndex | null): MemberStatus {
  if (!index || mentioned.size === 0) return "unknown";
  const host = hostKey(url);
  const owner = host ? index.hostToEntity.get(host) : undefined;
  if (owner === undefined) return "unknown";
  return mentioned.has(owner) ? "coherent" : "incoherent";
}

function isAcceptable(status: MemberStatus): boolean {
  return status === "coherent" || status === "unknown";
}

export function reconcileAnswerCitations(
  text: string,
  registry: readonly AnswerCitationSource[],
  options: ReconcileAnswerCitationsOptions = {},
): AnswerCitationReconciliation {
  const unchanged: AnswerCitationReconciliation = {
    text,
    changed: false,
    renumberedMarkers: 0,
    dropped: [],
    bibliographyRewritten: false,
  };
  if (typeof text !== "string" || !/\[\d/.test(text)) return unchanged;

  const lines = text.split("\n");
  const fenceMask = computeFenceMask(lines);
  const bibliography = findBibliography(lines, fenceMask);
  if (bibliography === "unusable") return unchanged;

  const registryByIndex = new Map<number, AnswerCitationSource>();
  const registryByUrl = new Map<string, number>();
  for (const source of Array.isArray(registry) ? registry : []) {
    if (!source || typeof source.url !== "string" || !source.url.trim()) continue;
    if (!Number.isInteger(source.index) || source.index <= 0) continue;
    registryByIndex.set(source.index, source);
    const key = normalizeUrl(source.url);
    if (!registryByUrl.has(key)) registryByUrl.set(key, source.index);
  }
  const useRegistry = registryByIndex.size > 0;
  if (!useRegistry && !bibliography) return unchanged;

  const bibliographyByNumber = new Map<number, BibliographyEntry>();
  const bibliographyNumberByUrl = new Map<string, number>();
  for (const entry of bibliography?.entries || []) {
    bibliographyByNumber.set(entry.number, entry);
    const key = normalizeUrl(entry.url);
    if (!bibliographyNumberByUrl.has(key)) bibliographyNumberByUrl.set(key, entry.number);
  }

  // One identity → number map for the whole answer.
  let nextIndex =
    Math.max(0, ...(useRegistry ? registryByIndex.keys() : bibliographyByNumber.keys())) + 1;
  const assignedByUrl = new Map<string, number>();
  const unlistedSources = new Map<number, { url: string; title: string }>();
  const canonicalIndexFor = (url: string, title: string): number => {
    const key = normalizeUrl(url);
    const known = useRegistry ? registryByUrl.get(key) : bibliographyNumberByUrl.get(key);
    if (known !== undefined) return known;
    const prior = assignedByUrl.get(key);
    if (prior !== undefined) return prior;
    const registered = useRegistry ? options.registerSource?.(url, title) : undefined;
    const index =
      typeof registered === "number" &&
      Number.isInteger(registered) &&
      registered > 0 &&
      !registryByIndex.has(registered)
        ? registered
        : nextIndex;
    nextIndex = Math.max(nextIndex, index + 1);
    assignedByUrl.set(key, index);
    unlistedSources.set(index, { url, title });
    return index;
  };
  const sourceFor = (index: number): { url: string; title: string } | undefined => {
    const registered = registryByIndex.get(index);
    if (useRegistry && registered) {
      return { url: registered.url, title: registered.title || registered.url };
    }
    const listed = bibliographyByNumber.get(index);
    if (!useRegistry && listed) return { url: listed.url, title: listed.title };
    return unlistedSources.get(index);
  };

  // Resolve the answer's own list first so its entries get stable identities.
  const entryCanonical = new Map<BibliographyEntry, number>();
  for (const entry of bibliography?.entries || []) {
    entryCanonical.set(entry, canonicalIndexFor(entry.url, entry.title));
  }

  const entityIndex = buildEntityIndex(lines, fenceMask);
  const groups: MarkerGroup[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (fenceMask[lineIndex]) continue;
    if (
      bibliography &&
      lineIndex >= bibliography.headingLineIndex &&
      lineIndex <= bibliography.lastEntryLineIndex
    ) {
      continue;
    }
    const line = lines[lineIndex];
    if (!/\[\d/.test(line)) continue;
    const codeRanges = inlineCodeRanges(line);
    const tableRow = isTableRow(line) && !isTableSeparatorRow(line);
    const pipes = tableRow ? unescapedPipePositions(line) : [];
    const rowLabelMentions = tableRow
      ? mentionedEntities(plainText(tableCells(line)[0] || ""), entityIndex)
      : new Set<number>();
    let previousMarkerEnd = 0;
    for (const match of line.matchAll(MARKER_REGEX)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (codeRanges.some(([from, to]) => start >= from && start < to)) continue;
      if (/[A-Za-z0-9_\]\\]/.test(line[start - 1] || "")) continue;
      const numbers = match[1].split(",").map((value) => Number.parseInt(value.trim(), 10));
      const cellStart = tableRow
        ? pipes.filter((position) => position < start).reduce((_, position) => position + 1, 0)
        : 0;
      const segment = line.slice(Math.max(cellStart, previousMarkerEnd), start);
      previousMarkerEnd = end;
      let mentioned = mentionedEntities(plainText(segment), entityIndex);
      if (mentioned.size === 0 && tableRow) mentioned = rowLabelMentions;
      const anchorMatch =
        numbers.length === 1 ? ANCHORED_LINK_BEFORE_MARKER_REGEX.exec(line.slice(0, start)) : null;
      groups.push({
        lineIndex,
        start,
        end,
        marker: match[0],
        numbers,
        ...(anchorMatch ? { anchor: { url: anchorMatch[2], title: anchorMatch[1] } } : {}),
        mentioned,
      });
    }
  }
  if (groups.length === 0 && !bibliography) return unchanged;

  const interpret = (group: MarkerGroup, kind: Interpretation["kind"]): Interpretation => {
    const members = group.numbers.map((number) => {
      const source =
        kind === "bibliography"
          ? bibliographyByNumber.get(number)
          : (registryByIndex.get(number) as AnswerCitationSource | undefined);
      if (!source) return { title: "", status: "unresolved" as MemberStatus };
      return {
        url: source.url,
        title: source.title || source.url,
        status: coherence(source.url, group.mentioned, entityIndex),
      };
    });
    return {
      kind,
      members,
      score: members.filter((member) => isAcceptable(member.status)).length,
    };
  };

  // When both readings fit a marker, prefer the numbering that fits the
  // answer's unanchored markers overall; the visible list wins a tie.
  let bibliographyTotal = 0;
  let registryTotal = 0;
  for (const group of groups) {
    if (group.anchor) continue;
    if (bibliography) bibliographyTotal += interpret(group, "bibliography").score;
    if (useRegistry) registryTotal += interpret(group, "registry").score;
  }
  const preferred: Interpretation["kind"] =
    bibliography && (!useRegistry || bibliographyTotal >= registryTotal)
      ? "bibliography"
      : "registry";

  const dropped: DroppedAnswerCitation[] = [];
  const citedIndices = new Set<number>();
  const replacements = new Map<number, Array<{ start: number; end: number; value: string }>>();
  let renumberedMarkers = 0;
  for (const group of groups) {
    let kept: number[];
    if (group.anchor) {
      kept = [canonicalIndexFor(group.anchor.url, group.anchor.title)];
    } else {
      const candidates: Interpretation[] = [];
      if (bibliography) candidates.push(interpret(group, "bibliography"));
      if (useRegistry) candidates.push(interpret(group, "registry"));
      const full = candidates.filter((candidate) => candidate.score === group.numbers.length);
      const chosen =
        full.length === 1
          ? full[0]
          : (full.length > 1 ? full : candidates)
              .slice()
              .sort(
                (left, right) =>
                  right.score - left.score ||
                  Number(right.kind === preferred) - Number(left.kind === preferred),
              )[0];
      kept = [];
      for (const [memberIndex, member] of chosen.members.entries()) {
        if (member.url && isAcceptable(member.status)) {
          kept.push(canonicalIndexFor(member.url, member.title));
        } else {
          dropped.push({
            marker: group.marker,
            number: group.numbers[memberIndex],
            reason: member.status === "incoherent" ? "misattributed" : "unknown_source",
          });
        }
      }
    }
    kept = kept.filter((value, index) => kept.indexOf(value) === index);
    for (const index of kept) citedIndices.add(index);
    const sameNumbers =
      kept.length === group.numbers.length &&
      kept.every((value, index) => value === group.numbers[index]);
    if (sameNumbers) continue;
    const lineReplacements = replacements.get(group.lineIndex) || [];
    if (kept.length > 0) {
      renumberedMarkers += 1;
      lineReplacements.push({ start: group.start, end: group.end, value: `[${kept.join(", ")}]` });
    } else {
      const line = lines[group.lineIndex];
      const start = line[group.start - 1] === " " ? group.start - 1 : group.start;
      lineReplacements.push({ start, end: group.end, value: "" });
    }
    replacements.set(group.lineIndex, lineReplacements);
  }

  for (const [lineIndex, lineReplacements] of replacements) {
    let line = lines[lineIndex];
    for (const replacement of lineReplacements.sort((left, right) => right.start - left.start)) {
      line = line.slice(0, replacement.start) + replacement.value + line.slice(replacement.end);
    }
    lines[lineIndex] = line;
  }

  let bibliographyRewritten = false;
  if (bibliography) {
    const listed = new Map<number, { indent: string; content: string }>();
    let relabeled = false;
    for (const entry of bibliography.entries) {
      const index = entryCanonical.get(entry) ?? entry.number;
      if (index !== entry.number || listed.has(index)) relabeled = true;
      if (!listed.has(index)) listed.set(index, { indent: entry.indent, content: entry.content });
    }
    const missing = [...citedIndices].filter((index) => !listed.has(index));
    if (relabeled || missing.length > 0) {
      const indent = bibliography.entries[0]?.indent || "";
      for (const index of missing) {
        const source = sourceFor(index);
        if (!source) continue;
        listed.set(index, {
          indent,
          content: `[${flattenTitle(source.title) || source.url}](${source.url})`,
        });
      }
      // Ordered-list markup would be renumbered from its first item when
      // rendered, so labels are written as [N] to keep each number visible.
      const entryLines = [...listed.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, entry]) => `${entry.indent}- [${index}] ${entry.content}`);
      lines.splice(
        bibliography.firstEntryLineIndex,
        bibliography.lastEntryLineIndex - bibliography.firstEntryLineIndex + 1,
        ...entryLines,
      );
      bibliographyRewritten = true;
    }
  }

  const output = lines.join("\n");
  return {
    text: output,
    changed: output !== text,
    renumberedMarkers,
    dropped,
    bibliographyRewritten,
  };
}
