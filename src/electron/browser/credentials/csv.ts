/**
 * A strict CSV reader for password exports (RFC 4180). It rejects anything that is not text
 * and bounds size, rows and field length, so a hostile or corrupt file cannot exhaust memory
 * or smuggle odd data into the vault.
 */

export const MAX_CSV_BYTES = 20 * 1024 * 1024;
export const MAX_CSV_ROWS = 50_000;
export const MAX_FIELD_CHARS = 4096;

export class CsvError extends Error {
  constructor(
    readonly code: "too_large" | "not_text" | "malformed" | "too_many_rows" | "field_too_long",
    message: string,
  ) {
    super(message);
    this.name = "CsvError";
  }
}

/** Parse CSV text into rows of fields. The first row is returned like any other. */
export function parseCsv(text: string): string[][] {
  if (text.length > MAX_CSV_BYTES) throw new CsvError("too_large", "The file is too large.");
  // A byte-order mark is not part of the first field.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;

  const pushField = () => {
    if (field.length > MAX_FIELD_CHARS) {
      throw new CsvError("field_too_long", "A field in the file is too long.");
    }
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const pushRow = () => {
    pushField();
    // A blank line is not a row.
    if (row.length === 1 && row[0] === "") {
      row = [];
      return;
    }
    rows.push(row);
    if (rows.length > MAX_CSV_ROWS + 1) {
      throw new CsvError("too_many_rows", "The file has too many rows.");
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
        if (field.length > MAX_FIELD_CHARS) {
          throw new CsvError("field_too_long", "A field in the file is too long.");
        }
      }
      continue;
    }
    if (char === '"') {
      // A quote opens a quoted field only at the start of a field.
      if (fieldStarted) throw new CsvError("malformed", "A quote appears inside a field.");
      quoted = true;
      fieldStarted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\0") {
      throw new CsvError("not_text", "The file is not a text file.");
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) throw new CsvError("malformed", "The file ends inside a quoted field.");
  if (fieldStarted || field !== "" || row.length > 0) pushRow();
  return rows;
}

/** Decode file bytes as UTF-8, refusing binary data. */
export function decodeCsvBytes(bytes: Buffer): string {
  if (bytes.length > MAX_CSV_BYTES) throw new CsvError("too_large", "The file is too large.");
  if (bytes.includes(0)) throw new CsvError("not_text", "The file is not a text file.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return decoder.decode(bytes);
  } catch {
    throw new CsvError("not_text", "The file is not valid UTF-8 text.");
  }
}
