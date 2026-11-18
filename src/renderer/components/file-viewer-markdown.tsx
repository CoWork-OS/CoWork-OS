import type { Components } from "react-markdown";

interface FileViewerMarkdownOptions {
  filePath: string;
  onOpenFile: (filePath: string) => void;
  onOpenExternal: (url: string) => Promise<unknown>;
  onError: (error: unknown) => void;
}

/** Resolve document links against the file, never against the renderer's app URL. */
export function buildFileViewerMarkdownComponents({
  filePath,
  onOpenFile,
  onOpenExternal,
  onError,
}: FileViewerMarkdownOptions): Components {
  return {
    a: ({ href, children, node: _node, ...props }) => (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          // In-page anchors can use the browser's normal fragment navigation.
          if (href?.startsWith("#")) return;
          event.preventDefault();
          event.stopPropagation();
          if (!href) return;

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
            onOpenFile(localPath);
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
