/**
 * Tests for WebFetchTools - lightweight URL fetching without browser automation
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import PDFDocument from "pdfkit";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock("../../../security/pinned-fetch", () => ({
  pinnedFetch: async (url: string, init: RequestInit) => {
    const response = await global.fetch(url, init);
    if (!response.body && typeof response.text === "function") {
      Object.assign(response, { body: new Response(await response.text()).body });
    }
    return response;
  },
}));

// Import after mocking
import { WebFetchTools } from "../web-fetch-tools";
import { Workspace } from "../../../../shared/types";
import { GuardrailManager } from "../../../guardrails/guardrail-manager";

// Mock daemon
const mockDaemon = {
  logEvent: vi.fn(),
  registerArtifact: vi.fn(),
};

const mockProtectedCredentialService = {
  resolveForDestination: vi.fn(),
};

// Mock workspace
const mockWorkspace: Workspace = {
  id: "test-workspace",
  name: "Test Workspace",
  path: "/test/workspace",
  permissions: {
    fileRead: true,
    fileWrite: true,
    shell: false,
  },
  createdAt: new Date().toISOString(),
  lastAccessed: new Date().toISOString(),
};

describe("WebFetchTools", () => {
  let webFetchTools: WebFetchTools;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(true);
    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValue({
      enforceAllowedDomains: true,
      allowedDomains: ["example.com"],
    } as Any);
    webFetchTools = new WebFetchTools(mockWorkspace, mockDaemon as Any, "test-task-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops reading oversized bodies at the cap and returns truncated content", async () => {
    const cancel = vi.fn();
    mockFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(5 * 1024 * 1024));
            c.enqueue(new Uint8Array(1));
          },
          cancel,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const result = await webFetchTools.webFetch({ url: "https://example.com", maxLength: 10 });
    expect(result.success).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps http_request deadline active through a stalled body", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      mockFetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
      const pending = webFetchTools.httpRequest({ url: "https://example.com", timeout: 10 });
      await vi.advanceTimersByTimeAsync(11);
      expect(await pending).toMatchObject({ success: false, error: "Request timed out" });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("getToolDefinitions", () => {
    it("should return web_fetch and http_request tool definitions", () => {
      const tools = WebFetchTools.getToolDefinitions();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("web_fetch");
      expect(tools[0].description).toContain("PREFERRED");
      expect(tools[0].input_schema.required).toContain("url");
      expect(tools[1].name).toBe("http_request");
      expect(tools[1].description).toContain("curl");
    });

    it("should have correct input schema properties for web_fetch", () => {
      const tools = WebFetchTools.getToolDefinitions();
      const schema = tools[0].input_schema;

      expect(schema.properties).toHaveProperty("url");
      expect(schema.properties).toHaveProperty("selector");
      expect(schema.properties).toHaveProperty("includeLinks");
      expect(schema.properties).toHaveProperty("maxLength");
    });

    it("should have correct input schema properties for http_request", () => {
      const tools = WebFetchTools.getToolDefinitions();
      const schema = tools[1].input_schema;

      expect(schema.properties).toHaveProperty("url");
      expect(schema.properties).toHaveProperty("method");
      expect(schema.properties).toHaveProperty("headers");
      expect(schema.properties).toHaveProperty("body");
      expect(schema.properties).toHaveProperty("timeout");
      expect(schema.properties).toHaveProperty("followRedirects");
      expect(schema.properties).toHaveProperty("maxLength");
      expect(schema.properties).toHaveProperty("credentialId");
      expect(schema.properties).toHaveProperty("credentialHeader");
      expect(schema.properties).toHaveProperty("credentialPrefix");
      expect(schema.properties.method.enum).toEqual([
        "GET",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
        "HEAD",
        "OPTIONS",
      ]);
    });
  });

  describe("webFetch", () => {
    describe("URL validation", () => {
      it("should reject non-HTTP URLs", async () => {
        const result = await webFetchTools.webFetch({ url: "ftp://example.com" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Only HTTP and HTTPS URLs are supported");
      });

      it("should reject invalid URLs", async () => {
        const result = await webFetchTools.webFetch({ url: "not-a-url" });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it("should accept HTTP URLs", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => "<html><body>Test</body></html>",
        });

        const result = await webFetchTools.webFetch({ url: "http://example.com" });

        expect(result.success).toBe(true);
      });

      it("should accept HTTPS URLs", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => "<html><body>Test</body></html>",
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
      });

      it("should block disallowed domains", async () => {
        vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(false);

        const result = await webFetchTools.webFetch({ url: "https://blocked.example.com" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Domain not allowed");
      });
    });

    describe("HTTP response handling", () => {
      it("should handle HTTP errors", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: "Not Found",
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com/notfound" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("404");
      });

      it("should handle 500 errors", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com/error" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("500");
      });

      it("should handle JSON responses", async () => {
        const jsonData = { name: "test", value: 123 };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "application/json"]]),
          text: async () => JSON.stringify(jsonData),
        });

        const result = await webFetchTools.webFetch({ url: "https://api.example.com/data" });

        expect(result.success).toBe(true);
        expect(result.title).toBe("JSON Response");
        expect(result.content).toContain('"name": "test"');
        expect(result.content).toContain('"value": 123');
      });

      it("should fallback to raw text when JSON parsing fails in webFetch", async () => {
        const invalidJson = "not valid json {{{";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "application/json"]]),
          text: async () => invalidJson,
        });

        const result = await webFetchTools.webFetch({ url: "https://api.example.com/data" });

        expect(result.success).toBe(true);
        expect(result.title).toBe("JSON Response");
        expect(result.content).toBe(invalidJson);
      });

      it("should handle plain text responses", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "Hello, World!",
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com/text" });

        expect(result.success).toBe(true);
        expect(result.title).toBe("Plain Text");
        expect(result.content).toBe("Hello, World!");
      });
    });

    describe("HTML to markdown conversion", () => {
      it("should convert headings", async () => {
        const html = `
          <html>
            <head><title>Test Page</title></head>
            <body>
              <h1>Main Title</h1>
              <h2>Subtitle</h2>
              <h3>Section</h3>
            </body>
          </html>
        `;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.title).toBe("Test Page");
        expect(result.content).toContain("# Main Title");
        expect(result.content).toContain("## Subtitle");
        expect(result.content).toContain("### Section");
      });

      it("should convert paragraphs", async () => {
        const html = "<html><body><p>First paragraph</p><p>Second paragraph</p></body></html>";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).toContain("First paragraph");
        expect(result.content).toContain("Second paragraph");
      });

      it("should convert bold and italic text", async () => {
        const html = "<html><body><strong>Bold</strong> and <em>italic</em> text</body></html>";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).toContain("**Bold**");
        expect(result.content).toContain("*italic*");
      });

      it("should convert code blocks", async () => {
        const html = "<html><body><pre><code>const x = 1;</code></pre></body></html>";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).toContain("```");
        expect(result.content).toContain("const x = 1;");
      });

      it("should convert inline code", async () => {
        const html = "<html><body>Use <code>npm install</code> to install</body></html>";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).toContain("`npm install`");
      });

      it("should convert lists", async () => {
        const html = "<html><body><ul><li>Item 1</li><li>Item 2</li></ul></body></html>";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).toContain("- Item 1");
        expect(result.content).toContain("- Item 2");
      });

      it("should include links when includeLinks is true", async () => {
        const html = '<html><body><a href="https://test.com">Click here</a></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({
          url: "https://example.com",
          includeLinks: true,
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain("[Click here](https://test.com)");
      });

      it("should exclude links when includeLinks is false", async () => {
        const html = '<html><body><a href="https://test.com">Click here</a></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({
          url: "https://example.com",
          includeLinks: false,
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain("Click here");
        expect(result.content).not.toContain("](https://test.com)");
      });

      it("should remove script tags", async () => {
        const html = '<html><body><script>alert("evil")</script><p>Safe content</p></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).not.toContain("alert");
        expect(result.content).toContain("Safe content");
      });

      it("should remove style tags", async () => {
        const html = "<html><body><style>.red { color: red; }</style><p>Content</p></body></html>";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).not.toContain(".red");
        expect(result.content).toContain("Content");
      });

      it("should remove nav and footer elements", async () => {
        const html = `
          <html><body>
            <nav>Navigation</nav>
            <main>Main content</main>
            <footer>Footer</footer>
          </body></html>
        `;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).not.toContain("Navigation");
        expect(result.content).not.toContain("Footer");
        expect(result.content).toContain("Main content");
      });

      it("should decode HTML entities", async () => {
        const html = "<html><body>&amp; &lt; &gt; &quot; &copy;</body></html>";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).toContain("&");
        expect(result.content).toContain("<");
        expect(result.content).toContain(">");
        expect(result.content).toContain('"');
        expect(result.content).toContain("(c)");
      });
    });

    describe("content truncation", () => {
      it("should truncate content exceeding maxLength", async () => {
        const longContent = "A".repeat(60000);
        const html = `<html><body>${longContent}</body></html>`;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({
          url: "https://example.com",
          maxLength: 1000,
        });

        expect(result.success).toBe(true);
        expect(result.content.length).toBeLessThanOrEqual(1100); // 1000 + truncation message
        expect(result.content).toContain("[Content truncated]");
      });

      it("should not truncate content within maxLength", async () => {
        const html = "<html><body>Short content</body></html>";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.content).not.toContain("[Content truncated]");
      });
    });

    describe("CSS selector extraction", () => {
      it("should extract content from article selector", async () => {
        const html = `
          <html><body>
            <div>Header</div>
            <article>Article content here</article>
            <div>Footer</div>
          </body></html>
        `;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({
          url: "https://example.com",
          selector: "article",
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain("Article content here");
      });

      it("should extract content from main selector", async () => {
        const html = `
          <html><body>
            <nav>Navigation</nav>
            <main>Main content</main>
            <footer>Footer</footer>
          </body></html>
        `;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({
          url: "https://example.com",
          selector: "main",
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain("Main content");
      });
    });

    describe("logging", () => {
      it("should log fetch event", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => "<html><body>Test</body></html>",
        });

        await webFetchTools.webFetch({ url: "https://example.com" });

        expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "log", {
          message: "Fetching: https://example.com",
        });
      });

      it("should log tool result on success", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => "<html><head><title>Test</title></head><body>Content</body></html>",
        });

        await webFetchTools.webFetch({ url: "https://example.com" });

        expect(mockDaemon.logEvent).toHaveBeenCalledWith(
          "test-task-id",
          "tool_result",
          expect.objectContaining({
            tool: "web_fetch",
            result: expect.objectContaining({
              url: "https://example.com",
              title: "Test",
            }),
          }),
        );
      });

      it("should log error on failure", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        });

        await webFetchTools.webFetch({ url: "https://example.com" });

        expect(mockDaemon.logEvent).toHaveBeenCalledWith(
          "test-task-id",
          "tool_result",
          expect.objectContaining({
            tool: "web_fetch",
            error: expect.stringContaining("500"),
          }),
        );
      });
    });

    describe("timeout handling", () => {
      it("should handle timeout errors", async () => {
        const abortError = new Error("The operation was aborted");
        abortError.name = "AbortError";
        mockFetch.mockRejectedValueOnce(abortError);

        const result = await webFetchTools.webFetch({ url: "https://slow-site.com" });

        expect(result.success).toBe(false);
        expect(result.error).toBe("Request timed out");
      });
    });
  });

  describe("httpRequest", () => {
    it("should block disallowed domains for raw http requests", async () => {
      vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(false);

      const result = await webFetchTools.httpRequest({ url: "https://blocked.example.com" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Domain not allowed");
    });

    describe("URL validation", () => {
      it("should reject non-HTTP URLs", async () => {
        const result = await webFetchTools.httpRequest({ url: "ftp://example.com" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Only HTTP and HTTPS URLs are supported");
      });

      it("should reject invalid URLs", async () => {
        const result = await webFetchTools.httpRequest({ url: "not-a-url" });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it("should reject empty URLs", async () => {
        const result = await webFetchTools.httpRequest({ url: "" });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it("should accept HTTP URLs", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "Hello",
        });

        const result = await webFetchTools.httpRequest({ url: "http://example.com" });

        expect(result.success).toBe(true);
        expect(result.status).toBe(200);
      });

      it("should accept HTTPS URLs", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "Hello",
        });

        const result = await webFetchTools.httpRequest({ url: "https://example.com" });

        expect(result.success).toBe(true);
      });
    });

    describe("HTTP methods", () => {
      it("should default to GET method", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map(),
          text: async () => "Response",
        });

        await webFetchTools.httpRequest({ url: "https://example.com" });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://example.com",
          expect.objectContaining({ method: "GET" }),
        );
      });

      it("should support POST method with body", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 201,
          statusText: "Created",
          headers: new Map([["content-type", "application/json"]]),
          text: async () => JSON.stringify({ id: 1 }),
        });

        const result = await webFetchTools.httpRequest({
          url: "https://api.example.com/items",
          method: "POST",
          body: '{"name": "test"}',
          headers: { "Content-Type": "application/json" },
        });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://api.example.com/items",
          expect.objectContaining({
            method: "POST",
            body: '{"name": "test"}',
          }),
        );
        expect(result.success).toBe(true);
        expect(result.status).toBe(201);
      });

      it("should support PUT method", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map(),
          text: async () => "Updated",
        });

        await webFetchTools.httpRequest({
          url: "https://api.example.com/items/1",
          method: "PUT",
          body: '{"name": "updated"}',
        });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://api.example.com/items/1",
          expect.objectContaining({ method: "PUT" }),
        );
      });

      it("should support DELETE method", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 204,
          statusText: "No Content",
          headers: new Map(),
          text: async () => "",
        });

        const result = await webFetchTools.httpRequest({
          url: "https://api.example.com/items/1",
          method: "DELETE",
        });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://api.example.com/items/1",
          expect.objectContaining({ method: "DELETE" }),
        );
        expect(result.success).toBe(true);
        expect(result.status).toBe(204);
      });

      it("should support PATCH method", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map(),
          text: async () => "Patched",
        });

        await webFetchTools.httpRequest({
          url: "https://api.example.com/items/1",
          method: "PATCH",
          body: '{"field": "value"}',
        });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://api.example.com/items/1",
          expect.objectContaining({ method: "PATCH" }),
        );
      });

      it("should support HEAD method with empty body", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-length", "12345"]]),
        });

        const result = await webFetchTools.httpRequest({
          url: "https://example.com/file.zip",
          method: "HEAD",
        });

        expect(result.success).toBe(true);
        expect(result.body).toBe("");
        expect(result.headers["content-length"]).toBe("12345");
      });

      it("should support OPTIONS method", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["allow", "GET, POST, PUT, DELETE"]]),
          text: async () => "",
        });

        const result = await webFetchTools.httpRequest({
          url: "https://api.example.com/items",
          method: "OPTIONS",
        });

        expect(result.success).toBe(true);
        expect(result.headers["allow"]).toBe("GET, POST, PUT, DELETE");
      });
    });

    describe("custom headers", () => {
      it("should send custom headers", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map(),
          text: async () => "OK",
        });

        await webFetchTools.httpRequest({
          url: "https://api.example.com",
          headers: {
            Authorization: "Bearer token123",
            "X-Custom-Header": "custom-value",
          },
        });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://api.example.com",
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: "Bearer token123",
              "X-Custom-Header": "custom-value",
            }),
          }),
        );
      });

      it("resolves protected credentials in the main process and redacts echoed secrets", async () => {
        mockProtectedCredentialService.resolveForDestination.mockReturnValue("top-secret");
        const protectedTools = new WebFetchTools(
          mockWorkspace,
          mockDaemon as Any,
          "test-task-id",
          mockProtectedCredentialService as Any,
        );
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([
            ["content-type", "application/json"],
            ["x-echo", "Bearer top-secret"],
          ]),
          text: async () => JSON.stringify({ authorization: "Bearer top-secret" }),
        });

        const result = await protectedTools.httpRequest({
          url: "https://api.example.com/items",
          credentialId: "credential-1",
        });

        expect(mockProtectedCredentialService.resolveForDestination).toHaveBeenCalledWith(
          "credential-1",
          "https://api.example.com/items",
        );
        expect(mockFetch).toHaveBeenCalledWith(
          "https://api.example.com/items",
          expect.objectContaining({
            redirect: "manual",
            headers: expect.objectContaining({ Authorization: "Bearer top-secret" }),
          }),
        );
        expect(result.body).not.toContain("top-secret");
        expect(result.headers["x-echo"]).toBe("Bearer [REDACTED]");
      });

      it("should include default User-Agent header", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map(),
          text: async () => "OK",
        });

        await webFetchTools.httpRequest({ url: "https://example.com" });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://example.com",
          expect.objectContaining({
            headers: expect.objectContaining({
              "User-Agent": expect.stringContaining("Mozilla/5.0"),
              Accept: expect.stringContaining("text/html"),
              "Accept-Language": "en-US,en;q=0.9",
            }),
          }),
        );
      });
    });

    describe("response handling", () => {
      it("should return response status and headers", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([
            ["content-type", "application/json"],
            ["x-request-id", "12345"],
          ]),
          text: async () => JSON.stringify({ data: "test" }),
        });

        const result = await webFetchTools.httpRequest({ url: "https://api.example.com" });

        expect(result.success).toBe(true);
        expect(result.status).toBe(200);
        expect(result.statusText).toBe("OK");
        expect(result.headers["content-type"]).toBe("application/json");
        expect(result.headers["x-request-id"]).toBe("12345");
      });

      it("should handle JSON responses", async () => {
        const jsonData = { users: [{ id: 1, name: "John" }] };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "application/json"]]),
          text: async () => JSON.stringify(jsonData),
        });

        const result = await webFetchTools.httpRequest({ url: "https://api.example.com/users" });

        expect(result.success).toBe(true);
        expect(result.body).toContain('"users"');
        expect(result.body).toContain('"name": "John"');
      });

      it("should handle JSON responses with charset in content-type", async () => {
        const jsonData = { message: "hello" };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "application/json; charset=utf-8"]]),
          text: async () => JSON.stringify(jsonData),
        });

        const result = await webFetchTools.httpRequest({ url: "https://api.example.com" });

        expect(result.success).toBe(true);
        expect(result.body).toContain('"message": "hello"');
      });

      it("should fallback to raw text when JSON parsing fails", async () => {
        const invalidJson = "not valid json {{{";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "application/json"]]),
          text: async () => invalidJson,
        });

        const result = await webFetchTools.httpRequest({ url: "https://api.example.com" });

        expect(result.success).toBe(true);
        expect(result.body).toBe(invalidJson);
      });

      it("should handle plain text responses", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "Plain text response",
        });

        const result = await webFetchTools.httpRequest({ url: "https://example.com/text" });

        expect(result.success).toBe(true);
        expect(result.body).toBe("Plain text response");
      });

      it("should handle HTML responses as raw text", async () => {
        const html = "<html><body><h1>Hello</h1></body></html>";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        });

        const result = await webFetchTools.httpRequest({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.body).toBe(html); // Raw HTML, not converted
      });

      it("should handle HTTP errors", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: new Map(),
          text: async () => "Page not found",
        });

        const result = await webFetchTools.httpRequest({ url: "https://example.com/notfound" });

        expect(result.success).toBe(false);
        expect(result.status).toBe(404);
        expect(result.statusText).toBe("Not Found");
        expect(result.body).toBe("Page not found");
      });

      it("should handle 500 errors", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: new Map(),
          text: async () => "Server error",
        });

        const result = await webFetchTools.httpRequest({ url: "https://example.com/error" });

        expect(result.success).toBe(false);
        expect(result.status).toBe(500);
      });

      it("normalizes duplicated r.jina.ai proxy prefixes", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "proxied",
        });

        const result = await webFetchTools.httpRequest({
          url: "https://r.jina.ai/http://r.jina.ai/http://www.google.com/search?q=ai+agents",
        });

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
          "https://r.jina.ai/http://www.google.com/search?q=ai+agents",
          expect.anything(),
        );
      });

      it("rejects malformed nested proxied absolute URLs", async () => {
        const result = await webFetchTools.httpRequest({
          url: "https://r.jina.ai/http://https://example.com/article",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Malformed proxied URL");
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });

    describe("content truncation", () => {
      it("should truncate response exceeding maxLength", async () => {
        const longContent = "A".repeat(150000);
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => longContent,
        });

        const result = await webFetchTools.httpRequest({
          url: "https://example.com",
          maxLength: 1000,
        });

        expect(result.success).toBe(true);
        expect(result.body.length).toBeLessThanOrEqual(1100);
        expect(result.body).toContain("[Response truncated]");
      });

      it("should not truncate content within maxLength", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "Short content",
        });

        const result = await webFetchTools.httpRequest({ url: "https://example.com" });

        expect(result.success).toBe(true);
        expect(result.body).not.toContain("[Response truncated]");
      });
    });

    describe("redirect handling", () => {
      it.each([
        "https://other.example/final",
        "http://example.com/final",
        "https://example.com:8443/final",
      ])("strips arbitrary credentials on origin change to %s", async (location) => {
        mockFetch.mockResolvedValueOnce(new Response("", { status: 302, headers: { location } }));
        mockFetch.mockResolvedValueOnce(new Response("ok"));
        const result = await webFetchTools.httpRequest({
          url: "https://example.com/start",
          headers: {
            Authorization: "secret",
            Cookie: "session=secret",
            "X-Custom-Token": "secret",
            Accept: "application/json",
          },
        });
        expect(result.success).toBe(true);
        const headers = new Headers(mockFetch.mock.calls[1][1].headers);
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("cookie")).toBeNull();
        expect(headers.get("x-custom-token")).toBeNull();
        expect(headers.get("accept")).toContain("text/html");
      });
      it("preserves same-origin credentials", async () => {
        mockFetch.mockResolvedValueOnce(
          new Response("", { status: 307, headers: { location: "/final" } }),
        );
        mockFetch.mockResolvedValueOnce(new Response("ok"));
        expect(
          (
            await webFetchTools.httpRequest({
              url: "https://example.com/start",
              headers: { "X-Api-Key": "secret" },
            })
          ).success,
        ).toBe(true);
        expect(new Headers(mockFetch.mock.calls[1][1].headers).get("x-api-key")).toBe("secret");
      });
      it.each([301, 302, 307, 308])("blocks body export via PUT redirect %s", async (status) => {
        mockFetch.mockResolvedValueOnce(
          new Response("", { status, headers: { location: "https://other.example/final" } }),
        );
        const result = await webFetchTools.httpRequest({
          url: "https://example.com/start",
          method: "PUT",
          body: "secret",
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Cross-origin");
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
      it("follows a cross-origin POST 303 without its body", async () => {
        mockFetch.mockResolvedValueOnce(
          new Response("", { status: 303, headers: { location: "https://other.example/final" } }),
        );
        mockFetch.mockResolvedValueOnce(new Response("ok"));
        expect(
          (
            await webFetchTools.httpRequest({
              url: "https://example.com/start",
              method: "POST",
              body: "secret",
            })
          ).success,
        ).toBe(true);
        expect(mockFetch.mock.calls[1][1].method).toBe("GET");
        expect(mockFetch.mock.calls[1][1].body).toBeUndefined();
      });
      it("should follow redirects by default after policy-checking each destination", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: "Found",
          headers: new Map([["location", "https://example.com/final"]]),
          text: async () => "",
        });
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "Final destination",
        });

        const result = await webFetchTools.httpRequest({ url: "https://example.com/redirect" });

        expect(result.success).toBe(true);
        expect(result.body).toBe("Final destination");
        expect(mockFetch).toHaveBeenCalledWith(
          "https://example.com/redirect",
          expect.objectContaining({ redirect: "manual" }),
        );
        expect(mockFetch).toHaveBeenCalledWith(
          "https://example.com/final",
          expect.objectContaining({ redirect: "manual" }),
        );
      });

      it("should not follow redirects when disabled", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 302,
          statusText: "Found",
          headers: new Map([["location", "https://example.com/new-location"]]),
          text: async () => "",
        });

        await webFetchTools.httpRequest({
          url: "https://example.com/redirect",
          followRedirects: false,
        });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://example.com/redirect",
          expect.objectContaining({ redirect: "manual" }),
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it("should reject redirects to domains denied by network policy", async () => {
        vi.spyOn(GuardrailManager, "isDomainAllowed").mockImplementation((url: string) => {
          return !url.includes("blocked.example");
        });
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: "Found",
          headers: new Map([["location", "https://blocked.example/final"]]),
          text: async () => "",
        });

        const result = await webFetchTools.httpRequest({ url: "https://example.com/redirect" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Domain not allowed");
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });

    describe("timeout handling", () => {
      it("should handle timeout errors", async () => {
        const abortError = new Error("The operation was aborted");
        abortError.name = "AbortError";
        mockFetch.mockRejectedValueOnce(abortError);

        const result = await webFetchTools.httpRequest({ url: "https://slow-site.com" });

        expect(result.success).toBe(false);
        expect(result.status).toBe(0);
        expect(result.error).toBe("Request timed out");
      });

      it("should handle network errors", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Network error"));

        const result = await webFetchTools.httpRequest({ url: "https://unreachable.com" });

        expect(result.success).toBe(false);
        expect(result.error).toBe("Network error");
      });
    });

    describe("logging", () => {
      it("should log HTTP request event", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map(),
          text: async () => "OK",
        });

        await webFetchTools.httpRequest({
          url: "https://api.example.com",
          method: "POST",
        });

        expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "log", {
          message: "HTTP POST: https://api.example.com",
        });
      });

      it("should log tool result on success", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map(),
          text: async () => "Response body",
        });

        await webFetchTools.httpRequest({ url: "https://example.com" });

        expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "tool_result", {
          tool: "http_request",
          result: expect.objectContaining({
            url: "https://example.com",
            method: "GET",
            status: 200,
          }),
        });
      });

      it("should log error on failure", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Connection failed"));

        await webFetchTools.httpRequest({ url: "https://example.com" });

        expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "tool_result", {
          tool: "http_request",
          error: "Connection failed",
        });
      });

      it("uses browser-like default headers for public web requests", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "ok",
        });

        await webFetchTools.httpRequest({ url: "https://example.com" });

        expect(mockFetch).toHaveBeenCalledWith(
          "https://example.com",
          expect.objectContaining({
            headers: expect.objectContaining({
              "Accept-Language": "en-US,en;q=0.9",
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            }),
          }),
        );
      });
    });
  });
});

function createPdf(pages: string[]): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    pages.forEach((text, index) => {
      if (index > 0) doc.addPage();
      doc.font("Helvetica").fontSize(12).text(text);
    });
    doc.end();
  });
}

describe("WebFetchTools non-HTML content", () => {
  let webFetchTools: WebFetchTools;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(true);
    webFetchTools = new WebFetchTools(mockWorkspace, mockDaemon as Any, "test-task-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const respond = (body: BodyInit, contentType: string) =>
    mockFetch.mockResolvedValueOnce(
      new Response(body, { headers: { "content-type": contentType } }),
    );

  it("extracts the text of a PDF instead of converting its bytes as HTML", async () => {
    const pdf = await createPdf([
      "Transit ridership grew in every district during the reporting period.",
      "Appendix: budget appropriations by department.",
    ]);
    respond(pdf, "application/pdf");

    const result = await webFetchTools.webFetch({ url: "https://example.com/report" });

    expect(result.success, result.error).toBe(true);
    expect(result.content).toContain("Transit ridership grew in every district");
    expect(result.content).toContain("Appendix: budget appropriations");
    expect(result.content).toContain("2 pages");
    expect(result.content).not.toContain("%PDF");
  });

  it("recognizes a PDF served as application/octet-stream", async () => {
    respond(await createPdf(["Octet stream paper abstract text."]), "application/octet-stream");

    const result = await webFetchTools.webFetch({ url: "https://example.com/paper.pdf" });

    expect(result.success, result.error).toBe(true);
    expect(result.content).toContain("Octet stream paper abstract text.");
  });

  it("points images to the image analysis tool", async () => {
    respond(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "image/png");

    const result = await webFetchTools.webFetch({ url: "https://example.com/chart.png" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("image/png");
    expect(result.error).toContain("analyze_image");
  });

  it("points office documents to read_file", async () => {
    respond(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const result = await webFetchTools.webFetch({ url: "https://example.com/brief.docx" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("read_file");
  });

  it.each(["application/zip", "application/octet-stream"])(
    "rejects other binary bodies served as %s",
    async (contentType) => {
      respond(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]), contentType);

      const result = await webFetchTools.webFetch({ url: "https://example.com/archive" });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/binary/i);
    },
  );
});
