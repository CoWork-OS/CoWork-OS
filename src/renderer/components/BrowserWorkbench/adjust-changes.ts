export type AdjustKey =
  | "fontFamily"
  | "fontSize"
  | "fontWeight"
  | "lineHeight"
  | "color"
  | "backgroundColor"
  | "margin"
  | "padding"
  | "borderRadius"
  | "textAlign";

export type AdjustChanges = {
  styles: Partial<Record<AdjustKey, { from: string; to: string }>>;
  text?: { from: string; to: string };
};

/** Human-readable list of Adjust changes for the annotation sent to CoWork. */
export function describeAdjustChanges(changes: AdjustChanges): string {
  const lines = Object.entries(changes.styles).map(
    ([key, change]) =>
      `- ${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${change?.from || "(unset)"} → ${change?.to}`,
  );
  if (changes.text) lines.push(`- text: "${changes.text.from}" → "${changes.text.to}"`);
  return lines.join("\n");
}

/** Adjust changes as an annotation's values: what the element had and what the user set. */
export function adjustChangesToAnnotationValues(changes: AdjustChanges): {
  before: Record<string, string>;
  after: Record<string, string>;
} {
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const [key, change] of Object.entries(changes.styles)) {
    if (!change) continue;
    before[key] = change.from;
    after[key] = change.to;
  }
  if (changes.text) {
    before.text = changes.text.from;
    after.text = changes.text.to;
  }
  return { before, after };
}
