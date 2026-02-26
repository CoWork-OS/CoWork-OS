const VECTOR_DIMS = 256;

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "by",
  "as",
  "at",
  "from",
  "that",
  "this",
  "it",
  "its",
  "into",
  "about",
  "over",
  "under",
  "we",
  "you",
  "they",
  "i",
  "he",
  "she",
  "them",
  "our",
  "your",
  "my",
  "me",
  "us",
  "do",
  "does",
  "did",
  "done",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "not",
  "no",
  "yes",
]);

export function tokenizeForLocalEmbedding(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function hashToken(token: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export function createLocalEmbedding(text: string): number[] {
  const tokens = tokenizeForLocalEmbedding(text);
  if (tokens.length === 0) return Array(VECTOR_DIMS).fill(0);

  const vec = new Float32Array(VECTOR_DIMS);
  const tokenCounts = new Map<string, number>();

  for (const token of tokens) {
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }

  for (const [token, count] of tokenCounts.entries()) {
    const weight = 1 + Math.log1p(count);
    const hashA = hashToken(token, 2166136261);
    const hashB = hashToken(token, 2654435761);
    const idxA = hashA % VECTOR_DIMS;
    const idxB = hashB % VECTOR_DIMS;
    vec[idxA] += weight;
    vec[idxB] -= weight * 0.5;
  }

  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]}_${tokens[i + 1]}`;
    const hash = hashToken(bigram, 16777619);
    const idx = hash % VECTOR_DIMS;
    vec[idx] += 0.35;
  }

  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  if (norm <= 0) return Array(VECTOR_DIMS).fill(0);

  const invNorm = 1 / Math.sqrt(norm);
  for (let i = 0; i < vec.length; i++) {
    vec[i] *= invNorm;
  }

  return Array.from(vec);
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || b.length === 0) return 0;
  const dims = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < dims; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / Math.sqrt(aNorm * bNorm);
}
