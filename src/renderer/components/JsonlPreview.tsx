type JsonlRecord = {
  lineNumber: number;
  value: unknown;
};

const SUMMARY_KEYS = new Set([
  "timestamp",
  "time",
  "ts",
  "level",
  "severity",
  "message",
  "msg",
  "text",
  "event",
  "component",
  "source",
  "logger",
  "name",
]);

function toDisplayText(value: unknown, maxLength = 180): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function readStringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function getLevelTone(level: string): string {
  const normalized = level.toLowerCase();
  if (normalized === "error" || normalized === "fatal") return "error";
  if (normalized === "warn" || normalized === "warning") return "warning";
  if (normalized === "debug" || normalized === "trace") return "muted";
  if (normalized === "info" || normalized === "notice") return "info";
  return "default";
}

export function parseJsonlPreview(content: string): JsonlRecord[] | null {
  const lines = content.split(/\r?\n/);
  const records: JsonlRecord[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    try {
      records.push({
        lineNumber: index + 1,
        value: JSON.parse(line) as unknown,
      });
    } catch {
      return null;
    }
  }

  return records.length > 0 ? records : null;
}

export function JsonlPreview({ content, truncated }: { content: string; truncated?: boolean }) {
  const records = parseJsonlPreview(content);
  if (!records) return null;

  return (
    <div className="jsonl-preview" role="region" aria-label="JSONL preview">
      <div className="jsonl-preview-header">
        <div className="jsonl-preview-title">
          <span className="jsonl-preview-kicker">JSONL</span>
          <span>
            {records.length} record{records.length === 1 ? "" : "s"}
          </span>
        </div>
        {truncated ? <span className="jsonl-preview-note">Preview truncated</span> : null}
      </div>
      <div className="jsonl-preview-rows">
        {records.map((record) => {
          const objectRecord =
            record.value && typeof record.value === "object" && !Array.isArray(record.value)
              ? (record.value as Record<string, unknown>)
              : null;
          const level = objectRecord ? readStringField(objectRecord, ["level", "severity"]) : "";
          const timestamp = objectRecord
            ? readStringField(objectRecord, ["timestamp", "time", "ts"])
            : "";
          const component = objectRecord
            ? readStringField(objectRecord, ["component", "source", "logger", "name"])
            : "";
          const message = objectRecord
            ? readStringField(objectRecord, ["message", "msg", "text", "event"]) ||
              toDisplayText(record.value)
            : toDisplayText(record.value);
          const details = objectRecord
            ? Object.entries(objectRecord).filter(([key]) => !SUMMARY_KEYS.has(key.toLowerCase()))
            : [];

          return (
            <div className="jsonl-preview-row" key={record.lineNumber}>
              <div className="jsonl-preview-line">{record.lineNumber}</div>
              <div className="jsonl-preview-row-body">
                <div className="jsonl-preview-meta">
                  {level ? (
                    <span className="jsonl-preview-level" data-tone={getLevelTone(level)}>
                      {level}
                    </span>
                  ) : null}
                  {timestamp ? <span className="jsonl-preview-time">{timestamp}</span> : null}
                  {component ? <span className="jsonl-preview-component">{component}</span> : null}
                </div>
                <div className="jsonl-preview-message">{message}</div>
                {details.length > 0 ? (
                  <div className="jsonl-preview-fields">
                    {details.slice(0, 6).map(([key, value]) => (
                      <span className="jsonl-preview-field" key={key}>
                        <span>{key}</span>
                        <strong>{toDisplayText(value, 120)}</strong>
                      </span>
                    ))}
                    {details.length > 6 ? (
                      <span className="jsonl-preview-field jsonl-preview-field-more">
                        +{details.length - 6} more
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
