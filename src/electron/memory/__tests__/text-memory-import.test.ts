import { describe, expect, it } from "vitest";
import {
  exportLooksIncomplete,
  parseTextMemoryImport,
  textImportEntryBody,
} from "../text-memory-import";

describe("parseTextMemoryImport", () => {
  it("reads the categorized export inside the code block", () => {
    const parsed = parseTextMemoryImport(
      [
        "Here is your export:",
        "```markdown",
        "## 1. Instructions",
        "[2024-03-01] - Always answer in British English.",
        "**Identity**",
        "- [unknown] - Name is Sam.",
        "3. **Career**:",
        "[2023-05-02] - Staff engineer at Acme,",
        "  leading the payments team.",
        "Projects:",
        "[2025-01-10] — Atlas: log search CLI.",
        "### Preferences",
        "[unknown] - Prefers short answers.",
        "```",
        "This is the complete set.",
      ].join("\n"),
    );
    expect(parsed.incomplete).toBe(false);
    expect(parsed.entries).toEqual([
      { category: "instructions", date: "2024-03-01", text: "Always answer in British English." },
      { category: "identity", text: "Name is Sam." },
      {
        category: "career",
        date: "2023-05-02",
        text: "Staff engineer at Acme, leading the payments team.",
      },
      { category: "projects", date: "2025-01-10", text: "Atlas: log search CLI." },
      { category: "preferences", text: "Prefers short answers." },
    ]);
    expect(parsed.entries.map(textImportEntryBody)).toEqual([
      "[2024-03-01] - Always answer in British English.",
      "Name is Sam.",
      "[2023-05-02] - Staff engineer at Acme, leading the payments team.",
      "[2025-01-10] - Atlas: log search CLI.",
      "Prefers short answers.",
    ]);
  });

  it("keeps plain lists uncategorized and skips unknown headings", () => {
    const parsed = parseTextMemoryImport("# My memories\n- Likes tea\n* Uses vim\n1. Has a cat");
    expect(parsed.entries).toEqual([
      { category: null, text: "Likes tea" },
      { category: null, text: "Uses vim" },
      { category: null, text: "Has a cat" },
    ]);
  });

  it("keeps the closing note out of the entries without a code block", () => {
    const parsed = parseTextMemoryImport(
      "## Preferences\n[unknown] - Dark mode\nThis is not the complete set — more remain.",
    );
    expect(parsed.entries).toEqual([{ category: "preferences", text: "Dark mode" }]);
    expect(parsed.incomplete).toBe(true);
  });
});

describe("exportLooksIncomplete", () => {
  it.each([
    ["This is the complete set.", false],
    ["That's everything; no more entries remain.", false],
    ["", false],
    ["This is not the complete set. More remain.", true],
    ["More memories remain — reply 'continue' for the rest.", true],
    ["This is a partial export.", true],
  ])("%s → %s", (note, expected) => {
    expect(exportLooksIncomplete(note)).toBe(expected);
  });
});
