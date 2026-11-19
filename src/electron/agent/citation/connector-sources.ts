/**
 * Sources from connector reads: the calendar events, Drive files and Notion pages a tool call
 * returned, so an answer can credit "Google Calendar" the way it credits a web page. Only
 * records with their own https link become sources; the link is the provider's page for that
 * record, which the person can open to check the claim.
 */

export type ConnectorSource = {
  url: string;
  title: string;
  snippet: string;
  /** The connector as the person knows it ("Google Calendar"). */
  sourceLabel: string;
};

/** Enough to back the answer's claims without flooding the source list from one listing. */
export const MAX_SOURCES_PER_CALL = 10;

const READ_ACTIONS: Record<string, { label: string; actions: Set<string> }> = {
  calendar_action: { label: "Google Calendar", actions: new Set(["list_events", "get_event"]) },
  google_drive_action: { label: "Google Drive", actions: new Set(["list_files", "get_file"]) },
  notion_action: {
    label: "Notion",
    actions: new Set(["search", "get_page", "get_database", "query_data_source"]),
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The provider's https page for a record, or "" for anything else (no file:, no http:). */
function httpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

/** Notion keeps a page title in its one "title" property, and a database title at the top. */
function notionTitle(item: Record<string, unknown>): string {
  // Runs are joined as written ("Board " + "prep"), then flattened once.
  const plain = (parts: unknown) =>
    Array.isArray(parts)
      ? text(
          parts
            .map((part) => {
              const value = record(part)?.plain_text;
              return typeof value === "string" ? value : "";
            })
            .join(""),
        )
      : "";
  const direct = plain(item.title);
  if (direct) return direct;
  const properties = record(item.properties);
  for (const property of Object.values(properties ?? {})) {
    const value = record(property);
    if (value?.type === "title") return plain(value.title);
  }
  return "";
}

function calendarWhen(item: Record<string, unknown>): string {
  const start = record(item.start);
  return text(start?.dateTime ?? start?.date, 40);
}

function toSource(
  tool: string,
  item: Record<string, unknown>,
  label: string,
): ConnectorSource | null {
  if (tool === "calendar_action") {
    const url = httpsUrl(item.htmlLink);
    if (!url) return null;
    return {
      url,
      title: text(item.summary) || "Calendar event",
      snippet: calendarWhen(item),
      sourceLabel: label,
    };
  }
  if (tool === "google_drive_action") {
    const url = httpsUrl(item.webViewLink);
    if (!url) return null;
    return { url, title: text(item.name) || "Drive file", snippet: "", sourceLabel: label };
  }
  if (tool === "notion_action") {
    const url = httpsUrl(item.url);
    if (!url) return null;
    return {
      url,
      title: notionTitle(item) || "Notion page",
      snippet: "",
      sourceLabel: label,
    };
  }
  return null;
}

/** The sources a connector read returned, or none for writes, failures and other tools. */
export function extractConnectorSources(
  toolName: string,
  input: unknown,
  result: unknown,
): ConnectorSource[] {
  const spec = READ_ACTIONS[toolName];
  const action = String(record(input)?.action ?? "");
  if (!spec || !spec.actions.has(action)) return [];
  const outcome = record(result);
  if (!outcome || outcome.success === false) return [];
  const data = record(outcome.data);
  if (!data) return [];
  const list = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.files)
      ? data.files
      : Array.isArray(data.results)
        ? data.results
        : [data];
  const sources: ConnectorSource[] = [];
  for (const entry of list) {
    const item = record(entry);
    const source = item ? toSource(toolName, item, spec.label) : null;
    if (source) sources.push(source);
    if (sources.length >= MAX_SOURCES_PER_CALL) break;
  }
  return sources;
}
