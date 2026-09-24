import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

type MarkdownRendererProps = {
  children: string;
  components?: unknown;
  withBreaks?: boolean;
};

const gfmPlugins = [remarkGfm];
const gfmBreaksPlugins = [remarkGfm, remarkBreaks];

function transformMarkdownUrl(url: string, key: string): string {
  // Models sometimes prefix workspace downloads with sandbox:. Convert only
  // absolute local anchor paths so the existing file preview handler sees them.
  // Keep the default protocol filter for images and all other URLs.
  const localUrl = key === "href" && /^sandbox:\/(?![/\\]|%2f|%5c)/i.test(url) ? url.slice(8) : url;
  return defaultUrlTransform(localUrl);
}

export function MarkdownRenderer({
  children,
  components,
  withBreaks = false,
}: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={withBreaks ? gfmBreaksPlugins : gfmPlugins}
      components={components as any}
      urlTransform={transformMarkdownUrl}
    >
      {children}
    </ReactMarkdown>
  );
}
