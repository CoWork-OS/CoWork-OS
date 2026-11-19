import type { Element, Root, RootContent } from "hast";
import type { Components } from "react-markdown";

interface FileViewerMarkdownOptions {
  filePath: string;
  onOpenFile: (filePath: string, fragment?: string) => void;
  onOpenFragment: (fragment: string) => void;
  onOpenExternal: (url: string) => Promise<unknown>;
  onError: (error: unknown) => void;
}

/** Resolve document links against the file, never against the renderer's app URL. */
export function buildFileViewerMarkdownComponents({
  filePath,
  onOpenFile,
  onOpenFragment,
  onOpenExternal,
  onError,
}: FileViewerMarkdownOptions): Components {
  return {
    a: ({ href, children, node: _node, ...props }) => (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!href) return;
          if (href.startsWith("#")) {
            onOpenFragment(href.slice(1));
            return;
          }

          if (/^(?:https?:|mailto:)/i.test(href) || href.startsWith("//")) {
            const externalUrl = href.startsWith("//") ? `https:${href}` : href;
            void onOpenExternal(externalUrl).catch(onError);
            return;
          }

          // Unknown schemes and network paths must not become local file reads.
          const normalizedHref = href.replace(/\\/g, "/");
          if (
            normalizedHref.startsWith("//") ||
            (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[/\\]/i.test(href))
          ) {
            return;
          }

          try {
            const normalizedPath = filePath.replace(/\\/g, "/");
            const base = new URL("file:///");
            // Assign pathname so a # or ? in the file name stays part of the path.
            base.pathname = (normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`)
              .split("/")
              .map(encodeURIComponent)
              .join("/");
            const target = new URL(
              /^[a-z]:\//i.test(normalizedHref) ? `/${normalizedHref}` : normalizedHref,
              base,
            );
            const decodedPath = decodeURIComponent(target.pathname);
            const localPath = /^[a-z]:\//i.test(normalizedPath)
              ? decodedPath.replace(/^\/(?=[a-z]:\/)/i, "")
              : decodedPath;
            // The viewer's existing IPC handler enforces workspace containment.
            if (target.hash) onOpenFile(localPath, target.hash.slice(1));
            else onOpenFile(localPath);
          } catch (error) {
            onError(error);
          }
        }}
      >
        {children}
      </a>
    ),
  };
}

function headingText(node: RootContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  if (node.tagName === "img") return String(node.properties.alt ?? "");
  return node.children.map(headingText).join("");
}

/** Generate heading targets local to a preview, without adding IDs to the app document. */
export function addFilePreviewHeadingFragments() {
  return (tree: Root) => {
    const used = new Set<string>();
    const visit = (parent: Root | Element) => {
      for (const node of parent.children) {
        if (node.type !== "element") continue;
        if (/^h[1-6]$/.test(node.tagName)) {
          const slug = headingText(node)
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, "")
            .replace(/\s/g, "-");
          if (slug) {
            let target = slug;
            for (let i = 1; used.has(target); i++) target = `${slug}-${i}`;
            used.add(target);
            node.properties.dataPreviewFragment = target;
            node.properties.tabIndex = -1;
          }
        }
        visit(node);
      }
    };
    visit(tree);
  };
}

export function focusFilePreviewFragment(container: HTMLElement, fragment: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return;
  }
  const target = Array.from(
    container.querySelectorAll<HTMLElement>("[data-preview-fragment], [id]"),
  ).find((element) => element.dataset.previewFragment === decoded || element.id === decoded);
  if (!target && (!decoded || decoded.toLowerCase() === "top")) container.scrollTop = 0;
  target?.scrollIntoView({ block: "start" });
  target?.focus({ preventScroll: true });
}
