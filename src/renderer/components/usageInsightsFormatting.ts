export function formatUsageCount(count: number): string {
  return `${count}×`;
}

// Roughly the word count of Moby-Dick (~210k words ≈ ~270k tokens).
const MOBY_DICK_TOKENS = 270_000;

// A few well-known works to cycle through for a fun comparison.
const BOOK_COMPARISONS: Array<{ name: string; tokens: number }> = [
  { name: "Moby-Dick", tokens: MOBY_DICK_TOKENS },
  { name: "the Harry Potter series", tokens: 1_400_000 },
  { name: "the Lord of the Rings trilogy", tokens: 620_000 },
  { name: "War and Peace", tokens: 780_000 },
  { name: "the complete works of Shakespeare", tokens: 1_100_000 },
];

function describeBookMultiple(multiple: number, bookName: string): string {
  const rounded = multiple >= 10 ? Math.round(multiple) : Math.round(multiple * 10) / 10;
  if (rounded === 1) return `You've used about as many tokens as ${bookName}.`;
  if (multiple > 1) {
    const rendered = rounded >= 10 ? String(Math.round(rounded)) : rounded.toFixed(1);
    return `You've used ~${rendered}× as many tokens as ${bookName}.`;
  }
  const percent = Math.round(multiple * 100);
  if (percent < 1) return `You've used under 1% as many tokens as ${bookName}.`;
  return `You've used about ${percent}% as many tokens as ${bookName}.`;
}

export function pickBookComparison(totalTokens: number): string | null {
  if (totalTokens <= 0) return null;
  // Pick the book whose multiple lands closest to an impressive-but-readable number.
  let best: { name: string; multiple: number } | null = null;
  for (const book of BOOK_COMPARISONS) {
    const multiple = totalTokens / book.tokens;
    if (multiple < 0.1) continue;
    if (!best || Math.abs(Math.log10(multiple) - 0.7) < Math.abs(Math.log10(best.multiple) - 0.7)) {
      best = { name: book.name, multiple };
    }
  }
  if (!best) {
    best = { name: "Moby-Dick", multiple: totalTokens / MOBY_DICK_TOKENS };
  }
  return describeBookMultiple(best.multiple, best.name);
}
