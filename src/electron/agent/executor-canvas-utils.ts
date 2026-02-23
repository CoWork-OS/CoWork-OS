export function isCanvasPlaceholderHtml(content: string): boolean {
  const marker = "Waiting for content...";
  const normalized = String(content || "").trim();
  return !normalized || normalized === marker || normalized.includes(marker);
}

export function sanitizeForCanvasText(raw: string): string {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildCanvasFallbackHtml(prompt: string, details: string): string {
  const title = "Canvas Output";
  const summary = sanitizeForCanvasText((prompt || "Request content").slice(0, 300));
  const detailText = sanitizeForCanvasText(String(details || ""));

  return `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${title}</title>\n  <style>\n    body {\n      margin: 0;\n      min-height: 100vh;\n      display: grid;\n      place-items: center;\n      background: linear-gradient(130deg, #0f1220, #11152f);\n      color: #e7e9f2;\n      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n      padding: 20px;\n      box-sizing: border-box;\n      text-align: center;\n    }\n    .card {\n      width: min(760px, 100%);\n      background: rgba(24, 29, 54, 0.85);\n      border: 1px solid rgba(255, 255, 255, 0.12);\n      border-radius: 14px;\n      padding: 20px;\n      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);\n    }\n    h1 {\n      margin: 0 0 12px;\n      font-size: 24px;\n      letter-spacing: 0.2px;\n    }\n    p {\n      margin: 0;\n      color: #b4bed3;\n      line-height: 1.5;\n      font-size: 14px;\n      white-space: pre-wrap;\n    }\n    .details {\n      margin-top: 12px;\n      color: #93a0c1;\n      font-size: 13px;\n    }\n  </style>\n</head>\n<body>\n  <div class="card">\n    <h1>${title}</h1>\n    <p>${summary}</p>\n    <p class="details">${detailText || "Preparing visual output..."}</p>\n  </div>\n</body>\n</html>`;
}

export function normalizeCanvasContent(payload: string, fallbackPrompt: string): string {
  const trimmed = String(payload || "").trim();

  if (!trimmed) {
    return buildCanvasFallbackHtml(fallbackPrompt, "No content was provided.");
  }

  if (isCanvasPlaceholderHtml(trimmed)) {
    return buildCanvasFallbackHtml(fallbackPrompt, "Placeholder content received.");
  }

  const hasDocument = /<html[\s>]/i.test(trimmed) || /<!doctype\s+html/i.test(trimmed);
  if (hasDocument) {
    return trimmed;
  }

  if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    return `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Canvas Output</title>\n  <style>\n    body {\n      margin: 0;\n      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\n      background: #0f1220;\n      color: #e7e9f2;\n      padding: 24px;\n    }\n  </style>\n</head>\n<body>\n${trimmed}\n</body>\n</html>`;
  }

  return buildCanvasFallbackHtml(fallbackPrompt, sanitizeForCanvasText(trimmed));
}
