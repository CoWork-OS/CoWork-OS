import { describe, expect, it } from "vitest";
import { isAllowedWebviewUrl, isLocalHtmlFileUrl, isLoopbackHttpUrl } from "../webview-url-policy";

describe("webview URL policy", () => {
  it("allows standard browser and app preview schemes", () => {
    expect(isAllowedWebviewUrl("about:blank")).toBe(true);
    expect(isAllowedWebviewUrl("https://example.com/page")).toBe(true);
    expect(isAllowedWebviewUrl("http://localhost:5173")).toBe(true);
    expect(isAllowedWebviewUrl("canvas://preview/123")).toBe(true);
  });

  it("recognizes only credential-free loopback HTTP preview URLs", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:4173")).toBe(true);
    expect(isLoopbackHttpUrl("http://[::1]:4173/preview")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost:4173")).toBe(true);
    expect(isLoopbackHttpUrl("http://127.0.0.1/preview")).toBe(false);
    expect(isLoopbackHttpUrl("http://127.0.0.1:4173@evil.example")).toBe(false);
    expect(isLoopbackHttpUrl("https://127.0.0.1:4173")).toBe(false);
  });

  it("identifies local generated HTML previews without allowing them globally", () => {
    expect(
      isLocalHtmlFileUrl(
        "file:///Users/mesut/Desktop/untitled%20folder/city-blueprint-preview.html",
      ),
    ).toBe(true);
    expect(isLocalHtmlFileUrl("file://localhost/tmp/preview.HTM")).toBe(true);
    expect(isLocalHtmlFileUrl("file:///tmp/report.xhtml?preview=1")).toBe(true);
    expect(
      isAllowedWebviewUrl(
        "file:///Users/mesut/Desktop/untitled%20folder/city-blueprint-preview.html",
      ),
    ).toBe(false);
  });

  it("blocks non-HTML file URLs and remote file shares", () => {
    expect(isAllowedWebviewUrl("file:///Users/mesut/Desktop/report.pdf")).toBe(false);
    expect(isAllowedWebviewUrl("file:///Users/mesut/Desktop/secrets")).toBe(false);
    expect(isAllowedWebviewUrl("file://fileserver/share/preview.html")).toBe(false);
  });

  it("blocks unsupported and malformed URLs", () => {
    expect(isAllowedWebviewUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedWebviewUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isAllowedWebviewUrl("not a url")).toBe(false);
    expect(isAllowedWebviewUrl("")).toBe(false);
  });
});
