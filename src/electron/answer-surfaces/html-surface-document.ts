/**
 * Inline HTML answer surfaces: turns a model-written document into the page the app
 * frames. The page is served from `cowork-preview://` (opaque origin, no network, see
 * web-preview-protocol.ts) so its own scripts run, with the design tokens and the
 * bridge bootstrap injected here in main rather than trusted from the renderer.
 */
import { z } from "zod";
import {
  HTML_SURFACE_AUTOSIZE_CSS,
  HTML_SURFACE_BOOTSTRAP_SCRIPT,
  HTML_SURFACE_MAX_HTML_CHARS,
} from "../../shared/answer-surfaces/html-bridge";
import { HTML_KIT_SCRIPT } from "../../shared/answer-surfaces/html-kit-script";
import { findOpeningTags, insertAfterTag } from "../../shared/html-tags";
import { applyRichFrameDesignLanguage } from "../../shared/rich-frame-design-language";
import { validateInput } from "../utils/validation";

export const RegisterHtmlSurfaceSchema = z
  .object({
    html: z.string().min(1).max(HTML_SURFACE_MAX_HTML_CHARS),
    theme: z.enum(["light", "dark"]),
    hostBackground: z.string().max(60).optional(),
    designLanguage: z.boolean(),
  })
  .strict();

export type RegisterHtmlSurfaceRequest = z.infer<typeof RegisterHtmlSurfaceSchema>;

const AUTOSIZE_TAG = `<style id="cowork-surface-autosize">\n${HTML_SURFACE_AUTOSIZE_CSS}\n</style>`;
const BRIDGE_TAG = `<script id="cowork-surface-bridge">\n${HTML_SURFACE_BOOTSTRAP_SCRIPT}\n</script>`;
/** Runs before the bridge, which exposes its helpers as cowork.chart, cowork.icon, … */
const KIT_TAG = `<script id="cowork-surface-kit">\n${HTML_KIT_SCRIPT}\n</script>`;

/** Resource hints are not covered by the CSP and could leak data through DNS lookups. */
const RESOURCE_HINT_REL =
  /\brel\s*=\s*["']?(?:dns-prefetch|preconnect|prefetch|prerender|modulepreload)\b/i;

/*
 * Tag work uses the linear scanner in html-tags.ts: regexes over a 1 MB document with
 * many unclosed `<head` or `<link` openings take quadratic time and stall main.
 */
function stripResourceHints(html: string): string {
  const hints = findOpeningTags(html, "link").filter((tag) => RESOURCE_HINT_REL.test(tag.text));
  if (hints.length === 0) return html;
  let result = "";
  let from = 0;
  for (const hint of hints) {
    result += html.slice(from, hint.start);
    from = hint.end;
  }
  return result + html.slice(from);
}

/** Puts the bridge first in <head>, so it is defined before any page script runs. */
function injectRuntime(html: string, withKit: boolean): string {
  const tags = [AUTOSIZE_TAG, ...(withKit ? [KIT_TAG] : []), BRIDGE_TAG].join("\n");
  return (
    insertAfterTag(html, "head", `\n${tags}`) ??
    insertAfterTag(html, "html", `\n<head>${tags}</head>`) ??
    `${tags}\n${html}`
  );
}

export function prepareHtmlSurfaceDocument(request: RegisterHtmlSurfaceRequest): string {
  const html = stripResourceHints(request.html);
  const themed = request.designLanguage
    ? applyRichFrameDesignLanguage(html, {
        theme: request.theme,
        hostBackground: request.hostBackground,
      })
    : html;
  return injectRuntime(themed, request.designLanguage);
}

/** Validates a renderer request and returns the preview URL the frame loads. */
export function registerHtmlSurface(
  raw: unknown,
  createPreviewUrl: (html: string) => string,
): { url: string } {
  const request = validateInput(RegisterHtmlSurfaceSchema, raw, "HTML surface");
  return { url: createPreviewUrl(prepareHtmlSurfaceDocument(request)) };
}
