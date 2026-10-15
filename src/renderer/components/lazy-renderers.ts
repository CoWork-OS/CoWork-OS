import { preloadableLazy } from "../utils/preloadable-lazy";

// Shared by every feed surface. Preloaded while idle (see App), so the first task opened
// renders its messages at once instead of suspending on these chunks.
export const LazyMarkdownRenderer = preloadableLazy(() =>
  import("./MarkdownRenderer").then((module) => module.MarkdownRenderer),
);
export const LazyHighlightedCodePreview = preloadableLazy(() =>
  import("./HighlightedCode").then((module) => module.HighlightedCodePreview),
);
export const LazyHighlightedCodeBlock = preloadableLazy(() =>
  import("./HighlightedCode").then((module) => module.HighlightedCodeBlock),
);
