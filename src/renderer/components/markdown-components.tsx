import {
  Children,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type LiHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TableHTMLAttributes,
} from "react";
import {
  File as FileIcon,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
} from "lucide-react";

import { getEmojiIcon } from "../utils/emoji-icon-map";
import { replaceEmojisInChildren } from "../utils/emoji-replacer";
import { CitationBadge } from "./CitationPanel";
import { MarkdownImagePreview } from "./MarkdownImagePreview";
import { useFileActionMenu } from "./FileActionMenu";
import { LazyHighlightedCodeBlock } from "./lazy-renderers";
import { RunnableCodeBlock } from "./RunnableCodeBlock";
import {
  canRunCodeBlocks,
  isRunnableShellLanguage,
  useCodeBlockRunScope,
} from "../utils/code-block-runs";

type CodeBlockProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode;
  className?: string;
  node?: unknown;
};

type MarkdownComponentsOptions = {
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
  onOpenWebLinkInSidebar?: (url: string) => void;
  /** Show an inline thumbnail after links to local image files (default true). */
  inlineImageLinks?: boolean;
  /**
   * Maps inline `code` text to a file this task wrote, so a final answer that names an output
   * as `report.docx` gets the same openable chip as a markdown link.
   */
  resolveInlineCodeFilePath?: (text: string) => string | null;
  citations?: Array<{
    index: number;
    url: string;
    title: string;
    snippet: string;
    domain: string;
    accessedAt: number;
    sourceTool: string;
  }>;
};

type MarkdownAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href?: string;
  children?: ReactNode;
  node?: unknown;
};

type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  src?: string;
  alt?: string;
  title?: string;
  node?: unknown;
};

let mermaidLastTheme: boolean | null = null;
let mermaidApiPromise: Promise<typeof import("mermaid").default> | null = null;
type MermaidRenderingApi = Pick<typeof import("mermaid").default, "initialize" | "render">;

function loadMermaid() {
  mermaidApiPromise ??= import("mermaid").then((module) => module.default);
  return mermaidApiPromise;
}

