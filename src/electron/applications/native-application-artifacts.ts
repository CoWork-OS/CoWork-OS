/** Saved caches are independent of ExcelJS, which discards legitimate numeric zero. */
export function readSavedNumericFormulaCaches(xml: string): Map<string, number> {
  const caches = new Map<string, number>();
  // Match self-closing cells separately; they must not consume the following formula cell.
  for (const cell of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (!cell[2]) continue;
    const address = /\br="([A-Z]+\d+)"/.exec(cell[1])?.[1];
    const value = /<v>([^<]+)<\/v>/.exec(cell[2])?.[1];
    if (
      address &&
      value !== undefined &&
      !/\bt="[bes]"/.test(cell[1]) &&
      /<f(?:\s|>|\/)/.test(cell[2])
    )
      caches.set(address, Number(value));
  }
  return caches;
}
