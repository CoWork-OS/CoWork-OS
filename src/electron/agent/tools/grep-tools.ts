import * as fs from 'fs';
import * as path from 'path';
import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { LLMTool } from '../llm/types';

/**
 * GrepTools provides powerful regex-based content search
 * Similar to Claude Code's Grep tool (ripgrep-based)
 */
export class GrepTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {}

  /**
   * Get tool definitions for Grep tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'grep',
        description:
          'Powerful regex-based content search across files. ' +
          'Supports full regex syntax (e.g., "async function.*fetch", "class\\s+\\w+"). ' +
          'Use this to find code patterns, function definitions, imports, etc. ' +
          'PREFERRED over search_files for content search.',
        input_schema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Regular expression pattern to search for in file contents',
            },
            path: {
              type: 'string',
              description: 'Directory or file to search in (relative to workspace). Defaults to workspace root.',
            },
            glob: {
              type: 'string',
              description: 'Glob pattern to filter files (e.g., "*.ts", "**/*.{js,jsx}")',
            },
            ignoreCase: {
              type: 'boolean',
              description: 'Case insensitive search (default: false)',
            },
            contextLines: {
              type: 'number',
              description: 'Number of context lines before and after match (default: 0)',
            },
            maxResults: {
              type: 'number',
              description: 'Maximum number of matches to return (default: 50)',
            },
            outputMode: {
              type: 'string',
              enum: ['content', 'files_only', 'count'],
              description:
                'Output mode: "content" shows matching lines (default), "files_only" shows file paths, "count" shows match counts',
            },
          },
          required: ['pattern'],
        },
      },
    ];
  }

  /**
   * Execute grep search
   */
  async grep(input: {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    contextLines?: number;
    maxResults?: number;
    outputMode?: 'content' | 'files_only' | 'count';
  }): Promise<{
    success: boolean;
    pattern: string;
    matches: Array<{
      file: string;
      line?: number;
      content?: string;
      context?: { before: string[]; after: string[] };
      count?: number;
    }>;
    totalMatches: number;
    filesSearched: number;
    truncated: boolean;
    error?: string;
  }> {
    const {
      pattern,
      path: searchPath,
      glob: globPattern,
      ignoreCase = false,
      contextLines = 0,
      maxResults = 50,
      outputMode = 'content',
    } = input;

    this.daemon.logEvent(this.taskId, 'log', {
      message: `Grep search: "${pattern}"${searchPath ? ` in ${searchPath}` : ''}${globPattern ? ` (${globPattern})` : ''}`,
    });

    try {
      // Compile regex
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
      } catch (e: any) {
        throw new Error(`Invalid regex pattern: ${e.message}`);
      }

      const basePath = searchPath
        ? path.resolve(this.workspace.path, searchPath)
        : this.workspace.path;

      // Validate path is within workspace
      if (!basePath.startsWith(this.workspace.path)) {
        throw new Error('Search path must be within workspace');
      }

      if (!fs.existsSync(basePath)) {
        throw new Error(`Path does not exist: ${searchPath || '.'}`);
      }

      // Find files to search
      const files = await this.findFilesToSearch(basePath, globPattern);
      const matches: Array<{
        file: string;
        line?: number;
        content?: string;
        context?: { before: string[]; after: string[] };
        count?: number;
      }> = [];

      let totalMatches = 0;
      let truncated = false;

      // Search each file
      for (const file of files) {
        if (truncated) break;

        try {
          const content = fs.readFileSync(file, 'utf-8');
          const lines = content.split('\n');
          const relativePath = path.relative(this.workspace.path, file);

          if (outputMode === 'count') {
            // Count matches in file
            const fileMatches = (content.match(regex) || []).length;
            if (fileMatches > 0) {
              totalMatches += fileMatches;
              matches.push({
                file: relativePath,
                count: fileMatches,
              });
            }
          } else if (outputMode === 'files_only') {
            // Just check if file has matches
            if (regex.test(content)) {
              totalMatches++;
              matches.push({ file: relativePath });
              if (matches.length >= maxResults) {
                truncated = true;
              }
            }
          } else {
            // Content mode - show matching lines
            for (let i = 0; i < lines.length; i++) {
              regex.lastIndex = 0; // Reset regex state
              if (regex.test(lines[i])) {
                totalMatches++;

                const match: {
                  file: string;
                  line: number;
                  content: string;
                  context?: { before: string[]; after: string[] };
                } = {
                  file: relativePath,
                  line: i + 1,
                  content: lines[i].trim(),
                };

                // Add context lines if requested
                if (contextLines > 0) {
                  const beforeStart = Math.max(0, i - contextLines);
                  const afterEnd = Math.min(lines.length - 1, i + contextLines);

                  match.context = {
                    before: lines.slice(beforeStart, i).map((l) => l.trim()),
                    after: lines.slice(i + 1, afterEnd + 1).map((l) => l.trim()),
                  };
                }

                matches.push(match);

                if (matches.length >= maxResults) {
                  truncated = true;
                  break;
                }
              }
            }
          }
        } catch {
          // Skip files we can't read (binary, permissions, etc.)
        }
      }

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'grep',
        result: {
          pattern,
          matchCount: matches.length,
          totalMatches,
          filesSearched: files.length,
          truncated,
        },
      });

      return {
        success: true,
        pattern,
        matches,
        totalMatches,
        filesSearched: files.length,
        truncated,
      };
    } catch (error: any) {
      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'grep',
        error: error.message,
      });

      return {
        success: false,
        pattern,
        matches: [],
        totalMatches: 0,
        filesSearched: 0,
        truncated: false,
        error: error.message,
      };
    }
  }

  /**
   * Find files to search based on path and glob pattern
   */
  private async findFilesToSearch(basePath: string, globPattern?: string): Promise<string[]> {
    const files: string[] = [];
    const globRegex = globPattern ? this.globToRegex(globPattern) : null;

    await this.walkDirectory(basePath, basePath, files, globRegex);

    return files;
  }

  /**
   * Recursively walk directory and collect text files
   */
  private async walkDirectory(
    currentPath: string,
    basePath: string,
    files: string[],
    globRegex: RegExp | null,
    depth: number = 0
  ): Promise<void> {
    // Limit recursion depth
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
          await this.walkDirectory(fullPath, basePath, files, globRegex, depth + 1);
        } else if (entry.isFile()) {
          // Skip binary and large files
          if (this.isBinaryFile(entry.name)) continue;

          try {
            const stats = fs.statSync(fullPath);
            // Skip files larger than 1MB
            if (stats.size > 1024 * 1024) continue;
          } catch {
            continue;
          }

          // Apply glob filter if specified
          if (globRegex) {
            if (!globRegex.test(relativePath) && !globRegex.test(entry.name)) {
              continue;
            }
          }

          files.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  /**
   * Check if file appears to be binary
   */
  private isBinaryFile(filename: string): boolean {
    const binaryExtensions = [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.bmp',
      '.ico',
      '.webp',
      '.svg',
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.zip',
      '.tar',
      '.gz',
      '.rar',
      '.7z',
      '.exe',
      '.dll',
      '.so',
      '.dylib',
      '.bin',
      '.dat',
      '.db',
      '.sqlite',
      '.mp3',
      '.mp4',
      '.avi',
      '.mov',
      '.mkv',
      '.wav',
      '.flac',
      '.woff',
      '.woff2',
      '.ttf',
      '.eot',
      '.otf',
    ];

    const ext = path.extname(filename).toLowerCase();
    return binaryExtensions.includes(ext);
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    // Handle brace expansion
    const expandedPatterns = this.expandBraces(pattern);

    const regexParts = expandedPatterns.map((p) => {
      let regex = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\*\\\*/g, '.*')
        .replace(/\\\*/g, '[^/]*')
        .replace(/\\\?/g, '[^/]');
      return regex;
    });

    const combined = regexParts.length > 1 ? `(${regexParts.join('|')})` : regexParts[0];
    return new RegExp(`^${combined}$`, 'i');
  }

  /**
   * Expand brace patterns
   */
  private expandBraces(pattern: string): string[] {
    const braceMatch = pattern.match(/\{([^}]+)\}/);
    if (!braceMatch) return [pattern];

    const [fullMatch, options] = braceMatch;
    const optionList = options.split(',');
    const results: string[] = [];

    for (const option of optionList) {
      const expanded = pattern.replace(fullMatch, option.trim());
      results.push(...this.expandBraces(expanded));
    }

    return results;
  }
}
