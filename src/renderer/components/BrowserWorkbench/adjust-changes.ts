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
