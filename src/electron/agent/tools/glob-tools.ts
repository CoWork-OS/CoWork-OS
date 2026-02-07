import * as fs from 'fs';
import * as path from 'path';
import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { LLMTool } from '../llm/types';

/**
 * GlobTools provides fast pattern-based file search
 * Similar to Claude Code's Glob tool for finding files by pattern
 */
export class GlobTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Get tool definitions for Glob tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'glob',
        description:
          'Fast file pattern matching tool. Use glob patterns like "**/*.ts" or "src/**/*.tsx" to find files. ' +
          'Returns matching file paths sorted by modification time (newest first). ' +
          'PREFERRED over search_files when you know the file pattern you want.',
        input_schema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description:
                'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.test.ts", "*.{js,jsx,ts,tsx}")',
            },
            path: {
              type: 'string',
              description:
                'Directory to search in (relative to workspace unless absolute path is allowed). Defaults to workspace root if not specified.',
            },
            maxResults: {
              type: 'number',
              description: 'Maximum number of results to return (default: 100)',
            },
          },
          required: ['pattern'],
        },
      },
    ];
  }

  /**
   * Execute glob pattern search
   */
  async glob(input: {
    pattern: string;
    path?: string;
    maxResults?: number;
  }): Promise<{
    success: boolean;
    pattern: string;
    matches: Array<{ path: string; size: number; modified: string }>;
    totalMatches: number;
    truncated: boolean;
    error?: string;
  }> {
    const { pattern, path: searchPath, maxResults = 100 } = input;

    this.daemon.logEvent(this.taskId, 'log', {
      message: `Glob search: ${pattern}${searchPath ? ` in ${searchPath}` : ''}`,
    });

    try {
      const normalizedWorkspace = path.resolve(this.workspace.path);
      const basePath = searchPath
        ? (path.isAbsolute(searchPath)
            ? path.normalize(searchPath)
            : path.resolve(normalizedWorkspace, searchPath))
        : normalizedWorkspace;

      const isInsideWorkspace = this.isWithinWorkspace(basePath, normalizedWorkspace);
      if (!isInsideWorkspace && !this.isPathAllowedOutsideWorkspace(basePath)) {
        throw new Error('Search path must be within workspace');
      }

      if (!fs.existsSync(basePath)) {
        throw new Error(`Path does not exist: ${searchPath || '.'}`);
      }

      // Parse the glob pattern
      const matches = await this.findMatches(basePath, pattern);

      // Sort by modification time (newest first)
      matches.sort((a, b) => b.mtime - a.mtime);

      // Truncate if needed
      const truncated = matches.length > maxResults;
      const limitedMatches = matches.slice(0, maxResults);

      // Format results
      const results = limitedMatches.map((m) => ({
        path: isInsideWorkspace ? path.relative(normalizedWorkspace, m.path) : m.path,
        size: m.size,
        modified: new Date(m.mtime).toISOString(),
      }));

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'glob',
        result: {
          pattern,
          matchCount: results.length,
          totalMatches: matches.length,
          truncated,
        },
      });

      return {
        success: true,
        pattern,
        matches: results,
        totalMatches: matches.length,
        truncated,
      };
    } catch (error: any) {
      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'glob',
        error: error.message,
      });

      return {
        success: false,
        pattern,
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: error.message,
      };
    }
  }

  private isWithinWorkspace(basePath: string, workspacePath: string): boolean {
    const relative = path.relative(workspacePath, basePath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private isPathAllowedOutsideWorkspace(basePath: string): boolean {
    if (this.workspace.isTemp) return true;
    if (this.workspace.permissions.unrestrictedFileAccess) return true;

    const allowedPaths = this.workspace.permissions.allowedPaths;
    if (!allowedPaths || allowedPaths.length === 0) {
      return false;
    }

    const normalizedPath = path.normalize(basePath);
    return allowedPaths.some(allowed => {
      const normalizedAllowed = path.normalize(allowed);
      return normalizedPath === normalizedAllowed ||
        normalizedPath.startsWith(normalizedAllowed + path.sep);
    });
  }

  /**
   * Find files matching the glob pattern
   */
  private async findMatches(
    basePath: string,
    pattern: string
  ): Promise<Array<{ path: string; size: number; mtime: number }>> {
    const matches: Array<{ path: string; size: number; mtime: number }> = [];
    const regex = this.globToRegex(pattern);

    await this.walkDirectory(basePath, basePath, regex, matches);

    return matches;
  }

  /**
   * Recursively walk directory and collect matches
   */
  private async walkDirectory(
    currentPath: string,
    basePath: string,
    regex: RegExp,
    matches: Array<{ path: string; size: number; mtime: number }>,
    depth: number = 0
  ): Promise<void> {
    // Limit recursion depth to prevent infinite loops
    if (depth > 50) return;

    // Skip common non-code directories
    const dirName = path.basename(currentPath);
    const skipDirs = [
      'node_modules',
      '.git',
      '.svn',
      '.hg',
      'dist',
      'build',
      'coverage',
      '.next',
      '.nuxt',
      '__pycache__',
      '.pytest_cache',
      'venv',
      '.venv',
      'env',
      '.env',
    ];

    if (depth > 0 && skipDirs.includes(dirName)) {
      return;
    }

    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(basePath, fullPath);

        if (entry.isDirectory()) {
          await this.walkDirectory(fullPath, basePath, regex, matches, depth + 1);
        } else if (entry.isFile()) {
          // Test against the pattern
          if (regex.test(relativePath) || regex.test(entry.name)) {
            try {
              const stats = fs.statSync(fullPath);
              matches.push({
                path: fullPath,
                size: stats.size,
                mtime: stats.mtimeMs,
              });
            } catch {
              // Skip files we can't stat
            }
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    // Handle brace expansion {a,b,c}
    const expandedPatterns = this.expandBraces(pattern);

    // Convert each pattern to regex
    const regexParts = expandedPatterns.map((p) => {
      // Use a placeholder so "*" replacement doesn't accidentally rewrite the globstar expansion.
      const GLOBSTAR = '__COWORK_GLOBSTAR__';
      const GLOBSTAR_SLASH = '__COWORK_GLOBSTAR_SLASH__';
      let regex = p
        // Escape special regex characters (except glob chars * and ?)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        // **/ matches zero or more path segments (including none)
        .replace(/\*\*\//g, GLOBSTAR_SLASH)
        // ** matches any path (including /) - must be before single * replacement
        .replace(/\*\*/g, GLOBSTAR)
        // * matches anything except /
        .replace(/\*/g, '[^/]*')
        // ? matches single character except /
        .replace(/\?/g, '[^/]')
        // Expand globstar placeholder after single-star replacement
        .replace(new RegExp(GLOBSTAR_SLASH, 'g'), '(?:.*/)?')
        .replace(new RegExp(GLOBSTAR, 'g'), '.*');

      return regex;
    });

    // Combine patterns with OR
    const combined = regexParts.length > 1 ? `(${regexParts.join('|')})` : regexParts[0];

    return new RegExp(`^${combined}$`, 'i');
  }

  /**
   * Expand brace patterns like {a,b,c}
   */
  private expandBraces(pattern: string): string[] {
    const braceMatch = pattern.match(/\{([^}]+)\}/);

    if (!braceMatch) {
      return [pattern];
    }

    const [fullMatch, options] = braceMatch;
    const optionList = options.split(',');
    const results: string[] = [];

    for (const option of optionList) {
      const expanded = pattern.replace(fullMatch, option.trim());
      // Recursively expand nested braces
      results.push(...this.expandBraces(expanded));
    }

    return results;
  }
}
