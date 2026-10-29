/** Picks the singular word when `count` is exactly 1, the plural otherwise. */
export function pluralize(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

/** Formats a count with its noun, e.g. "1 tool" or "3 tools". */
export function formatCount(count: number, one: string, many = `${one}s`): string {
  return `${count} ${pluralize(count, one, many)}`;
}
