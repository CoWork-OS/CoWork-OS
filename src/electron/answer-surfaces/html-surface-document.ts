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

const RUNTIME_TAGS = [
  `<style id="cowork-surface-autosize">\n${HTML_SURFACE_AUTOSIZE_CSS}\n</style>`,
  `<script id="cowork-surface-bridge">\n${HTML_SURFACE_BOOTSTRAP_SCRIPT}\n</script>`,
].join("\n");

// Tag scans are bounded: an unbounded `[^>]*` over a 1 MB document with many unclosed
// `<head` openings is quadratic and would stall the main process.
const HEAD_TAG = /<head\b[^>]{0,2000}>/i;
const HTML_TAG = /<html\b[^>]{0,2000}>/i;
/** Resource hints are not covered by the CSP and could leak data through DNS lookups. */
const RESOURCE_HINT =
  /<link\b[^>]{0,2000}\brel\s*=\s*["']?(?:dns-prefetch|preconnect|prefetch|prerender|modulepreload)\b[^>]{0,2000}>/gi;

/** Puts the bridge first in <head>, so it is defined before any page script runs. */
function injectRuntime(html: string): string {
  if (HEAD_TAG.test(html)) {
    return html.replace(HEAD_TAG, (match) => `${match}\n${RUNTIME_TAGS}`);
  }
  if (HTML_TAG.test(html)) {
    return html.replace(HTML_TAG, (match) => `${match}\n<head>${RUNTIME_TAGS}</head>`);
  }
  return `${RUNTIME_TAGS}\n${html}`;
}

export function prepareHtmlSurfaceDocument(request: RegisterHtmlSurfaceRequest): string {
  const html = request.html.replace(RESOURCE_HINT, "");
  const themed = request.designLanguage
    ? applyRichFrameDesignLanguage(html, {
        theme: request.theme,
        hostBackground: request.hostBackground,
      })
    : html;
  return injectRuntime(themed);
}

/** Validates a renderer request and returns the preview URL the frame loads. */
export function registerHtmlSurface(
  raw: unknown,
  createPreviewUrl: (html: string) => string,
): { url: string } {
  const request = validateInput(RegisterHtmlSurfaceSchema, raw, "HTML surface");
  return { url: createPreviewUrl(prepareHtmlSurfaceDocument(request)) };
}
