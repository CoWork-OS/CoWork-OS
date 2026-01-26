import * as fs from 'fs/promises';
import * as path from 'path';
import { shell } from 'electron';
import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { GuardrailManager } from '../../guardrails/guardrail-manager';

// Limits to prevent context overflow
const MAX_FILE_SIZE = 100 * 1024; // 100KB max for file reads
const MAX_DIR_ENTRIES = 100; // Max files to list per directory
const MAX_SEARCH_RESULTS = 50; // Max search results

/**
 * FileTools implements safe file operations within the workspace
 */
export class FileTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {}

  /**
   * Dangerous paths that should never be written to, even with unrestricted access
   */
  private static readonly PROTECTED_PATHS = [
    '/System',
    '/Library',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/var',
    '/private',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];

  /**
   * Check if a path is in a protected system location
   */
  private isProtectedPath(absolutePath: string): boolean {
    const normalizedPath = path.normalize(absolutePath).toLowerCase();
    return FileTools.PROTECTED_PATHS.some(protectedPath =>
      normalizedPath.startsWith(protectedPath.toLowerCase())
    );
  }

  /**
   * Check if path is allowed based on allowedPaths configuration
   */
  private isPathAllowed(absolutePath: string): boolean {
    const allowedPaths = this.workspace.permissions.allowedPaths;
    if (!allowedPaths || allowedPaths.length === 0) {
      return false;
    }

    const normalizedPath = path.normalize(absolutePath);
    return allowedPaths.some(allowed => {
      const normalizedAllowed = path.normalize(allowed);
      // Check if the path starts with or equals an allowed path
      return normalizedPath === normalizedAllowed ||
             normalizedPath.startsWith(normalizedAllowed + path.sep);
    });
  }

  /**
   * Resolve path, supporting both workspace-relative and absolute paths
   * When unrestrictedFileAccess is enabled, allows absolute paths anywhere (except protected locations)
   * When allowedPaths is configured, allows specific paths outside workspace
   */
  private resolvePath(inputPath: string, operation: 'read' | 'write' | 'delete' = 'read'): string {
    const normalizedWorkspace = path.resolve(this.workspace.path);

    // Handle absolute paths
    if (path.isAbsolute(inputPath)) {
      const absolutePath = path.normalize(inputPath);

      // Check if it's inside workspace (always allowed)
      const relativeToWorkspace = path.relative(normalizedWorkspace, absolutePath);
      if (!relativeToWorkspace.startsWith('..') && !path.isAbsolute(relativeToWorkspace)) {
        return absolutePath;
      }

      // Outside workspace - check permissions
      if (this.workspace.permissions.unrestrictedFileAccess) {
        // With unrestricted access, block protected paths for writes
        if (operation !== 'read' && this.isProtectedPath(absolutePath)) {
          throw new Error(`Cannot ${operation} protected system path: ${absolutePath}`);
        }
        return absolutePath;
      }

      // Check if in allowed paths
      if (this.isPathAllowed(absolutePath)) {
        if (operation !== 'read' && this.isProtectedPath(absolutePath)) {
          throw new Error(`Cannot ${operation} protected system path: ${absolutePath}`);
        }
        return absolutePath;
      }

      throw new Error(
        'Path is outside workspace boundary. Enable "Unrestricted File Access" in workspace settings ' +
        'or add specific paths to "Allowed Paths" to access files outside the workspace.'
      );
    }

    // Handle relative paths (relative to workspace)
    const resolved = path.resolve(normalizedWorkspace, inputPath);
    const relative = path.relative(normalizedWorkspace, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      // Path escapes workspace via ../ traversal
      if (this.workspace.permissions.unrestrictedFileAccess) {
        if (operation !== 'read' && this.isProtectedPath(resolved)) {
          throw new Error(`Cannot ${operation} protected system path: ${resolved}`);
        }
        return resolved;
      }

      if (this.isPathAllowed(resolved)) {
        if (operation !== 'read' && this.isProtectedPath(resolved)) {
          throw new Error(`Cannot ${operation} protected system path: ${resolved}`);
        }
        return resolved;
      }

      throw new Error(
        'Path traversal outside workspace is not allowed. Enable "Unrestricted File Access" ' +
        'in workspace settings to access files outside the workspace.'
      );
    }

    return resolved;
  }

  /**
   * Check if operation is allowed based on permissions
   */
  private checkPermission(operation: 'read' | 'write' | 'delete'): void {
    if (operation === 'read' && !this.workspace.permissions.read) {
      throw new Error('Read permission not granted');
    }
    if (operation === 'write' && !this.workspace.permissions.write) {
      throw new Error('Write permission not granted');
    }
    if (operation === 'delete' && !this.workspace.permissions.delete) {
      throw new Error('Delete permission not granted');
    }
  }

  /**
   * Read file contents (with size limit to prevent context overflow)
   */
  async readFile(relativePath: string): Promise<{ content: string; size: number; truncated?: boolean }> {
    // Validate input
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Invalid path: path must be a non-empty string');
    }

    this.checkPermission('read');
    const fullPath = this.resolvePath(relativePath, 'read');

    try {
      const stats = await fs.stat(fullPath);

      // Check file size before reading
      if (stats.size > MAX_FILE_SIZE) {
        // Read only the first portion of large files
        const fileHandle = await fs.open(fullPath, 'r');
        try {
          const buffer = Buffer.alloc(MAX_FILE_SIZE);
          await fileHandle.read(buffer, 0, MAX_FILE_SIZE, 0);

          const content = buffer.toString('utf-8');
          return {
            content: content + `\n\n[... File truncated. Showing first ${Math.round(MAX_FILE_SIZE / 1024)}KB of ${Math.round(stats.size / 1024)}KB ...]`,
            size: stats.size,
            truncated: true,
          };
        } finally {
          await fileHandle.close();
        }
      }

      const content = await fs.readFile(fullPath, 'utf-8');
      return {
        content,
        size: stats.size,
      };
    } catch (error: any) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  /**
   * Write file contents
   */
  async writeFile(relativePath: string, content: string): Promise<{ success: boolean; path: string }> {
    // Validate inputs before proceeding
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Invalid path: path must be a non-empty string');
    }
    if (content === undefined || content === null) {
      throw new Error('Invalid content: content parameter is required but was not provided');
    }
    if (typeof content !== 'string') {
      throw new Error(`Invalid content: expected string but received ${typeof content}`);
    }

    this.checkPermission('write');
    const fullPath = this.resolvePath(relativePath, 'write');

    // Check file size against guardrail limits
    const contentSizeBytes = Buffer.byteLength(content, 'utf-8');
    const sizeCheck = GuardrailManager.isFileSizeExceeded(contentSizeBytes);
    if (sizeCheck.exceeded) {
      throw new Error(
        `File size limit exceeded: ${sizeCheck.sizeMB.toFixed(2)}MB exceeds limit of ${sizeCheck.limitMB}MB.\n` +
        `You can adjust this limit in Settings > Guardrails.`
      );
    }

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // Write file
      await fs.writeFile(fullPath, content, 'utf-8');

      // Log artifact
      this.daemon.logEvent(this.taskId, 'file_created', {
        path: relativePath,
        size: content.length,
      });

      return {
        success: true,
        path: relativePath,
      };
    } catch (error: any) {
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }

  /**
   * List directory contents (limited to prevent context overflow)
   */
  async listDirectory(relativePath: string = '.'): Promise<{
    files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
    totalCount: number;
    truncated?: boolean;
  }> {
    // Validate and normalize input (use default if null/undefined)
    const pathToUse = (relativePath && typeof relativePath === 'string') ? relativePath : '.';

    this.checkPermission('read');
    const fullPath = this.resolvePath(pathToUse, 'read');

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const totalCount = entries.length;

      // Limit entries to prevent large responses
      const limitedEntries = entries.slice(0, MAX_DIR_ENTRIES);

      const files = await Promise.all(
        limitedEntries.map(async entry => {
          const entryPath = path.join(fullPath, entry.name);
          try {
            const stats = await fs.stat(entryPath);
            return {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' as const : 'file' as const,
              size: stats.size,
            };
          } catch {
            return {
              name: entry.name,
              type: 'file' as const,
              size: 0,
            };
          }
        })
      );

      return {
        files,
        totalCount,
        truncated: totalCount > MAX_DIR_ENTRIES,
      };
    } catch (error: any) {
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }

  /**
   * Rename or move file
   */
  async renameFile(oldPath: string, newPath: string): Promise<{ success: boolean }> {
    // Validate inputs
    if (!oldPath || typeof oldPath !== 'string') {
      throw new Error('Invalid oldPath: must be a non-empty string');
    }
    if (!newPath || typeof newPath !== 'string') {
      throw new Error('Invalid newPath: must be a non-empty string');
    }

    this.checkPermission('write');
    const oldFullPath = this.resolvePath(oldPath, 'write');
    const newFullPath = this.resolvePath(newPath, 'write');

    try {
      // Ensure target directory exists
      await fs.mkdir(path.dirname(newFullPath), { recursive: true });

      await fs.rename(oldFullPath, newFullPath);

      this.daemon.logEvent(this.taskId, 'file_modified', {
        action: 'rename',
        from: oldPath,
        to: newPath,
      });

      return { success: true };
    } catch (error: any) {
      throw new Error(`Failed to rename file: ${error.message}`);
    }
  }

  /**
   * Delete file (requires approval)
   * Uses shell.trashItem() for protected locations like /Applications
   * Note: We don't check workspace.permissions.delete here because
   * delete operations always require explicit user approval via requestApproval()
   */
  async deleteFile(relativePath: string): Promise<{ success: boolean; movedToTrash?: boolean }> {
    // Validate input
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Invalid path: path must be a non-empty string');
    }

    const fullPath = this.resolvePath(relativePath, 'delete');

    // Request user approval
    const approved = await this.daemon.requestApproval(
      this.taskId,
      'delete_file',
      `Delete file: ${relativePath}`,
      { path: relativePath }
    );

    if (!approved) {
      throw new Error('User denied file deletion');
    }

    try {
      // For .app bundles on macOS, use shell.trashItem directly (safer and expected behavior)
      if (fullPath.endsWith('.app')) {
        await shell.trashItem(fullPath);

        this.daemon.logEvent(this.taskId, 'file_deleted', {
          path: relativePath,
          movedToTrash: true,
        });

        return { success: true, movedToTrash: true };
      }

      // For other files/directories, try direct deletion
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        // Use force: true to handle read-only files and special cases
        await fs.rm(fullPath, { recursive: true, force: true });
      } else {
        await fs.unlink(fullPath);
      }

      this.daemon.logEvent(this.taskId, 'file_deleted', {
        path: relativePath,
      });

      return { success: true };
    } catch (error: any) {
      // If deletion fails, try moving to Trash as fallback
      // This handles EPERM, EACCES, ENOTEMPTY and other filesystem errors
      if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTEMPTY' || error.code === 'EBUSY') {
        try {
          await shell.trashItem(fullPath);

          this.daemon.logEvent(this.taskId, 'file_deleted', {
            path: relativePath,
            movedToTrash: true,
          });

          return { success: true, movedToTrash: true };
        } catch (trashError: any) {
          throw new Error(`Failed to delete file: ${error.code}. Could not move to Trash: ${trashError.message}`);
        }
      }
      throw new Error(`Failed to delete file: ${error.message}`);
    }
  }

  /**
   * Create directory
   */
  async createDirectory(relativePath: string): Promise<{ success: boolean }> {
    // Validate input
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Invalid path: path must be a non-empty string');
    }

    this.checkPermission('write');
    const fullPath = this.resolvePath(relativePath, 'write');

    try {
      await fs.mkdir(fullPath, { recursive: true });

      this.daemon.logEvent(this.taskId, 'file_created', {
        path: relativePath,
        type: 'directory',
      });

      return { success: true };
    } catch (error: any) {
      throw new Error(`Failed to create directory: ${error.message}`);
    }
  }

  /**
   * Search files by name or content (limited to prevent context overflow)
   */
  async searchFiles(
    query: string,
    relativePath: string = '.'
  ): Promise<{
    matches: Array<{ path: string; type: 'filename' | 'content' }>;
    totalFound: number;
    truncated?: boolean;
  }> {
    // Validate input
    if (!query || typeof query !== 'string') {
      throw new Error('Invalid query: query must be a non-empty string');
    }

    this.checkPermission('read');
    const fullPath = this.resolvePath(relativePath, 'read');
    const matches: Array<{ path: string; type: 'filename' | 'content' }> = [];
    let filesSearched = 0;
    const maxFilesToSearch = 500; // Limit files to search for performance

    const searchRecursive = async (dir: string) => {
      if (matches.length >= MAX_SEARCH_RESULTS || filesSearched >= maxFilesToSearch) {
        return;
      }

      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // Skip directories we can't read
      }

      for (const entry of entries) {
        if (matches.length >= MAX_SEARCH_RESULTS || filesSearched >= maxFilesToSearch) {
          break;
        }

        const entryPath = path.join(dir, entry.name);
        const relPath = path.relative(this.workspace.path, entryPath);

        // Skip hidden files/directories and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }

        // Check filename match
        if (entry.name.toLowerCase().includes(query.toLowerCase())) {
          matches.push({
            path: relPath,
            type: 'filename',
          });
        }

        // Search content for small files only
        if (entry.isFile()) {
          filesSearched++;
          try {
            const stats = await fs.stat(entryPath);
            // Only search small text files
            if (stats.size < 50 * 1024) {
              const content = await fs.readFile(entryPath, 'utf-8');
              if (content.toLowerCase().includes(query.toLowerCase())) {
                if (!matches.some(m => m.path === relPath)) {
                  matches.push({
                    path: relPath,
                    type: 'content',
                  });
                }
              }
            }
          } catch {
            // Skip binary files or files that can't be read
          }
        } else if (entry.isDirectory()) {
          await searchRecursive(entryPath);
        }
      }
    };

    try {
      await searchRecursive(fullPath);
      return {
        matches: matches.slice(0, MAX_SEARCH_RESULTS),
        totalFound: matches.length,
        truncated: matches.length >= MAX_SEARCH_RESULTS,
      };
    } catch (error: any) {
      throw new Error(`Search failed: ${error.message}`);
    }
  }
}
