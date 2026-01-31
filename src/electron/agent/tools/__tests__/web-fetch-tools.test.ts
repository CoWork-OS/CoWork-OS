/**
 * Tests for WebFetchTools - lightweight URL fetching without browser automation
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking
import { WebFetchTools } from '../web-fetch-tools';
import { Workspace } from '../../../../shared/types';

// Mock daemon
const mockDaemon = {
  logEvent: vi.fn(),
  registerArtifact: vi.fn(),
};

// Mock workspace
const mockWorkspace: Workspace = {
  id: 'test-workspace',
  name: 'Test Workspace',
  path: '/test/workspace',
  permissions: {
    fileRead: true,
    fileWrite: true,
    shell: false,
  },
  createdAt: new Date().toISOString(),
  lastAccessed: new Date().toISOString(),
};

describe('WebFetchTools', () => {
  let webFetchTools: WebFetchTools;

  beforeEach(() => {
    vi.clearAllMocks();
    webFetchTools = new WebFetchTools(mockWorkspace, mockDaemon as any, 'test-task-id');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getToolDefinitions', () => {
    it('should return web_fetch tool definition', () => {
      const tools = WebFetchTools.getToolDefinitions();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('web_fetch');
      expect(tools[0].description).toContain('PREFERRED');
      expect(tools[0].input_schema.required).toContain('url');
    });

    it('should have correct input schema properties', () => {
      const tools = WebFetchTools.getToolDefinitions();
      const schema = tools[0].input_schema;

      expect(schema.properties).toHaveProperty('url');
      expect(schema.properties).toHaveProperty('selector');
      expect(schema.properties).toHaveProperty('includeLinks');
      expect(schema.properties).toHaveProperty('maxLength');
    });
  });

  describe('webFetch', () => {
    describe('URL validation', () => {
      it('should reject non-HTTP URLs', async () => {
        const result = await webFetchTools.webFetch({ url: 'ftp://example.com' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Only HTTP and HTTPS URLs are supported');
      });

      it('should reject invalid URLs', async () => {
        const result = await webFetchTools.webFetch({ url: 'not-a-url' });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it('should accept HTTP URLs', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => '<html><body>Test</body></html>',
        });

        const result = await webFetchTools.webFetch({ url: 'http://example.com' });

        expect(result.success).toBe(true);
      });

      it('should accept HTTPS URLs', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => '<html><body>Test</body></html>',
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
      });
    });

    describe('HTTP response handling', () => {
      it('should handle HTTP errors', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com/notfound' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('404');
      });

      it('should handle 500 errors', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com/error' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('500');
      });

      it('should handle JSON responses', async () => {
        const jsonData = { name: 'test', value: 123 };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'application/json']]),
          json: async () => jsonData,
        });

        const result = await webFetchTools.webFetch({ url: 'https://api.example.com/data' });

        expect(result.success).toBe(true);
        expect(result.title).toBe('JSON Response');
        expect(result.content).toContain('"name": "test"');
        expect(result.content).toContain('"value": 123');
      });

      it('should handle plain text responses', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/plain']]),
          text: async () => 'Hello, World!',
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com/text' });

        expect(result.success).toBe(true);
        expect(result.title).toBe('Plain Text');
        expect(result.content).toBe('Hello, World!');
      });
    });

    describe('HTML to markdown conversion', () => {
      it('should convert headings', async () => {
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
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.title).toBe('Test Page');
        expect(result.content).toContain('# Main Title');
        expect(result.content).toContain('## Subtitle');
        expect(result.content).toContain('### Section');
      });

      it('should convert paragraphs', async () => {
        const html = '<html><body><p>First paragraph</p><p>Second paragraph</p></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).toContain('First paragraph');
        expect(result.content).toContain('Second paragraph');
      });

      it('should convert bold and italic text', async () => {
        const html = '<html><body><strong>Bold</strong> and <em>italic</em> text</body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).toContain('**Bold**');
        expect(result.content).toContain('*italic*');
      });

      it('should convert code blocks', async () => {
        const html = '<html><body><pre><code>const x = 1;</code></pre></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).toContain('```');
        expect(result.content).toContain('const x = 1;');
      });

      it('should convert inline code', async () => {
        const html = '<html><body>Use <code>npm install</code> to install</body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).toContain('`npm install`');
      });

      it('should convert lists', async () => {
        const html = '<html><body><ul><li>Item 1</li><li>Item 2</li></ul></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).toContain('- Item 1');
        expect(result.content).toContain('- Item 2');
      });

      it('should include links when includeLinks is true', async () => {
        const html = '<html><body><a href="https://test.com">Click here</a></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com', includeLinks: true });

        expect(result.success).toBe(true);
        expect(result.content).toContain('[Click here](https://test.com)');
      });

      it('should exclude links when includeLinks is false', async () => {
        const html = '<html><body><a href="https://test.com">Click here</a></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com', includeLinks: false });

        expect(result.success).toBe(true);
        expect(result.content).toContain('Click here');
        expect(result.content).not.toContain('](https://test.com)');
      });

      it('should remove script tags', async () => {
        const html = '<html><body><script>alert("evil")</script><p>Safe content</p></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).not.toContain('alert');
        expect(result.content).toContain('Safe content');
      });

      it('should remove style tags', async () => {
        const html = '<html><body><style>.red { color: red; }</style><p>Content</p></body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).not.toContain('.red');
        expect(result.content).toContain('Content');
      });

      it('should remove nav and footer elements', async () => {
        const html = `
          <html><body>
            <nav>Navigation</nav>
            <main>Main content</main>
            <footer>Footer</footer>
          </body></html>
        `;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).not.toContain('Navigation');
        expect(result.content).not.toContain('Footer');
        expect(result.content).toContain('Main content');
      });

      it('should decode HTML entities', async () => {
        const html = '<html><body>&amp; &lt; &gt; &quot; &copy;</body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).toContain('&');
        expect(result.content).toContain('<');
        expect(result.content).toContain('>');
        expect(result.content).toContain('"');
        expect(result.content).toContain('(c)');
      });
    });

    describe('content truncation', () => {
      it('should truncate content exceeding maxLength', async () => {
        const longContent = 'A'.repeat(60000);
        const html = `<html><body>${longContent}</body></html>`;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com', maxLength: 1000 });

        expect(result.success).toBe(true);
        expect(result.content.length).toBeLessThanOrEqual(1100); // 1000 + truncation message
        expect(result.content).toContain('[Content truncated]');
      });

      it('should not truncate content within maxLength', async () => {
        const html = '<html><body>Short content</body></html>';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(result.success).toBe(true);
        expect(result.content).not.toContain('[Content truncated]');
      });
    });

    describe('CSS selector extraction', () => {
      it('should extract content from article selector', async () => {
        const html = `
          <html><body>
            <div>Header</div>
            <article>Article content here</article>
            <div>Footer</div>
          </body></html>
        `;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com', selector: 'article' });

        expect(result.success).toBe(true);
        expect(result.content).toContain('Article content here');
      });

      it('should extract content from main selector', async () => {
        const html = `
          <html><body>
            <nav>Navigation</nav>
            <main>Main content</main>
            <footer>Footer</footer>
          </body></html>
        `;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => html,
        });

        const result = await webFetchTools.webFetch({ url: 'https://example.com', selector: 'main' });

        expect(result.success).toBe(true);
        expect(result.content).toContain('Main content');
      });
    });

    describe('logging', () => {
      it('should log fetch event', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => '<html><body>Test</body></html>',
        });

        await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'log', {
          message: 'Fetching: https://example.com',
        });
      });

      it('should log tool result on success', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => '<html><head><title>Test</title></head><body>Content</body></html>',
        });

        await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'tool_result', expect.objectContaining({
          tool: 'web_fetch',
          result: expect.objectContaining({
            url: 'https://example.com',
            title: 'Test',
          }),
        }));
      });

      it('should log error on failure', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        });

        await webFetchTools.webFetch({ url: 'https://example.com' });

        expect(mockDaemon.logEvent).toHaveBeenCalledWith('test-task-id', 'tool_result', expect.objectContaining({
          tool: 'web_fetch',
          error: expect.stringContaining('500'),
        }));
      });
    });

    describe('timeout handling', () => {
      it('should handle timeout errors', async () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        mockFetch.mockRejectedValueOnce(abortError);

        const result = await webFetchTools.webFetch({ url: 'https://slow-site.com' });

        expect(result.success).toBe(false);
        expect(result.error).toBe('Request timed out');
      });
    });
  });
});
