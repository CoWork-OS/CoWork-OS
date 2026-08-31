import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("text", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sh", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHighlightedHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return escapeHtml(html);
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const sourceRoot = parsed.body.firstElementChild;
  if (!sourceRoot) return "";

  const outputDoc = parser.parseFromString("<div></div>", "text/html");
  const outputRoot = outputDoc.body.firstElementChild as HTMLElement;

  const appendSanitized = (node: ChildNode, parent: HTMLElement): void => {
    if (node.nodeType === 3) {
      parent.appendChild(outputDoc.createTextNode(node.textContent || ""));
      return;
    }
    if (node.nodeType !== 1) return;

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();

    if (tag === "span") {
      const span = outputDoc.createElement("span");
      const classes = (element.getAttribute("class") || "")
        .split(/\s+/)
        .map((name) => name.trim())
        .filter((name) => /^hljs(?:-[a-z0-9_-]+)?$/i.test(name));
      if (classes.length > 0) {
        span.setAttribute("class", classes.join(" "));
      }
      for (const child of Array.from(element.childNodes)) {
        appendSanitized(child, span);
      }
      parent.appendChild(span);
      return;
    }

    if (tag === "br") {
      parent.appendChild(outputDoc.createElement("br"));
      return;
    }

    for (const child of Array.from(element.childNodes)) {
      appendSanitized(child, parent);
    }
  };

  for (const child of Array.from(sourceRoot.childNodes)) {
    appendSanitized(child, outputRoot);
  }

  return outputRoot.innerHTML;
}

function highlightCode(code: string, language?: string): string | null {
  if (!code) return null;
  if (language && hljs.getLanguage(language)) {
    try {
      return sanitizeHighlightedHtml(hljs.highlight(code, { language }).value);
    } catch {
      // Fall through to auto-detection.
    }
  }
  try {
    return sanitizeHighlightedHtml(hljs.highlightAuto(code).value);
  } catch {
    return null;
  }
}

export function HighlightedCodeBlock({
  code,
  language,
  className,
  codeProps,
}: {
  code: string;
  language?: string;
  className?: string;
  codeProps?: Record<string, unknown>;
}) {
  const highlightedHtml = useMemo(() => highlightCode(code, language), [code, language]);
  if (highlightedHtml) {
    return (
      <code
        className={`hljs ${className || ""}`}
        {...codeProps}
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    );
  }
  return (
    <code className={className} {...codeProps}>
      {code}
    </code>
  );
}

export function HighlightedCodePreview({ code, language }: { code: string; language?: string }) {
  const highlightedHtml = useMemo(() => highlightCode(code, language), [code, language]);
  if (highlightedHtml) {
    return (
      <pre className="code-preview-content">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
      </pre>
    );
  }
  return (
    <pre className="code-preview-content">
      <code>{code}</code>
    </pre>
  );
}
