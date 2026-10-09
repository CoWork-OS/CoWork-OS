/**
 * Linear-time tag lookups for model-written HTML of up to a megabyte. Regexes such as
 * `<head\b[^>]*>` rescan from every `<head` opening, so a document of many unclosed
 * openings costs quadratic time (seconds on a slow machine, even with a bounded
 * quantifier). These helpers move forward only: after a candidate tag they continue past
 * its closing `>`, which is also where a browser would end the tag.
 */

export type HtmlTagMatch = { start: number; end: number; text: string };

/** Lower-cases ASCII letters only, so indexes stay aligned with the original string. */
export function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

const NAME_CHAR = /[a-z0-9-]/;

/** Every opening tag `<name …>` in order, case-insensitively. */
export function findOpeningTags(
  html: string,
  name: string,
  lower: string = asciiLowerCase(html),
): HtmlTagMatch[] {
  const needle = `<${name.toLowerCase()}`;
  const matches: HtmlTagMatch[] = [];
  let from = 0;
  while (from < lower.length) {
    const start = lower.indexOf(needle, from);
    if (start === -1) break;
    const after = lower.charAt(start + needle.length);
    if (after && NAME_CHAR.test(after)) {
      // `<header` is not `<head`.
      from = start + needle.length;
      continue;
    }
    const close = lower.indexOf(">", start + needle.length);
    if (close === -1) break;
    matches.push({ start, end: close + 1, text: html.slice(start, close + 1) });
    from = close + 1;
  }
  return matches;
}

/** The first opening tag `<name …>`, or null. */
export function findOpeningTag(
  html: string,
  name: string,
  lower: string = asciiLowerCase(html),
): HtmlTagMatch | null {
  const needle = `<${name.toLowerCase()}`;
  let from = 0;
  while (from < lower.length) {
    const start = lower.indexOf(needle, from);
    if (start === -1) return null;
    const after = lower.charAt(start + needle.length);
    if (after && NAME_CHAR.test(after)) {
      from = start + needle.length;
      continue;
    }
    const close = lower.indexOf(">", start + needle.length);
    if (close === -1) return null;
    return { start, end: close + 1, text: html.slice(start, close + 1) };
  }
  return null;
}

/** Inserts text right after a tag, or returns null when the tag is absent. */
export function insertAfterTag(html: string, name: string, insertion: string): string | null {
  const tag = findOpeningTag(html, name);
  if (!tag) return null;
  return `${html.slice(0, tag.end)}${insertion}${html.slice(tag.end)}`;
}
