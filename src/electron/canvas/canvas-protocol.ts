/**
 * Canvas Protocol Handler
 *
 * Registers a custom 'canvas://' URL scheme that serves files from
 * canvas session directories to the canvas BrowserWindows.
 *
 * URL Format: canvas://{sessionId}/{filename}
 * Example: canvas://abc123-def456/index.html
 */

import { protocol } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { CanvasManager } from './canvas-manager';

// MIME type mapping
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

/**
 * Get MIME type for a file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Create an error response
 */
function createErrorResponse(statusCode: number, message: string): Response {
  return new Response(message, {
    status: statusCode,
    headers: {
      'Content-Type': 'text/plain',
    },
  });
}

/**
 * Register the canvas:// protocol scheme as privileged
 * Must be called before app.ready
 */
export function registerCanvasScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'canvas',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Register the canvas:// protocol handler
 * Must be called after app.ready
 */
export function registerCanvasProtocol(): void {
  protocol.handle('canvas', async (request) => {
    try {
      const url = new URL(request.url);
      const sessionId = url.hostname;
      let filePath = decodeURIComponent(url.pathname);

      // Security: prevent path traversal attacks
      if (filePath.includes('..') || filePath.includes('//')) {
        console.warn(`[CanvasProtocol] Blocked path traversal attempt: ${filePath}`);
        return createErrorResponse(403, 'Forbidden: Invalid path');
      }

      // Get the canvas manager
      const manager = CanvasManager.getInstance();
      const session = manager.getSession(sessionId);

      if (!session) {
        console.warn(`[CanvasProtocol] Session not found: ${sessionId}`);
        return createErrorResponse(404, 'Session not found');
      }

      // Default to index.html for root requests
      if (filePath === '/' || filePath === '') {
        filePath = '/index.html';
      }

      // Remove leading slash
      const relativePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      const fullPath = path.join(session.sessionDir, relativePath);

      // Security: ensure the resolved path is within the session directory
      const resolvedPath = path.resolve(fullPath);
      const resolvedSessionDir = path.resolve(session.sessionDir);
      if (!resolvedPath.startsWith(resolvedSessionDir)) {
        console.warn(`[CanvasProtocol] Path escape attempt: ${fullPath}`);
        return createErrorResponse(403, 'Forbidden: Path outside session');
      }

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        console.warn(`[CanvasProtocol] File not found: ${fullPath}`);
        return createErrorResponse(404, 'File not found');
      }

      // Get file stats
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        // Try index.html in directory
        const indexPath = path.join(fullPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath);
          return new Response(content, {
            status: 200,
            headers: {
              'Content-Type': 'text/html',
              'Content-Length': content.length.toString(),
            },
          });
        }
        return createErrorResponse(403, 'Directory listing not allowed');
      }

      // Read and serve the file
      const content = fs.readFileSync(fullPath);
      const mimeType = getMimeType(fullPath);

      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': content.length.toString(),
          'Cache-Control': 'no-cache', // Disable caching for development
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[CanvasProtocol] Error handling request:', error);
      return createErrorResponse(500, `Internal error: ${message}`);
    }
  });

  console.log('[CanvasProtocol] Registered canvas:// protocol handler');
}
