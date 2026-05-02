import { describe, expect, it } from "vitest";

import { sanitizeEmailHtml } from "../email-html-sanitize";

describe("sanitizeEmailHtml", () => {
  it("removes meta tags that can trigger srcdoc parser warnings", () => {
    const html = '<meta name="viewport" content="width=device-width; initial-scale=1"><p>Hello</p>';

    expect(sanitizeEmailHtml(html)).toBe("<p>Hello</p>");
  });

  it("removes remote font declarations and imports before CSP evaluates them", () => {
    const html = `<style>
      @import url("https://fonts.example.com/css?family=Inter");
      @font-face { font-family: "Inter"; src: url("https://fonts.example.com/inter.woff2") format("woff2"); }
      .hero { background-image: url("https://cdn.example.com/bg.png"); }
    </style><p>Body</p>`;

    const result = sanitizeEmailHtml(html);

    expect(result).not.toContain("@import");
    expect(result).not.toContain("@font-face");
    expect(result).not.toContain("https://fonts.example.com");
    expect(result).toContain("url(about:blank)");
  });

  it("removes inline script hooks without stripping safe image URLs", () => {
    const html = `<body onload="alert(1)">
      <a href="javascript:alert(1)" onclick="alert(2)">Open</a>
      <img src="https://example.com/image.png" onerror="alert(3)">
      <form action="https://example.com/post" method="post" onsubmit="alert(4)"></form>
    </body>`;

    const result = sanitizeEmailHtml(html);

    expect(result).not.toContain("onload");
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("onerror");
    expect(result).not.toContain("onsubmit");
    expect(result).not.toContain("javascript:");
    expect(result).not.toContain("https://example.com/post");
    expect(result).toContain('src="https://example.com/image.png"');
  });
});