if (typeof document !== "undefined") {
  const observer = new MutationObserver(() => {
    const isDark = !document.documentElement.classList.contains("theme-light");
    if (mermaidLastTheme !== null && mermaidLastTheme !== isDark) {
      mermaidLastTheme = null;
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

function initMermaid(mermaid: MermaidRenderingApi) {
  const isDark = !document.documentElement.classList.contains("theme-light");
  if (mermaidLastTheme === isDark) return;
  mermaidLastTheme = isDark;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    theme: "base",
    themeVariables: {
      darkMode: isDark,
      fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
      primaryTextColor: isDark ? "#e8e8e8" : "#333333",
      primaryColor: isDark ? "#363754" : "#fff4dd",
      primaryBorderColor: isDark ? "#4a4a6a" : "#e8dcc4",
      lineColor: isDark ? "#6b6b8a" : "#333333",
      secondaryColor: isDark ? "#454563" : "#f0e6d4",
      tertiaryColor: isDark ? "#2d2d3a" : "#f5f5f5",
      nodeTextColor: isDark ? "#e8e8e8" : "#333333",
      textColor: isDark ? "#e8e8e8" : "#333333",
      mainBkg: isDark ? "#363754" : "#fff4dd",
      nodeBorder: isDark ? "#4a4a6a" : "#e8dcc4",
      clusterBkg: isDark ? "#2d2d3a" : "#f5f5f5",
      clusterBorder: isDark ? "#4a4a6a" : "#e0e0e0",
      titleColor: isDark ? "#e8e8e8" : "#333333",
      edgeLabelBackground: isDark ? "#363754" : "#fff4dd",
    },
  });
}

/** Give Mermaid a measurement container we own, including on rejected renders. */
export async function renderMermaidChart(mermaid: MermaidRenderingApi, id: string, chart: string) {
  initMermaid(mermaid);
  const target = document.createElement("div");
  target.setAttribute("aria-hidden", "true");
  target.style.cssText =
    "position:absolute;top:0;left:0;width:100%;visibility:hidden;pointer-events:none";
  document.body.appendChild(target);
  try {
    return await mermaid.render(id, chart, target);
  } finally {
    target.remove();
  }
}

function sanitizeMermaidSvg(svgMarkup: string): SVGSVGElement | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") {
    return null;
  }

  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "script" || tagName === "foreignobject") {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "xlink:href") && /^javascript:/i.test(value)) {
        element.removeAttribute(attr.name);
      }
    }
  }

  return root as unknown as SVGSVGElement;
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);
  const [themeKey, setThemeKey] = useState(() =>
    document.documentElement.classList.contains("theme-light") ? "light" : "dark",
  );

  useLayoutEffect(() => {
    const observer = new MutationObserver(() => {
      const next = document.documentElement.classList.contains("theme-light") ? "light" : "dark";
      setThemeKey((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    let cancelled = false;
    setError(null);
    setSvg(null);

    loadMermaid()
      .then((mermaid) => {
        if (cancelled) return null;
        return renderMermaidChart(mermaid, idRef.current, chart);
      })
      .then((result) => {
        if (!cancelled && result?.svg) setSvg(result.svg);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render diagram");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, themeKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    if (!svg) return;
    const sanitizedSvg = sanitizeMermaidSvg(svg);
    if (!sanitizedSvg) {
      setError("Failed to render diagram");
      return;
    }
    container.appendChild(document.importNode(sanitizedSvg, true));
  }, [svg]);

  if (error) {
    return (
      <div className="mermaid-error">
        <span>Diagram error: {error}</span>
      </div>
    );
  }

  return svg ? (
    <div className="mermaid-diagram" ref={containerRef} />
  ) : (
    <div className="mermaid-diagram">
      <span className="mermaid-loading">Rendering diagram...</span>
    </div>
  );
}

function getTextContent(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(getTextContent).join("");
  if (node && typeof node === "object" && "props" in node) {
    return getTextContent((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

export function normalizeCodeBlockTextForDisplay(codeText: string, language?: string): string {
  const normalizedLanguage = (language || "").toLowerCase();
  if (normalizedLanguage !== "diff" && normalizedLanguage !== "patch") {
    return codeText;
  }
  return codeText.replace(/(?:\r?\n[ \t]*)+$/g, "");
}

/** Where a fenced block starts in its markdown source, which keys its run state. */
function getNodeStartOffset(node: unknown): number | null {
  const offset = (node as { position?: { start?: { offset?: unknown } } } | undefined)?.position
    ?.start?.offset;
  return typeof offset === "number" ? offset : null;
}

function CodeBlock({ children, className, node, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const runScope = useCodeBlockRunScope();
  const languageMatch = /(?:^|\s)language-([^\s]+)/.exec(className || "");
  const isCodeBlock = Boolean(languageMatch);
  const language = languageMatch?.[1] || "";
  const rawCodeText = isCodeBlock ? getTextContent(children) : "";
  const displayCodeText = normalizeCodeBlockTextForDisplay(rawCodeText, language);
  const nodeOffset = getNodeStartOffset(node);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayCodeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  if (!isCodeBlock) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  if (language === "mermaid") {
    return <MermaidDiagram chart={rawCodeText} />;
  }

  if (
    runScope &&
    nodeOffset !== null &&
    isRunnableShellLanguage(language) &&
    displayCodeText.trim() &&
    canRunCodeBlocks()
  ) {
    return (
      <RunnableCodeBlock
        scope={runScope}
        blockKey={`${runScope.keyPrefix}@${nodeOffset}`}
        code={displayCodeText.replace(/\n+$/, "")}
        language={language}
        className={className}
        codeProps={props}
      />
    );
  }

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        {language && <span className="code-block-language">{language}</span>}
        <button
          className={`code-block-copy ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy code"}
        >
          {copied ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      </div>
      <Suspense
        fallback={
          <code className={className} {...props}>
            {displayCodeText}
          </code>
        }
      >
        <LazyHighlightedCodeBlock
          code={displayCodeText}
          language={language}
          className={className}
          codeProps={props}
        />
      </Suspense>
    </div>
  );
}

const HEADING_EMOJI_REGEX = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0F\uFE0E]?)(\s+)?/u;

function getHeadingIcon(emoji: string): ReactNode {
  const Icon = getEmojiIcon(emoji);
  return <Icon size={16} strokeWidth={1.8} />;
}

function renderHeading(Tag: "h1" | "h2" | "h3") {
  return ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => {
    const nodes = Children.toArray(children);
    if (typeof nodes[0] === "string") {
      const match = nodes[0].match(HEADING_EMOJI_REGEX);
      if (match) {
        const emoji = match[1];
        const icon = getHeadingIcon(emoji);
        nodes[0] = nodes[0].slice(match[0].length);
        return (
          <Tag {...props}>
            <span className="markdown-heading-icon">{icon}</span>
            {nodes}
          </Tag>
        );
      }
    }
    return <Tag {...props}>{nodes}</Tag>;
  };
}

const isExternalHttpLink = (href: string): boolean =>
  href.startsWith("http://") || href.startsWith("https://");

const FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "tsv",
  "ppt",
  "pptx",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "js",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "less",
  "sass",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "cpp",
  "c",
  "h",
  "hpp",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "toml",
  "ini",
  "env",
  "lock",
  "log",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tiff",
  "mp3",
  "wav",
  "m4a",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "zip",
  "tar",
  "gz",
  "tgz",
  "rar",
  "7z",
]);

const stripHttpScheme = (value: string): string => value.replace(/^https?:\/\//, "");
const HTML_TAG_REGEX = /<[^>]*>/g;
const URLISH_TEXT_REGEX = /^(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)/i;
const X_LINK_HOSTS = new Set(["x.com", "twitter.com"]);

function stripHtmlTags(value: string): string {
  return String(value || "")
    .replace(HTML_TAG_REGEX, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDomainFromUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`,
    );
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return stripHttpScheme(trimmed)
      .split("/")[0]
      .replace(/^www\./i, "");
  }
}

function isXComLink(raw: string): boolean {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return false;

  try {
    const parsed = new URL(
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`,
    );
    const hostname = parsed.hostname.replace(/^(?:www\.|mobile\.)/i, "").toLowerCase();
    return X_LINK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

const isUrlLikeLabel = (value: string): boolean =>
  URLISH_TEXT_REGEX.test(String(value || "").trim());

function looksLikeLocalFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("file://")) return true;
  if (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:")) return false;
  if (trimmed.includes("://") || trimmed.startsWith("www.")) return false;
  if (trimmed.includes("@")) return false;
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("/")
  ) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.includes("/") || trimmed.includes("\\")) return true;
  const extMatch = trimmed.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (!extMatch) return false;
  return FILE_EXTENSIONS.has(extMatch[1].toLowerCase());
}

function isFileLink(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("#")) return false;
  if (isExternalHttpLink(href)) return false;
  if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;
  if (href.startsWith("file://")) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
  return true;
}

function normalizeFileHref(href: string): string {
  if (!href) return href;
  if (href.startsWith("file://")) {
    const rawPath = href.replace(/^file:\/\//, "");
    const decoded = (() => {
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    })();
    return decoded.replace(/^\/([a-zA-Z]:\/)/, "$1").split(/[?#]/)[0];
  }
  // Markdown renderers percent-encode destinations (e.g. spaces -> %20); decode relative paths.
  const withoutQuery = href.split(/[?#]/)[0];
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return withoutQuery;
  }
}

const INLINE_IMAGE_LINK_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

const FILE_CHIP_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|heic)$/i;
const FILE_CHIP_DATA_EXT_RE = /\.(csv|tsv|xlsx?|numbers|parquet|sqlite|db)$/i;
const FILE_CHIP_DOC_EXT_RE = /\.(md|mdx|txt|rtf|pdf|docx?|pages|pptx?|key)$/i;
const FILE_CHIP_CODE_EXT_RE =
  /\.([cm]?[jt]sx?|json|ya?ml|toml|css|scss|html?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|sql|vue|svelte)$/i;

/** Leading glyph for a file link chip; a `:line` suffix does not change the file type. */
export function FileChipIcon({ filePath }: { filePath: string }) {
  const path = filePath.replace(/[?#].*$/, "").replace(/(:\d+){1,2}$/, "");
  const Icon = /[\\/]$/.test(path)
    ? Folder
    : FILE_CHIP_IMAGE_EXT_RE.test(path)
      ? FileImage
      : FILE_CHIP_DATA_EXT_RE.test(path)
        ? FileSpreadsheet
        : FILE_CHIP_DOC_EXT_RE.test(path)
          ? FileText
          : FILE_CHIP_CODE_EXT_RE.test(path)
            ? FileCode2
            : FileIcon;
  return (
    <span className="clickable-file-path-icon" aria-hidden="true">
      <Icon size={13} strokeWidth={1.9} />
    </span>
  );
}

function hastNodeContainsImage(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const record = node as { tagName?: unknown; children?: unknown };
  if (record.tagName === "img") return true;
  return Array.isArray(record.children) && record.children.some(hastNodeContainsImage);
}

function resolveFileLinkTarget(href: string, linkText: string): string | null {
  const trimmedText = linkText.trim();
  const trimmedHref = href.trim();

  if (looksLikeLocalFilePath(trimmedText)) {
    const strippedHref = stripHttpScheme(trimmedHref).replace(/\/$/, "");
    if (trimmedHref === trimmedText || strippedHref === trimmedText) {
      return normalizeFileHref(trimmedText);
    }
  }

  if (looksLikeLocalFilePath(trimmedHref)) {
    return normalizeFileHref(trimmedHref);
  }

  return null;
}

const CITATION_REF_REGEX = /\[(\d+)\]/g;

/** Set inside a rendered link so inline `code` in its label is not turned into a second chip. */
const InsideMarkdownLinkContext = createContext(false);

function MarkdownFileLink({
  href,
  filePath,
  linkText,
  node,
  workspacePath,
  onOpenViewer,
  inlineImageLinks,
  children,
  ...props
}: MarkdownAnchorProps & {
  href: string;
  filePath: string;
  linkText: string;
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
  inlineImageLinks: boolean;
}) {
  const { openFileActionMenu, menu: fileActionMenu } = useFileActionMenu({
    workspacePath,
    onOpenInPanel: onOpenViewer,
  });

  const handleClick = async (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (onOpenViewer && workspacePath) {
      onOpenViewer(filePath);
      return;
    }

    if (!workspacePath) return;

    try {
      const error = await window.electronAPI.openFile(filePath, workspacePath);
      if (error) {
        console.error("Failed to open file:", error);
      }
    } catch (err) {
      console.error("Error opening file:", err);
    }
  };

  const handleContextMenu = (event: ReactMouseEvent) => {
    if (!workspacePath) return;
    openFileActionMenu(event, filePath);
  };

  const fileLink = (
    <>
      <a
        {...props}
        href={href}
        className={`clickable-file-path ${props.className || ""}`.trim()}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`${filePath}\n\nClick to open - Right-click for more options`}
      >
        <FileChipIcon filePath={filePath} />
        <InsideMarkdownLinkContext.Provider value>
          <span className="clickable-file-path-label">{children}</span>
        </InsideMarkdownLinkContext.Provider>
      </a>
      {fileActionMenu}
    </>
  );

  // Links to workspace images also show the image inline (unless the link already wraps one).
  if (
    inlineImageLinks &&
    workspacePath &&
    INLINE_IMAGE_LINK_EXT_RE.test(filePath) &&
    !hastNodeContainsImage(node)
  ) {
    return (
      <>
        {fileLink}
        <span className="markdown-image-link-preview">
          <MarkdownImagePreview src={filePath} alt={linkText} workspacePath={workspacePath} quiet />
        </span>
      </>
    );
  }

  return fileLink;
}

export function buildMarkdownComponents(options: MarkdownComponentsOptions) {
  const {
    workspacePath,
    onOpenViewer,
    onOpenWebLinkInSidebar,
    citations,
    inlineImageLinks = true,
    resolveInlineCodeFilePath,
  } = options;
  const citationMap = new Map((citations || []).map((citation) => [citation.index, citation]));
  const citationUrlMap = new Map(
    (citations || []).map((citation) => [citation.url.replace(/\/+$/, "").toLowerCase(), citation]),
  );

  const MarkdownLink = ({ href, children, node, ...props }: MarkdownAnchorProps) => {
    if (!href) {
      return <a {...props}>{children}</a>;
    }

    const linkText = getTextContent(children);
    const xComLink = isXComLink(href);
    const externalHref = isExternalHttpLink(href)
      ? href
      : xComLink
        ? `https://${href.replace(/^\/+/, "")}`
        : null;
    const fileTarget = externalHref ? null : resolveFileLinkTarget(href, linkText);

    if (!externalHref && (fileTarget || isFileLink(href))) {
      return (
        <MarkdownFileLink
          {...props}
          href={href}
          filePath={fileTarget ?? normalizeFileHref(href)}
          linkText={linkText}
          node={node}
          workspacePath={workspacePath}
          onOpenViewer={onOpenViewer}
          inlineImageLinks={inlineImageLinks}
        >
          {children}
        </MarkdownFileLink>
      );
    }

    if (externalHref) {
      const handleClick = async (event: ReactMouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (onOpenWebLinkInSidebar) {
          onOpenWebLinkInSidebar(externalHref);
          return;
        }
        try {
          await window.electronAPI.openExternal(externalHref);
        } catch (err) {
          console.error("Error opening link:", err);
        }
      };

      if (xComLink) {
        return (
          <a
            {...props}
            href={externalHref}
            onClick={handleClick}
            className={`x-social-link ${props.className || ""}`.trim()}
            title={externalHref}
          >
            <span className="x-social-link-icon" aria-hidden="true">
              X
            </span>
            <span className="x-social-link-label">{children}</span>
          </a>
        );
      }

      const normHref = externalHref.replace(/\/+$/, "").toLowerCase();
      const matchedCitation = citationUrlMap.get(normHref);
      const matchedCitationUrl =
        matchedCitation && typeof matchedCitation.url === "string"
          ? matchedCitation.url
          : externalHref;
      const matchedCitationTitle =
        matchedCitation && typeof matchedCitation.title === "string"
          ? stripHtmlTags(matchedCitation.title)
          : "";
      const matchedCitationDomain =
        matchedCitation && typeof matchedCitation.domain === "string"
          ? stripHtmlTags(matchedCitation.domain)
          : "";
      const shouldRenderCitationCard =
        Boolean(matchedCitation) &&
        matchedCitationTitle.length > 0 &&
        matchedCitationTitle !== matchedCitationUrl &&
        !isUrlLikeLabel(linkText);

      if (shouldRenderCitationCard) {
        const citationDomain = matchedCitationDomain || extractDomainFromUrl(matchedCitationUrl);
        return (
          <a
            {...props}
            href={externalHref}
            onClick={handleClick}
            className="citation-source-link"
            title={matchedCitationUrl}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              borderRadius: 6,
              background: "var(--surface-secondary, #1a1a1a)",
              border: "1px solid var(--border-color, #333)",
              textDecoration: "none",
              color: "inherit",
              transition: "background 0.15s, border-color 0.15s",
              maxWidth: "100%",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "var(--surface-hover, rgba(255,255,255,0.08))";
              event.currentTarget.style.borderColor = "var(--accent-color, #60a5fa)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "var(--surface-secondary, #1a1a1a)";
              event.currentTarget.style.borderColor = "var(--border-color, #333)";
            }}
          >
            <img
              src={`https://www.google.com/s2/favicons?domain=${citationDomain}&sz=16`}
              alt=""
              width={14}
              height={14}
              style={{ borderRadius: 2, flexShrink: 0 }}
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--text-primary, #e5e5e5)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {matchedCitationTitle}
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 10,
                  color: "var(--text-tertiary, #666)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {citationDomain}
              </span>
            </span>
          </a>
        );
      }

      return (
        <a {...props} href={externalHref} onClick={handleClick}>
          {children}
        </a>
      );
    }

    return (
      <a {...props} href={href}>
        {children}
      </a>
    );
  };

  const replaceCitationsInChildren = (children: ReactNode): ReactNode => {
    if (citationMap.size === 0) return replaceEmojisInChildren(children);

    return Children.map(children, (child) => {
      if (typeof child === "string") {
        const parts: ReactNode[] = [];
        let lastIndex = 0;

        CITATION_REF_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CITATION_REF_REGEX.exec(child)) !== null) {
          const idx = parseInt(match[1], 10);
          const citation = citationMap.get(idx);
          if (!citation) continue;

          if (match.index > lastIndex) {
            parts.push(child.slice(lastIndex, match.index));
          }
          parts.push(
            <CitationBadge key={`cite-${idx}-${match.index}`} index={idx} citation={citation} />,
          );
          lastIndex = match.index + match[0].length;
        }

        if (parts.length === 0) return replaceEmojisInChildren(child);

        if (lastIndex < child.length) {
          parts.push(child.slice(lastIndex));
        }
        return (
          <>
            {parts.map((part) => (typeof part === "string" ? replaceEmojisInChildren(part) : part))}
          </>
        );
      }
      return child;
    });
  };

  const MarkdownCode = (props: CodeBlockProps) => {
    const insideLink = useContext(InsideMarkdownLinkContext);
    const isBlock = /(?:^|\s)language-/.test(props.className || "");
    const filePath =
      !insideLink && !isBlock && resolveInlineCodeFilePath
        ? resolveInlineCodeFilePath(getTextContent(props.children))
        : null;
    if (!filePath) return <CodeBlock {...props} />;
    return (
      <MarkdownLink href={filePath}>
        <code>{props.children}</code>
      </MarkdownLink>
    );
  };

  return {
    code: resolveInlineCodeFilePath ? MarkdownCode : CodeBlock,
    h1: renderHeading("h1"),
    h2: renderHeading("h2"),
    h3: renderHeading("h3"),
    table: ({ children, ...props }: TableHTMLAttributes<HTMLTableElement>) => (
      <div className="markdown-table-wrapper">
        <table {...props}>{children}</table>
      </div>
    ),
    a: MarkdownLink,
    img: ({ src, alt, title }: MarkdownImageProps) => (
      <MarkdownImagePreview
        src={typeof src === "string" ? src : ""}
        alt={typeof alt === "string" ? alt : ""}
        title={typeof title === "string" ? title : undefined}
        workspacePath={workspacePath}
      />
    ),
    p: ({ children, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
      <p {...props}>{replaceCitationsInChildren(children)}</p>
    ),
    li: ({ children, ...props }: LiHTMLAttributes<HTMLLIElement>) => (
      <li {...props}>{replaceCitationsInChildren(children)}</li>
    ),
  };
}
