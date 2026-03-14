import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { InlineVideoPreview } from "./InlineVideoPreview";

type AssistantMessageContentProps = {
  message: string;
  markdownComponents: Any;
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
};

type VideoDirective = {
  path: string;
  title?: string;
  poster?: string;
  muted?: boolean;
  loop?: boolean;
};

type MessageSegment =
  | { type: "markdown"; content: string }
  | { type: "video"; directive: VideoDirective; raw: string }
  | { type: "video_error"; raw: string; error: string };

const VIDEO_DIRECTIVE_LINE_REGEX = /^\s*::video\{(.+)\}\s*$/;
const DIRECTIVE_ATTR_REGEX = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)/g;

function decodeQuotedValue(value: string): string {
  if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
  return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function parseVideoDirective(line: string): MessageSegment {
  const match = line.match(VIDEO_DIRECTIVE_LINE_REGEX);
  if (!match) {
    return { type: "markdown", content: line };
  }

  const attrs = match[1];
  const parsed: Partial<VideoDirective> = {};
  const seenKeys = new Set<string>();
  let attrMatch: RegExpExecArray | null;

  DIRECTIVE_ATTR_REGEX.lastIndex = 0;
  while ((attrMatch = DIRECTIVE_ATTR_REGEX.exec(attrs)) !== null) {
    const key = attrMatch[1];
    const rawValue = attrMatch[2];
    seenKeys.add(key);

    if (rawValue === "true" || rawValue === "false") {
      (parsed as Record<string, unknown>)[key] = rawValue === "true";
      continue;
    }

    (parsed as Record<string, unknown>)[key] = decodeQuotedValue(rawValue);
  }

  const unmatched = attrs.replace(DIRECTIVE_ATTR_REGEX, "").trim();
  if (unmatched.length > 0) {
    return {
      type: "video_error",
      raw: line,
      error: "Invalid video directive syntax",
    };
  }

  if (!seenKeys.has("path") || typeof parsed.path !== "string" || parsed.path.trim().length === 0) {
    return {
      type: "video_error",
      raw: line,
      error: "Video embed requires a path",
    };
  }

  return {
    type: "video",
    raw: line,
    directive: {
      path: parsed.path.trim(),
      title: typeof parsed.title === "string" ? parsed.title.trim() : undefined,
      poster: typeof parsed.poster === "string" ? parsed.poster.trim() : undefined,
      muted: parsed.muted === true,
      loop: parsed.loop === true,
    },
  };
}

export function parseAssistantMessageSegments(message: string): MessageSegment[] {
  const lines = String(message || "").split("\n");
  const segments: MessageSegment[] = [];
  let markdownBuffer: string[] = [];

  const flushMarkdown = () => {
    if (markdownBuffer.length === 0) return;
    segments.push({ type: "markdown", content: markdownBuffer.join("\n") });
    markdownBuffer = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("::video{")) {
      flushMarkdown();
      const parsed = parseVideoDirective(line);
      if (parsed.type === "markdown") {
        markdownBuffer.push(line);
      } else {
        segments.push(parsed);
      }
      continue;
    }
    markdownBuffer.push(line);
  }

  flushMarkdown();
  return segments;
}

export function AssistantMessageContent({
  message,
  markdownComponents,
  workspacePath,
  onOpenViewer,
}: AssistantMessageContentProps) {
  const segments = parseAssistantMessageSegments(message);

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "markdown") {
          if (!segment.content.trim()) return null;
          return (
            <ReactMarkdown key={`md-${index}`} remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {segment.content}
            </ReactMarkdown>
          );
        }

        if (segment.type === "video_error") {
          return (
            <div key={`video-error-${index}`} className="assistant-video-error">
              {segment.error}
            </div>
          );
        }

        if (!workspacePath) {
          return (
            <div key={`video-missing-workspace-${index}`} className="assistant-video-error">
              Video embeds require a workspace-backed file.
            </div>
          );
        }

        return (
          <div key={`video-${index}`} className="assistant-video-embed">
            <InlineVideoPreview
              filePath={segment.directive.path}
              workspacePath={workspacePath}
              title={segment.directive.title}
              posterPath={segment.directive.poster}
              muted={segment.directive.muted}
              loop={segment.directive.loop}
              onOpenViewer={onOpenViewer}
              className="inline-video-preview-embedded"
            />
          </div>
        );
      })}
    </>
  );
}
